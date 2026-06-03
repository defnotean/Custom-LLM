import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";
import { cosineSimilarity } from "../utils/vectorMath";
import type {
  MemoryRecord,
  MemorySearchFilter,
  MemorySearchHit,
  MemoryStore,
  MemoryUpsertInput,
} from "./MemoryStore";

/**
 * Process-local memory store. Non-persistent by design — used in tests and
 * as the graceful fallback when the configured store fails to initialize
 * (the bot keeps working, memory just doesn't survive restarts).
 */
export class InMemoryMemoryStore implements MemoryStore {
  readonly name = "memory (in-process, non-persistent)";
  private readonly records = new Map<string, { record: MemoryRecord; embedding: number[] }>();

  async init(): Promise<void> {
    // Nothing to prepare.
  }

  async upsert(input: MemoryUpsertInput): Promise<MemoryRecord> {
    const record: MemoryRecord = {
      id: newId(),
      scope: input.scope,
      userId: input.userId,
      guildId: input.guildId,
      channelId: input.channelId,
      content: input.content,
      summary: input.summary ?? null,
      importance: input.importance,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    };
    this.records.set(record.id, { record, embedding: input.embedding });
    return record;
  }

  async search(
    embedding: number[],
    filter: MemorySearchFilter,
    topK: number,
  ): Promise<MemorySearchHit[]> {
    const hits: MemorySearchHit[] = [];
    for (const { record, embedding: vec } of this.records.values()) {
      if (!matchesScope(record, filter)) continue;
      hits.push({ record, score: cosineSimilarity(embedding, vec) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    return this.records.get(id)?.record ?? null;
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async count(): Promise<number> {
    return this.records.size;
  }
}

export function matchesScope(record: MemoryRecord, filter: MemorySearchFilter): boolean {
  switch (record.scope) {
    case "USER":
      return filter.userId !== null && record.userId === filter.userId;
    case "GUILD":
      return filter.guildId !== null && record.guildId === filter.guildId;
    case "CHANNEL":
      return record.channelId === filter.channelId;
    case "GLOBAL":
      return true;
  }
}
