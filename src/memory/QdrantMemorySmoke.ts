import type { Logger } from "pino";
import { toErrorMessage } from "../utils/errors";
import { HashingEmbeddingProvider } from "./EmbeddingProvider";
import { MemoryService } from "./MemoryService";
import { QdrantMemoryStore } from "./QdrantMemoryStore";

export type QdrantMemorySmokeStatus = "pass" | "fail";

export interface QdrantMemorySmokeCheck {
  id: string;
  status: QdrantMemorySmokeStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface QdrantMemorySmokeReport {
  status: QdrantMemorySmokeStatus;
  generatedAt: string;
  url: string;
  collection: string;
  checks: QdrantMemorySmokeCheck[];
}

export interface QdrantMemorySmokeOptions {
  url: string;
  collection: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  dims?: number;
}

const SMOKE_CTX = { userId: "qdrant-smoke-user-1", guildId: "qdrant-smoke-guild", channelId: "qdrant-smoke-channel" };
const OTHER_CTX = {
  userId: "qdrant-smoke-user-2",
  guildId: "qdrant-smoke-guild",
  channelId: "qdrant-smoke-channel",
};

export async function runQdrantMemorySmoke(options: QdrantMemorySmokeOptions): Promise<QdrantMemorySmokeReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const store = new QdrantMemoryStore({
    url: options.url,
    collection: options.collection,
    dims: options.dims ?? 64,
    prisma: null,
    logger: options.logger,
    fetchImpl,
  });
  const service = new MemoryService(store, new HashingEmbeddingProvider(options.dims ?? 64), options.logger);
  const checks: QdrantMemorySmokeCheck[] = [];
  let memoryId: string | null = null;

  await recordCheck(checks, "qdrant-collection-init", async () => {
    await store.init();
    return "Qdrant collection initialized with the requested vector size";
  });

  await recordCheck(checks, "qdrant-memory-write-search", async () => {
    const remembered = await service.remember({
      content: "Irene Qdrant smoke alpha memory should be recalled for this user",
      scope: "USER",
      userId: SMOKE_CTX.userId,
      guildId: SMOKE_CTX.guildId,
      channelId: SMOKE_CTX.channelId,
      explicit: true,
    });
    if (!remembered.stored || !remembered.id) throw new Error(`memory was not stored: ${remembered.reason}`);
    memoryId = remembered.id;

    const hits = await service.search("Qdrant smoke alpha memory recalled", SMOKE_CTX, 5);
    if (!hits.some((hit) => hit.id === remembered.id && hit.content.includes("alpha memory"))) {
      throw new Error("stored memory was not returned by scoped Qdrant search");
    }
    return "Qdrant stored and recalled a USER-scoped memory";
  });

  await recordCheck(checks, "qdrant-scope-isolation", async () => {
    const other = await service.remember({
      content: "Irene Qdrant smoke beta private memory belongs to another user",
      scope: "USER",
      userId: OTHER_CTX.userId,
      guildId: OTHER_CTX.guildId,
      channelId: OTHER_CTX.channelId,
      explicit: true,
    });
    if (!other.stored || !other.id) throw new Error(`other-user memory was not stored: ${other.reason}`);

    const hits = await service.search("Qdrant smoke beta private memory", SMOKE_CTX, 10);
    if (hits.some((hit) => hit.id === other.id || hit.content.includes("beta private"))) {
      throw new Error("Qdrant search leaked another user's USER memory");
    }
    return "Qdrant scoped search did not leak another user's USER memory";
  });

  await recordCheck(checks, "qdrant-point-lookup-delete", async () => {
    if (!memoryId) throw new Error("no stored memory id available");
    const found = await store.getById(memoryId);
    if (!found || found.id !== memoryId || !found.content.includes("alpha memory")) {
      throw new Error("Qdrant point lookup did not restore the stored memory payload");
    }
    const deleted = await store.delete(memoryId);
    if (!deleted) throw new Error("Qdrant point delete returned false");
    const afterDelete = await store.getById(memoryId);
    if (afterDelete !== null) throw new Error("deleted Qdrant memory was still retrievable by id");
    return "Qdrant point lookup and delete succeeded";
  });

  await recordCheck(checks, "qdrant-smoke-cleanup", async () => {
    await deleteQdrantCollection(fetchImpl, options.url, options.collection);
    return "Deleted isolated Qdrant smoke collection";
  });

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    url: options.url,
    collection: options.collection,
    checks,
  };
}

async function recordCheck(
  checks: QdrantMemorySmokeCheck[],
  id: string,
  run: () => Promise<string>,
): Promise<void> {
  try {
    checks.push({ id, status: "pass", summary: await run() });
  } catch (err) {
    checks.push({ id, status: "fail", summary: toErrorMessage(err) });
  }
}

async function deleteQdrantCollection(fetchImpl: typeof fetch, baseUrl: string, collection: string): Promise<void> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/collections/${collection}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`Qdrant collection cleanup failed (${res.status}): ${body.slice(0, 300)}`);
  }
}
