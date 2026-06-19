import type { SafetyPort, SafetyVerdict } from "../../types/ai";
import type { BotMessageContext } from "../../types/discord";

/**
 * Bridges the safety layer into the agent flow (ingress check). Tool-level
 * gates live in the ToolExecutor; this is the message-level precheck.
 */
export class SafetyAgent {
  constructor(private readonly safety: SafetyPort) {}

  async precheck(ctx: BotMessageContext): Promise<SafetyVerdict> {
    return this.safety.precheckMessage({
      userId: ctx.userId,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      content: ctx.content,
    });
  }

  refusal(reason: string): string {
    return this.safety.refusalMessage(reason);
  }
}
