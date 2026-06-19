import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { toErrorMessage } from "../utils/errors";
import { HashingEmbeddingProvider } from "./EmbeddingProvider";
import { MemoryService } from "./MemoryService";
import { PgVectorMemoryStore } from "./PgVectorMemoryStore";

export type PgVectorMemorySmokeStatus = "pass" | "fail";

export interface PgVectorMemorySmokeCheck {
  id: string;
  status: PgVectorMemorySmokeStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface PgVectorMemorySmokeReport {
  status: PgVectorMemorySmokeStatus;
  generatedAt: string;
  store: "pgvector";
  dims: number;
  checks: PgVectorMemorySmokeCheck[];
}

export interface PgVectorMemorySmokeOptions {
  prisma: PrismaClient;
  logger: Logger;
  dims?: number;
}

const SMOKE_CTX = { userId: "pgvector-smoke-user-1", guildId: "pgvector-smoke-guild", channelId: "pgvector-smoke-channel" };
const OTHER_CTX = {
  userId: "pgvector-smoke-user-2",
  guildId: "pgvector-smoke-guild",
  channelId: "pgvector-smoke-channel",
};

export async function runPgVectorMemorySmoke(options: PgVectorMemorySmokeOptions): Promise<PgVectorMemorySmokeReport> {
  const dims = options.dims ?? 64;
  const store = new PgVectorMemoryStore(options.prisma, options.logger, { dims });
  const service = new MemoryService(store, new HashingEmbeddingProvider(dims), options.logger);
  const checks: PgVectorMemorySmokeCheck[] = [];
  const createdMemoryIds = new Set<string>();
  let memoryId: string | null = null;

  await recordCheck(checks, "pgvector-store-init", async () => {
    await store.init();
    return "pgvector extension, memory_vectors table, and HNSW index initialized";
  });

  await recordCheck(checks, "pgvector-memory-write-search", async () => {
    const remembered = await service.remember({
      content: "Irene pgvector smoke alpha memory should be recalled for this user",
      scope: "USER",
      userId: SMOKE_CTX.userId,
      guildId: SMOKE_CTX.guildId,
      channelId: SMOKE_CTX.channelId,
      explicit: true,
    });
    if (!remembered.stored || !remembered.id) throw new Error(`memory was not stored: ${remembered.reason}`);
    memoryId = remembered.id;
    createdMemoryIds.add(remembered.id);

    const hits = await service.search("pgvector smoke alpha memory recalled", SMOKE_CTX, 5);
    if (!hits.some((hit) => hit.id === remembered.id && hit.content.includes("alpha memory"))) {
      throw new Error("stored memory was not returned by scoped pgvector search");
    }
    return "pgvector stored and recalled a USER-scoped memory";
  });

  await recordCheck(checks, "pgvector-scope-isolation", async () => {
    const other = await service.remember({
      content: "Irene pgvector smoke beta private memory belongs to another user",
      scope: "USER",
      userId: OTHER_CTX.userId,
      guildId: OTHER_CTX.guildId,
      channelId: OTHER_CTX.channelId,
      explicit: true,
    });
    if (!other.stored || !other.id) throw new Error(`other-user memory was not stored: ${other.reason}`);
    createdMemoryIds.add(other.id);

    const hits = await service.search("pgvector smoke beta private memory", SMOKE_CTX, 10);
    if (hits.some((hit) => hit.id === other.id || hit.content.includes("beta private"))) {
      throw new Error("pgvector search leaked another user's USER memory");
    }
    return "pgvector scoped search did not leak another user's USER memory";
  });

  await recordCheck(checks, "pgvector-lookup-delete", async () => {
    if (!memoryId) throw new Error("no stored memory id available");
    const found = await store.getById(memoryId);
    if (!found || found.id !== memoryId || !found.content.includes("alpha memory")) {
      throw new Error("pgvector lookup did not restore the stored memory row");
    }
    const deleted = await store.delete(memoryId);
    if (!deleted) throw new Error("pgvector delete returned false");
    createdMemoryIds.delete(memoryId);
    const afterDelete = await store.getById(memoryId);
    if (afterDelete !== null) throw new Error("deleted pgvector memory was still retrievable by id");
    return "pgvector lookup and delete succeeded";
  });

  await recordCheck(checks, "pgvector-smoke-cleanup", async () => {
    const remaining = [...createdMemoryIds];
    for (const id of remaining) {
      const deleted = await store.delete(id);
      if (!deleted) throw new Error(`failed to delete smoke memory ${id}`);
      createdMemoryIds.delete(id);
    }
    return `Deleted ${remaining.length} remaining pgvector smoke memories`;
  });

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    store: "pgvector",
    dims,
    checks,
  };
}

async function recordCheck(
  checks: PgVectorMemorySmokeCheck[],
  id: string,
  run: () => Promise<string>,
): Promise<void> {
  try {
    checks.push({ id, status: "pass", summary: await run() });
  } catch (err) {
    checks.push({ id, status: "fail", summary: toErrorMessage(err) });
  }
}
