import type { PrismaClient, MemoryScope } from "@prisma/client";
import type { Logger } from "pino";
import { AppError, toErrorMessage } from "../utils/errors";
import type { JsonValue } from "../types/common";
import type {
  MemoryRecord,
  MemorySearchFilter,
  MemorySearchHit,
  MemoryStore,
  MemoryUpsertInput,
} from "./MemoryStore";

/**
 * Postgres + pgvector store. Memory rows live in the Prisma `Memory` model;
 * embeddings live in a raw `memory_vectors` table (Prisma has no native
 * vector type) created here at init — idempotent, and isolated from Prisma
 * migrations so a missing pgvector extension degrades cleanly instead of
 * blocking `migrate deploy` (the service falls back to InMemoryMemoryStore).
 *
 * Requires: PostgreSQL with the `vector` extension available (the bundled
 * docker-compose uses the pgvector/pgvector image).
 */
export class PgVectorMemoryStore implements MemoryStore {
  readonly name = "pgvector";
  private ready = false;
  private dims: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    options: { dims: number },
  ) {
    this.dims = options.dims;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.dims <= 0) {
      throw new AppError("PGVECTOR_DIMS", "embedding dimensions unknown — embed once before init");
    }
    try {
      await this.prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
      await this.prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS memory_vectors (
           memory_id text PRIMARY KEY REFERENCES "Memory"(id) ON DELETE CASCADE,
           embedding vector(${Math.floor(this.dims)}) NOT NULL
         )`,
      );
      await this.prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS memory_vectors_embedding_idx
           ON memory_vectors USING hnsw (embedding vector_cosine_ops)`,
      );
      this.ready = true;
      this.logger.info({ dims: this.dims }, "pgvector memory store ready");
    } catch (err) {
      throw new AppError(
        "PGVECTOR_INIT",
        `pgvector init failed (is the extension installed?): ${toErrorMessage(err)}`,
        { cause: err },
      );
    }
  }

  async upsert(input: MemoryUpsertInput): Promise<MemoryRecord> {
    await this.init();
    const row = await this.prisma.memory.create({
      data: {
        scope: input.scope as MemoryScope,
        userId: input.userId,
        guildId: input.guildId,
        channelId: input.channelId,
        content: input.content,
        summary: input.summary ?? null,
        importance: input.importance,
        metadataJson: (input.metadata ?? {}) as object,
      },
    });
    const literal = toVectorLiteral(input.embedding);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO memory_vectors (memory_id, embedding) VALUES ($1, $2::vector)
       ON CONFLICT (memory_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      row.id,
      literal,
    );
    // vectorId doubles as "vector persisted" marker for pgvector.
    await this.prisma.memory.update({ where: { id: row.id }, data: { vectorId: row.id } });
    return toRecord(row);
  }

  async search(
    embedding: number[],
    filter: MemorySearchFilter,
    topK: number,
  ): Promise<MemorySearchHit[]> {
    await this.init();
    const literal = toVectorLiteral(embedding);
    type Row = {
      id: string;
      scope: string;
      userId: string | null;
      guildId: string | null;
      channelId: string | null;
      content: string;
      summary: string | null;
      importance: number;
      metadataJson: unknown;
      createdAt: Date;
      score: number;
    };
    const rows = await this.prisma.$queryRawUnsafe<Row[]>(
      `SELECT m.id, m.scope, m."userId", m."guildId", m."channelId", m.content,
              m.summary, m.importance, m."metadataJson", m."createdAt",
              1 - (v.embedding <=> $1::vector) AS score
         FROM memory_vectors v
         JOIN "Memory" m ON m.id = v.memory_id
        WHERE (m.scope = 'USER'    AND $2::text IS NOT NULL AND m."userId" = $2)
           OR (m.scope = 'GUILD'   AND $3::text IS NOT NULL AND m."guildId" = $3)
           OR (m.scope = 'CHANNEL' AND m."channelId" = $4)
           OR (m.scope = 'GLOBAL')
        ORDER BY v.embedding <=> $1::vector
        LIMIT $5`,
      literal,
      filter.userId,
      filter.guildId,
      filter.channelId,
      topK,
    );
    return rows.map((row) => ({
      record: toRecord({ ...row, createdAt: row.createdAt }),
      score: Number(row.score),
    }));
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    const row = await this.prisma.memory.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    try {
      // memory_vectors row cascades.
      await this.prisma.memory.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async count(): Promise<number> {
    return this.prisma.memory.count();
  }
}

function toVectorLiteral(embedding: number[]): string {
  // Numbers only — safe to interpolate into the vector literal.
  return `[${embedding.map((n) => (Number.isFinite(n) ? n : 0)).join(",")}]`;
}

function toRecord(row: {
  id: string;
  scope: string;
  userId: string | null;
  guildId: string | null;
  channelId: string | null;
  content: string;
  summary: string | null;
  importance: number;
  metadataJson: unknown;
  createdAt: Date;
}): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope as MemoryRecord["scope"],
    userId: row.userId,
    guildId: row.guildId,
    channelId: row.channelId,
    content: row.content,
    summary: row.summary,
    importance: row.importance,
    metadata: (row.metadataJson ?? {}) as JsonValue,
    createdAt: row.createdAt.toISOString(),
  };
}
