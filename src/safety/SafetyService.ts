import type { Logger } from "pino";
import type { SafetyPort, SafetyVerdict } from "../types/ai";
import { toErrorMessage } from "../utils/errors";
import { RateLimitService } from "./RateLimitService";
import { ModerationRules } from "./ModerationRules";
import type { ModerationProvider } from "./ModerationProvider";

/**
 * Safety layer, defense-in-depth position #2 (after the prompt, before the
 * executor's own gates):
 *  - ingress: per-user rate limiting + operational boundary screen
 *  - tool gating: high/critical-risk tools require user confirmation
 *  - refusal helper for consistent, non-preachy refusals
 *
 * The prompt-injection posture: user content, tool output, and retrieved
 * memory are all untrusted. Code-level validation (Zod, permission checks,
 * confirmation gates) is what actually protects actions.
 */
export class SafetyService implements SafetyPort {
  private readonly rateLimit: RateLimitService;
  private readonly moderation: ModerationRules;
  private readonly moderationProvider?: ModerationProvider;
  private readonly moderationFailClosed: boolean;
  private readonly enabled: boolean;

  constructor(
    private readonly logger: Logger,
    options?: {
      enabled?: boolean;
      rateLimit?: RateLimitService;
      moderation?: ModerationRules;
      moderationProvider?: ModerationProvider;
      moderationFailClosed?: boolean;
    },
  ) {
    this.enabled = options?.enabled ?? true;
    this.rateLimit = options?.rateLimit ?? new RateLimitService();
    this.moderation = options?.moderation ?? new ModerationRules();
    this.moderationProvider = options?.moderationProvider;
    this.moderationFailClosed = options?.moderationFailClosed ?? false;
  }

  async precheckMessage(input: {
    userId: string;
    guildId: string | null;
    channelId: string;
    content: string;
  }): Promise<SafetyVerdict> {
    if (!this.enabled) return { allowed: true };

    const rate = await this.rateLimit.check(`msg:${input.userId}`);
    if (!rate.allowed) {
      const seconds = Math.ceil(rate.retryAfterMs / 1000);
      this.logger.info({ userId: input.userId }, "rate limited");
      return {
        allowed: false,
        reason: "rate_limited",
        userReply: `Slow down a touch — try again in ~${seconds}s.`,
      };
    }

    const screen = this.moderation.screen(input.content);
    if (screen.flagged) {
      this.logger.warn(
        { userId: input.userId, categories: screen.categories, matches: screen.matches },
        "message flagged by moderation rules",
      );
      return {
        allowed: false,
        reason: screen.reason ?? screen.categories.join(","),
        userReply: this.refusalMessage(screen.reason ?? "that request"),
      };
    }

    const providerVerdict = await this.checkModerationProvider(input);
    if (!providerVerdict.allowed) return providerVerdict;

    return { allowed: true };
  }

  private async checkModerationProvider(input: {
    userId: string;
    guildId: string | null;
    channelId: string;
    content: string;
  }): Promise<SafetyVerdict> {
    if (!this.moderationProvider) return { allowed: true };

    try {
      const decision = await this.moderationProvider.check(input);
      if (decision.action === "allow") return { allowed: true };

      const reason = decision.reason ?? decision.labels?.join(",") ?? "external moderation provider";
      this.logger.warn(
        { userId: input.userId, guildId: input.guildId, channelId: input.channelId, labels: decision.labels, reason },
        "message blocked by moderation provider",
      );
      return {
        allowed: false,
        reason,
        userReply: this.refusalMessage(reason),
      };
    } catch (err) {
      const message = toErrorMessage(err);
      this.logger.warn(
        { userId: input.userId, guildId: input.guildId, channelId: input.channelId, err: message },
        "moderation provider failed",
      );
      if (!this.moderationFailClosed) return { allowed: true };

      return {
        allowed: false,
        reason: "moderation_provider_unavailable",
        userReply: "Moderation check is unavailable right now; try again in a bit.",
      };
    }
  }

  /**
   * High-risk tool actions (ban/kick/timeout/mass-delete/role changes/
   * destructive or external actions) require explicit user confirmation.
   * Tools opt in via requiresConfirmation; risk >= high forces it regardless
   * while safety is enabled.
   */
  toolRequiresConfirmation(input: { riskLevel: string; requiresConfirmation: boolean }): boolean {
    if (input.requiresConfirmation) return true;
    if (!this.enabled) return false;
    return input.riskLevel === "high" || input.riskLevel === "critical";
  }

  refusalMessage(reason: string): string {
    return `Not going to do that (${reason}). Happy to help with something else though.`;
  }
}
