import type { BotMessageContext } from "../../types/discord";
import type { ToolRegistry } from "../../tools/ToolRegistry";
import type { ToolRouter, ToolRoutingResult } from "../../tools/ToolRouter";
import { buildToolPromptSection } from "../prompts/toolPrompt";

export interface ToolCandidateSelection {
  routing: ToolRoutingResult;
  /** Rendered prompt section, or null when no tools should be offered. */
  toolSection: string | null;
}

/**
 * Bridges the ToolRouter into the agent flow: retrieves candidate tools for
 * the message and renders the prompt section for just that subset.
 */
export class ToolRouterAgent {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly router: ToolRouter,
  ) {}

  async selectCandidates(
    ctx: BotMessageContext,
    options?: { maxTools?: number; recentSummary?: string },
  ): Promise<ToolCandidateSelection> {
    const routing = await this.router.route({
      message: ctx.content,
      guildId: ctx.guildId,
      memberPermissions: ctx.memberPermissions,
      recentSummary: options?.recentSummary,
      maxTools: options?.maxTools ?? 10,
    });

    // Fast path: when the router is confident no tool is needed, we omit the
    // tool section entirely — smaller prompt, faster casual chat.
    const toolSection = routing.likelyNeedsTool
      ? buildToolPromptSection(this.registry, routing.candidateTools)
      : null;

    return { routing, toolSection };
  }
}
