import { z } from "zod";
import type { PrismaClient, MemoryScope } from "@prisma/client";
import type { Logger } from "pino";
import { AppError, toErrorMessage } from "../utils/errors";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";
import type { JsonValue } from "../types/common";
import type {
  MemoryRecord,
  MemorySearchFilter,
  MemorySearchHit,
  MemoryStore,
  MemoryUpsertInput,
} from "./MemoryStore";

/**
 * Qdrant-backed store (REST API, no SDK dependency).
 *
 * STATUS: implemented against the documented REST endpoints (collection
 * ensure, point upsert, filtered search, lookup, delete) with fake-fetch
 * coverage and a live smoke command. Treat as beta until the smoke has passed
 * against your deployed Qdrant. Relational copies of memories are kept in
 * Postgres when available so Qdrant remains a rebuildable index rather than
 * the source of truth.
 */
export class QdrantMemoryStore implements MemoryStore {
  readonly name = "qdrant";
  private ready = false;

  constructor(
    private readonly options: {
      url: string;
      collection: string;
      dims: number;
      prisma: PrismaClient | null;
      logger: Logger;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.options.url.replace(/\/+$/, "")}${path}`;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.options.dims <= 0) {
      throw new AppError("QDRANT_DIMS", "embedding dimensions unknown — embed once before init");
    }
    const res = await this.request("PUT", `/collections/${this.options.collection}`, {
      vectors: { size: this.options.dims, distance: "Cosine" },
    });
    // 409/already-exists is fine.
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => "");
      if (!body.includes("already exists")) {
        throw new AppError("QDRANT_INIT", `Qdrant collection setup failed (${res.status}): ${body.slice(0, 300)}`);
      }
    }
    this.ready = true;
    this.options.logger.info(
      { collection: this.options.collection, dims: this.options.dims },
      "qdrant memory store ready",
    );
  }

  async upsert(input: MemoryUpsertInput): Promise<MemoryRecord> {
    await this.init();
    const vectorId = newId();

    // Relational copy first (when a DB is available) so Qdrant is an index,
    // not the only home of user data.
    let record: MemoryRecord;
    if (this.options.prisma) {
      const row = await this.options.prisma.memory.create({
        data: {
          scope: input.scope as MemoryScope,
          userId: input.userId,
          guildId: input.guildId,
          channelId: input.channelId,
          content: input.content,
          summary: input.summary ?? null,
          importance: input.importance,
          metadataJson: (input.metadata ?? {}) as object,
          vectorId,
        },
      });
      record = {
        id: row.id,
        scope: input.scope,
        userId: row.userId,
        guildId: row.guildId,
        channelId: row.channelId,
        content: row.content,
        summary: row.summary,
        importance: row.importance,
        metadata: (row.metadataJson ?? {}) as JsonValue,
        createdAt: row.createdAt.toISOString(),
      };
    } else {
      record = {
        id: vectorId,
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
    }

    const res = await this.request("PUT", `/collections/${this.options.collection}/points?wait=true`, {
      points: [
        {
          id: vectorId,
          vector: input.embedding,
          payload: {
            memoryId: record.id,
            scope: record.scope,
            userId: record.userId,
            guildId: record.guildId,
            channelId: record.channelId,
            content: record.content,
            importance: record.importance,
            createdAt: record.createdAt,
          },
        },
      ],
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppError("QDRANT_UPSERT", `Qdrant upsert failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return record;
  }

  async search(
    embedding: number[],
    filter: MemorySearchFilter,
    topK: number,
  ): Promise<MemorySearchHit[]> {
    await this.init();
    // OR of scope-correct conditions: USER(=userId) / GUILD(=guildId) /
    // CHANNEL(=channelId) / GLOBAL.
    const should: unknown[] = [{ key: "scope", match: { value: "GLOBAL" } }];
    if (filter.userId) {
      should.push({
        must: [
          { key: "scope", match: { value: "USER" } },
          { key: "userId", match: { value: filter.userId } },
        ],
      });
    }
    if (filter.guildId) {
      should.push({
        must: [
          { key: "scope", match: { value: "GUILD" } },
          { key: "guildId", match: { value: filter.guildId } },
        ],
      });
    }
    should.push({
      must: [
        { key: "scope", match: { value: "CHANNEL" } },
        { key: "channelId", match: { value: filter.channelId } },
      ],
    });

    const res = await this.request("POST", `/collections/${this.options.collection}/points/search`, {
      vector: embedding,
      limit: topK,
      with_payload: true,
      filter: { should },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppError("QDRANT_SEARCH", `Qdrant search failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const raw: unknown = await res.json();
    const parsed = qdrantSearchSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("QDRANT_SEARCH", "Unexpected Qdrant search response shape");
    }
    return parsed.data.result.map((hit) => ({
      score: hit.score,
      record: memoryRecordFromPayload(hit.id, hit.payload),
    }));
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    if (this.options.prisma) {
      const row = await this.options.prisma.memory.findUnique({ where: { id } });
      if (!row) return null;
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
    await this.init();
    const res = await this.request("POST", `/collections/${this.options.collection}/points`, {
      ids: [id],
      with_payload: true,
      with_vector: false,
    });
    if (!res.ok) return null;
    const raw: unknown = await res.json().catch(() => null);
    const parsed = qdrantPointLookupSchema.safeParse(raw);
    if (!parsed.success) return null;
    const point = parsed.data.result[0];
    return point ? memoryRecordFromPayload(point.id, point.payload) : null;
  }

  async delete(id: string): Promise<boolean> {
    await this.init();
    let vectorId = id;
    if (this.options.prisma) {
      const row = await this.options.prisma.memory.findUnique({ where: { id } });
      if (!row) return false;
      vectorId = row.vectorId ?? id;
      await this.options.prisma.memory.delete({ where: { id } }).catch(() => undefined);
    }
    const res = await this.request(
      "POST",
      `/collections/${this.options.collection}/points/delete?wait=true`,
      { points: [vectorId] },
    );
    return res.ok;
  }

  async count(): Promise<number> {
    if (this.options.prisma) return this.options.prisma.memory.count();
    const res = await this.request("POST", `/collections/${this.options.collection}/points/count`, {
      exact: true,
    });
    if (!res.ok) return 0;
    const raw: unknown = await res.json().catch(() => null);
    const parsed = z.object({ result: z.object({ count: z.number() }) }).safeParse(raw);
    return parsed.success ? parsed.data.result.count : 0;
  }

  private async request(method: string, path: string, body: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(this.url(path), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AppError(
        "QDRANT_UNREACHABLE",
        `Qdrant unreachable at ${this.options.url}: ${toErrorMessage(err)}`,
        { cause: err },
      );
    }
  }
}

const qdrantSearchSchema = z.object({
  result: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      score: z.number(),
      payload: z.record(z.unknown()).nullable().optional(),
    }),
  ),
});

const qdrantPointLookupSchema = z.object({
  result: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      payload: z.record(z.unknown()).nullable().optional(),
    }),
  ),
});

function memoryRecordFromPayload(
  id: string | number,
  payload: Record<string, unknown> | null | undefined,
): MemoryRecord {
  return {
    id: String(payload?.memoryId ?? id),
    scope: (payload?.scope ?? "GLOBAL") as MemoryRecord["scope"],
    userId: (payload?.userId ?? null) as string | null,
    guildId: (payload?.guildId ?? null) as string | null,
    channelId: (payload?.channelId ?? null) as string | null,
    content: String(payload?.content ?? ""),
    summary: null,
    importance: Number(payload?.importance ?? 1),
    metadata: {},
    createdAt: String(payload?.createdAt ?? nowIso()),
  };
}
