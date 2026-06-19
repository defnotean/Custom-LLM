import type { JsonValue } from "../types/common";
import type { MemoryScopeName } from "../types/ai";

/**
 * Vector-backed memory persistence interface. Implementations:
 *  - PgVectorMemoryStore  — Postgres + pgvector (Memory rows via Prisma,
 *    vectors in a raw `memory_vectors` table). Covered by
 *    `npm run check:pgvector-memory -- --dims <embedding-dimensions>`.
 *  - QdrantMemoryStore    — Qdrant REST (Memory rows via Prisma when a DB is
 *    present, vectors+payload in Qdrant). Implemented against the REST API;
 *    covered by fake-fetch tests and `npm run check:qdrant-memory`.
 *  - InMemoryMemoryStore  — process-local, non-persistent. Test/dev fallback.
 *
 * MemoryService owns embedding + policy; stores only persist and search.
 */

export interface MemoryRecord {
  id: string;
  scope: MemoryScopeName;
  userId: string | null;
  guildId: string | null;
  channelId: string | null;
  content: string;
  summary: string | null;
  importance: number;
  metadata: JsonValue;
  createdAt: string;
}

export interface MemorySearchFilter {
  userId: string | null;
  guildId: string | null;
  channelId: string | null;
}

export interface MemorySearchHit {
  record: MemoryRecord;
  score: number;
}

export interface MemoryUpsertInput {
  scope: MemoryScopeName;
  userId: string | null;
  guildId: string | null;
  channelId: string | null;
  content: string;
  summary?: string | null;
  importance: number;
  metadata?: JsonValue;
  embedding: number[];
}

export interface MemoryStore {
  readonly name: string;
  /** Lazily prepare backing storage (extension/table/collection). */
  init(): Promise<void>;
  upsert(input: MemoryUpsertInput): Promise<MemoryRecord>;
  /**
   * Scope-aware similarity search: matches the user's USER memories, the
   * guild's GUILD memories, the channel's CHANNEL memories, and GLOBAL —
   * never another user's or another guild's memories.
   */
  search(embedding: number[], filter: MemorySearchFilter, topK: number): Promise<MemorySearchHit[]>;
  getById(id: string): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
}
