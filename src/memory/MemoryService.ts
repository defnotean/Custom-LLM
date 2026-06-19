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
import type { MemoryExtractionDecision, MemoryExtractionMode, MemoryExtractor } from "./MemoryExtractor";
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
  private readonly extractor: MemoryExtractor | null;
  private readonly extractionMode: MemoryExtractionMode;

  constructor(
    private readonly store: MemoryStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly logger: Logger,
    options?: {
      policy?: MemoryPolicy;
      learning?: LiveLearningCapture | null;
      extractor?: MemoryExtractor | null;
      extractionMode?: MemoryExtractionMode;
    },
  ) {
    this.policy = options?.policy ?? new MemoryPolicy();
    this.learning = options?.learning ?? null;
    this.extractor = options?.extractor ?? null;
    this.extractionMode = options?.extractionMode ?? "heuristic";
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
   * Post-conversation write-back. The heuristic path inspects the user's
   * message directly; the optional LLM extractor can emit Mem0-style
   * ADD/UPDATE/DELETE/NOOP decisions, with every ADD/UPDATE still passing
   * MemoryPolicy before storage.
   */
  async maybeExtractMemoryFromConversation(
    ctx: MemoryQueryContext,
    userMessage: string,
    assistantResponse: string,
  ): Promise<{ stored: boolean; id?: string; reason: string }> {
    try {
      if (this.extractor && this.extractionMode !== "heuristic") {
        const extracted = await this.extractor.extract({ ctx, userMessage, assistantResponse });
        const extractedResult = await this.applyExtractionDecisions(ctx, extracted);
        if (extractedResult || this.extractionMode === "llm") {
          return extractedResult ?? { stored: false, reason: "memory extractor produced no actions" };
        }
      }

      return await this.heuristicMemoryWriteBack(ctx, userMessage);
    } catch (err) {
      this.logger.warn({ err: toErrorMessage(err) }, "memory extraction failed");
      if (this.extractionMode === "hybrid") {
        return await this.heuristicMemoryWriteBack(ctx, userMessage);
      }
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

  private async heuristicMemoryWriteBack(
    ctx: MemoryQueryContext,
    userMessage: string,
  ): Promise<{ stored: boolean; id?: string; reason: string }> {
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
  }

  private async applyExtractionDecisions(
    ctx: MemoryQueryContext,
    decisions: MemoryExtractionDecision[],
  ): Promise<{ stored: boolean; id?: string; reason: string } | null> {
    if (decisions.length === 0) return null;

    let lastReason = "memory extractor produced no storage action";
    for (const decision of decisions) {
      switch (decision.action) {
        case "NOOP":
          lastReason = decision.reason ?? "memory extractor chose NOOP";
          break;
        case "DELETE": {
          const deleted = await this.deleteByExtractionTarget(ctx, decision.target ?? decision.content);
          if (deleted.deleted) {
            return { stored: false, reason: `deleted memory ${deleted.id}` };
          }
          lastReason = deleted.reason;
          break;
        }
        case "UPDATE": {
          const stored = await this.storeExtractedMemory(ctx, decision);
          if (stored.stored) {
            if (decision.target) await this.deleteByExtractionTarget(ctx, decision.target, stored.id);
            return stored;
          }
          lastReason = stored.reason;
          break;
        }
        case "ADD": {
          const stored = await this.storeExtractedMemory(ctx, decision);
          if (stored.stored) return stored;
          lastReason = stored.reason;
          break;
        }
      }
    }

    return { stored: false, reason: lastReason };
  }

  private async storeExtractedMemory(
    ctx: MemoryQueryContext,
    decision: MemoryExtractionDecision,
  ): Promise<{ stored: boolean; id?: string; reason: string }> {
    if (!decision.content) return { stored: false, reason: "extractor action missing content" };
    const scope = decision.scope ?? "USER";
    const result = await this.remember({
      content: decision.content,
      scope,
      userId: ctx.userId,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      importance: decision.importance,
      explicit: false,
      learning: {
        source: "llm_memory_extractor",
        confidence: decision.confidence ?? 0.8,
        metadata: {
          extractionAction: decision.action,
          extractionReason: decision.reason ?? null,
          extractionTarget: decision.target ?? null,
        },
      },
    });
    return result.stored
      ? { stored: true, id: result.id ?? undefined, reason: result.reason }
      : { stored: false, reason: result.reason };
  }

  private async deleteByExtractionTarget(
    ctx: MemoryQueryContext,
    target: string | undefined,
    excludeMemoryId?: string,
  ): Promise<{ deleted: boolean; id?: string; reason: string }> {
    if (!target) return { deleted: false, reason: "delete/update action missing target" };
    const hits = await this.search(target, ctx, 3);
    const hit = hits.find((candidate) => candidate.id !== excludeMemoryId && candidate.score > 0.25);
    if (!hit) return { deleted: false, reason: "no matching memory found for extraction target" };

    const result = await this.forget(hit.id, { userId: ctx.userId, isAdmin: false });
    return result.deleted
      ? { deleted: true, id: hit.id, reason: result.reason }
      : { deleted: false, reason: result.reason };
  }
}
