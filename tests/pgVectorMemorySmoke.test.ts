import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { runPgVectorMemorySmoke } from "../src/memory/PgVectorMemorySmoke";
import { testLogger } from "./helpers";

describe("PgVectorMemorySmoke", () => {
  it("passes init, scoped memory search, lookup, delete, and cleanup checks", async () => {
    const fake = new FakePgVectorPrisma();

    const report = await runPgVectorMemorySmoke({
      prisma: fake as unknown as PrismaClient,
      dims: 32,
      logger: testLogger,
    });

    expect(report.status).toBe("pass");
    expect(report.checks.map((check) => check.id)).toEqual([
      "pgvector-store-init",
      "pgvector-memory-write-search",
      "pgvector-scope-isolation",
      "pgvector-lookup-delete",
      "pgvector-smoke-cleanup",
    ]);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(fake.rawStatements.some((statement) => statement.includes("CREATE EXTENSION"))).toBe(true);
    expect(fake.rawStatements.some((statement) => statement.includes("CREATE TABLE"))).toBe(true);
    expect(fake.rawStatements.some((statement) => statement.includes("CREATE INDEX"))).toBe(true);
    expect(fake.memoryCount()).toBe(0);
    expect(fake.vectorCount()).toBe(0);
  });
});

interface MemoryRow {
  id: string;
  scope: string;
  userId: string | null;
  guildId: string | null;
  channelId: string | null;
  content: string;
  summary: string | null;
  importance: number;
  metadataJson: unknown;
  vectorId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class FakePgVectorPrisma {
  readonly rawStatements: string[] = [];
  private nextId = 1;
  private readonly rows = new Map<string, MemoryRow>();
  private readonly vectors = new Map<string, number[]>();

  readonly memory = {
    create: async ({ data }: { data: Partial<MemoryRow> }) => {
      const now = new Date("2026-06-19T00:00:00.000Z");
      const row: MemoryRow = {
        id: `memory-${this.nextId++}`,
        scope: String(data.scope),
        userId: data.userId ?? null,
        guildId: data.guildId ?? null,
        channelId: data.channelId ?? null,
        content: String(data.content ?? ""),
        summary: (data.summary as string | null | undefined) ?? null,
        importance: Number(data.importance ?? 1),
        metadataJson: data.metadataJson ?? {},
        vectorId: null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(row.id, row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<MemoryRow> }) => {
      const row = this.row(where.id);
      Object.assign(row, data, { updatedAt: new Date("2026-06-19T00:00:01.000Z") });
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.rows.get(where.id) ?? null,
    delete: async ({ where }: { where: { id: string } }) => {
      const row = this.row(where.id);
      this.rows.delete(where.id);
      this.vectors.delete(where.id);
      return row;
    },
    count: async () => this.rows.size,
  };

  async $connect(): Promise<void> {
    return undefined;
  }

  async $disconnect(): Promise<void> {
    return undefined;
  }

  async $executeRawUnsafe(query: string, ...params: unknown[]): Promise<number> {
    this.rawStatements.push(query);
    if (query.includes("INSERT INTO memory_vectors")) {
      const [memoryId, vectorLiteral] = params;
      if (typeof memoryId !== "string" || typeof vectorLiteral !== "string") {
        throw new Error("bad vector insert params");
      }
      this.vectors.set(memoryId, parseVectorLiteral(vectorLiteral));
    }
    return 1;
  }

  async $queryRawUnsafe<T>(
    _query: string,
    vectorLiteral: string,
    userId: string | null,
    guildId: string | null,
    channelId: string | null,
    topK: number,
  ): Promise<T> {
    const queryVector = parseVectorLiteral(vectorLiteral);
    const rows = [...this.vectors.entries()]
      .flatMap(([id, vector]) => {
        const row = this.rows.get(id);
        if (!row || !matchesScope(row, { userId, guildId, channelId })) return [];
        return [{ ...row, score: cosine(vector, queryVector) }];
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
    return rows as T;
  }

  memoryCount(): number {
    return this.rows.size;
  }

  vectorCount(): number {
    return this.vectors.size;
  }

  private row(id: string): MemoryRow {
    const row = this.rows.get(id);
    if (!row) throw new Error(`missing row ${id}`);
    return row;
  }
}

function matchesScope(
  row: MemoryRow,
  filter: { userId: string | null; guildId: string | null; channelId: string | null },
): boolean {
  if (row.scope === "USER" && filter.userId !== null && row.userId === filter.userId) return true;
  if (row.scope === "GUILD" && filter.guildId !== null && row.guildId === filter.guildId) return true;
  if (row.scope === "CHANNEL" && row.channelId === filter.channelId) return true;
  return row.scope === "GLOBAL";
}

function parseVectorLiteral(literal: string): number[] {
  const trimmed = literal.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw new Error(`bad vector literal: ${literal}`);
  return trimmed
    .slice(1, -1)
    .split(",")
    .filter(Boolean)
    .map((item) => Number(item));
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}
