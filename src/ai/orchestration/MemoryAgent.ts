import type { Logger } from "pino";
import type { MemoryHit, MemoryPort, MemoryQueryContext } from "../../types/ai";
import type { BotMessageContext } from "../../types/discord";
import { toErrorMessage } from "../../utils/errors";

export interface MemoryRetrieval {
  section: string | null;
  hits: MemoryHit[];
}

/**
 * Bridges the memory system into the agent flow. Retrieval and write-back
 * are both best-effort: a memory outage degrades the bot, it never breaks it.
 */
export class MemoryAgent {
  constructor(
    private readonly memory: MemoryPort,
    private readonly logger: Logger,
  ) {}

  private queryCtx(ctx: BotMessageContext): MemoryQueryContext {
    return { userId: ctx.userId, guildId: ctx.guildId, channelId: ctx.channelId };
  }

  async retrieve(ctx: BotMessageContext, topK = 5): Promise<MemoryRetrieval> {
    try {
      const { section, hits } = await this.memory.getContextForPrompt(
        this.queryCtx(ctx),
        ctx.content,
        topK,
      );
      return { section: hits.length > 0 ? section : null, hits };
    } catch (err) {
      this.logger.warn({ err: toErrorMessage(err) }, "memory retrieval failed; continuing without");
      return { section: null, hits: [] };
    }
  }

  /** Post-reply write-back; MemoryPolicy (inside the service) decides what sticks. */
  async maybeWriteBack(
    ctx: BotMessageContext,
    userMessage: string,
    assistantResponse: string,
  ): Promise<void> {
    try {
      await this.memory.maybeExtractMemoryFromConversation(
        this.queryCtx(ctx),
        userMessage,
        assistantResponse,
      );
    } catch (err) {
      this.logger.warn({ err: toErrorMessage(err) }, "memory write-back failed");
    }
  }
}
