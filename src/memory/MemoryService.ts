import type { Logger } from "pino";
import type { MemoryHit, MemoryPort, MemoryQueryContext, MemoryScopeName } from "../types/ai";
import type { JsonObject, JsonValue } from "../types/common";
import type {
  LearnedItem,
  LearningAccessPath,
  LearningKind,
  LearningProvenance,
  LearningRetentionPolicy,
  LearningReviewStatus,
} from "../learning/LiveLearningRegistry";
import { toErrorMessage } from "../utils/errors";
import { buildMemorySection } from "../ai/prompts/memoryPrompt";
import type { EmbeddingProvider } from "./EmbeddingProvider";
import type { MemoryStore } from "./MemoryStore";
import { MemoryPolicy } from "./MemoryPolicy";

/**
 * High-level memory façade. Implements both the agent-facing MemoryPort and
 * the tool-facing ToolMemoryAccess (structurally). Owns: embedding, policy
 * enforcement, scope rules, prompt formatting.
 */

export interface RememberInput {
  content: string;
  scope?: MemoryScopeName;
  userId?: string | null;
  guildId?: string | null;
  channelId?: string | null;
  importance?: number;
  metadata?: JsonValue;
  /** Explicit user request (tool/command) — bypasses heuristics, not the secret check. */
  explicit?: boolean;
  learning?: {
    kind?: LearningKind;
    source?: string;
    confidence?: number;
    reviewStatus?: LearningReviewStatus;
    accessPaths?: LearningAccessPath[];
    retention?: Partial<LearningRetentionPolicy>;
    metadata?: JsonObject;
  };
}

export interface RememberResult {
  id: string | null;
  stored: boolean;
  reason: string;
  learnedItemId?: string;
}

export interface LiveLearningCapture {
  createLearnedItem(input: {
    kind: LearningKind;
    content: string;
    source: string;
    confidence?: number;
    reviewStatus?: LearningReviewStatus;
    accessPaths?: LearningAccessPath[];
    provenance?: LearningProvenance;
    retention?: Partial<LearningRetentionPolicy>;
    metadata?: JsonObject;
  }): Promise<LearnedItem>;
}

export class MemoryService implements MemoryPort {
  private readonly policy: MemoryPolicy;
  private readonly learning: LiveLearningCapture | null;

  constructor(
    private readonly store: MemoryStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly logger: Logger,
    options?: { policy?: MemoryPolicy; learning?: LiveLearningCapture | null },
  ) {
    this.policy = options?.policy ?? new MemoryPolicy();
    this.learning = options?.learning ?? null;
  }

  get storeName(): string {
    return this.store.name;
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const verdict = this.policy.evaluate({
      content: input.content,
      explicit: input.explicit ?? false,
    });
    if (!verdict.store) {
      return { id: null, stored: false, reason: verdict.reason };
    }

    const scope = input.scope ?? "USER";
    if (scope === "USER" && !input.userId) {
      return { id: null, stored: false, reason: "USER scope requires a userId" };
    }
    if (scope === "GUILD" && !input.guildId) {
      return { id: null, stored: false, reason: "GUILD scope requires a guildId" };
    }
    if (scope === "CHANNEL" && !input.channelId) {
      return { id: null, stored: false, reason: "CHANNEL scope requires a channelId" };
    }

    const [embedding] = await this.embeddings.embed([input.content]);
    if (!embedding) {
      return { id: null, stored: false, reason: "embedding failed" };
    }

    const record = await this.store.upsert({
      scope,
      userId: scope === "USER" ? (input.userId ?? null) : null,
      guildId: input.guildId ?? null,
      channelId: scope === "CHANNEL" ? (input.channelId ?? null) : null,
      content: input.content,
      importance: input.importance ?? verdict.importance,
      metadata: input.metadata ?? {},
      embedding,
    });

    const learnedItemId = await this.recordLearnedMemory(input, record.id, scope, verdict.reason);

    this.logger.debug({ id: record.id, learnedItemId, scope }, "memory stored");
    return { id: record.id, stored: true, reason: verdict.reason, ...(learnedItemId ? { learnedItemId } : {}) };
  }

  async search(
    query: string,
    ctx: { userId: string; guildId: string | null; channelId: string },
    topK = 5,
  ): Promise<MemoryHit[]> {
    const [embedding] = await this.embeddings.embed([query]);
    if (!embedding) return [];
    const hits = await this.store.search(
      embedding,
      { userId: ctx.userId, guildId: ctx.guildId, channelId: ctx.channelId },
      topK,
    );
    return hits.map((h) => ({
      id: h.record.id,
      content: h.record.content,
      scope: h.record.scope,
      importance: h.record.importance,
      score: h.score,
    }));
  }

  async forget(
    id: string,
    requester: { userId: string; isAdmin: boolean },
  ): Promise<{ deleted: boolean; reason: string }> {
    const record = await this.store.getById(id);
    if (!record) return { deleted: false, reason: "memory not found" };

    const ownsIt = record.scope === "USER" && record.userId === requester.userId;
    if (!ownsIt && !requester.isAdmin) {
      return {
        deleted: false,
        reason: "you can only delete your own memories (admins can delete any)",
      };
    }
    const deleted = await this.store.delete(id);
    return deleted
      ? { deleted: true, reason: "deleted" }
      : { deleted: false, reason: "delete failed" };
  }

  // ── MemoryPort ────────────────────────────────────────────────────────────

  async getContextForPrompt(
    ctx: MemoryQueryContext,
    query: string,
    topK = 5,
  ): Promise<{ section: string; hits: MemoryHit[] }> {
    const hits = await this.search(query, ctx, topK);
    // Drop weak matches so irrelevant memories don't pollute the prompt.
    const relevant = hits.filter((h) => h.score > 0.25);
    return { section: buildMemorySection(relevant) ?? "", hits: relevant };
  }

  /**
   * Post-conversation write-back: the policy inspects the *user's* message
   * for durable facts. Current implementation is heuristic (regex patterns);
   * LLM-assisted extraction (Mem0-style ADD/UPDATE/DELETE/NOOP) is the
   * documented next step and slots in behind this same method.
   */
  async maybeExtractMemoryFromConversation(
    ctx: MemoryQueryContext,
    userMessage: string,
    _assistantResponse: string,
  ): Promise<{ stored: boolean; id?: string; reason: string }> {
    try {
      const result = await this.remember({
        content: userMessage,
        scope: "USER",
        userId: ctx.userId,
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        explicit: false,
      });
      return result.stored
        ? { stored: true, id: result.id ?? undefined, reason: result.reason }
        : { stored: false, reason: result.reason };
    } catch (err) {
      this.logger.warn({ err: toErrorMessage(err) }, "memory extraction failed");
      return { stored: false, reason: `error: ${toErrorMessage(err)}` };
    }
  }

  async count(): Promise<number> {
    return this.store.count();
  }

  private async recordLearnedMemory(
    input: RememberInput,
    memoryId: string,
    scope: MemoryScopeName,
    policyReason: string,
  ): Promise<string | undefined> {
    if (!this.learning) return undefined;

    try {
      const item = await this.learning.createLearnedItem({
        kind: input.learning?.kind ?? "memory",
        content: input.content,
        source: input.learning?.source ?? (input.explicit ? "explicit_memory" : "memory_policy"),
        confidence: input.learning?.confidence ?? (input.explicit ? 1 : 0.82),
        ...(input.learning?.reviewStatus ? { reviewStatus: input.learning.reviewStatus } : {}),
        accessPaths: input.learning?.accessPaths ?? ["memory_rag"],
        provenance: {
          userId: input.userId ?? undefined,
          guildId: input.guildId ?? null,
          channelId: input.channelId ?? null,
          memoryId,
        },
        retention: {
          canRetrieve: true,
          canTrain: input.explicit === true,
          ...input.learning?.retention,
        },
        metadata: {
          memoryScope: scope,
          importance: input.importance ?? null,
          explicit: input.explicit ?? false,
          policyReason,
          ...(input.learning?.metadata ?? {}),
        },
      });
      return item.id;
    } catch (err) {
      this.logger.warn({ err: toErrorMessage(err), memoryId }, "failed to record learned memory item");
      return undefined;
    }
  }
}
