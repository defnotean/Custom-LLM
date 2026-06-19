import type { Client } from "discord.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";
import type {
  AssistantAction,
  InteractionTrace,
  MemoryHit,
  ParameterModuleHint,
  SkillHint,
  TrainingSink,
  TrainingSinkResult,
} from "../../types/ai";
import type { BotMessageContext } from "../../types/discord";
import { toErrorMessage } from "../../utils/errors";
import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import type { LLMProvider } from "../llm/LLMProvider";
import {
  DEFAULT_BOT_NAME,
  SYSTEM_PROMPT_VERSION,
  buildSystemPrompt,
} from "../prompts/systemPrompt";
import { buildSafetySection } from "../prompts/safetyPrompt";
import { buildMemorySection } from "../prompts/memoryPrompt";
import { buildSkillSection } from "../prompts/skillPrompt";
import { buildParameterModuleSection } from "../prompts/parameterPrompt";
import type { ToolExecutionContext, ToolMemoryAccess } from "../../tools/ToolDefinition";
import type { ToolRegistry } from "../../tools/ToolRegistry";
import type { ToolExecutor, ToolExecutionOutcome } from "../../tools/ToolExecutor";
import { ConversationAgent } from "./ConversationAgent";
import type { ToolRouterAgent } from "./ToolRouterAgent";
import type { MemoryAgent } from "./MemoryAgent";
import type { SafetyAgent } from "./SafetyAgent";
import { EvaluationAgent } from "./EvaluationAgent";
import {
  InMemoryPendingConfirmationStore,
  type PendingConfirmationStore,
  type PendingToolCall,
} from "./PendingConfirmationStore";

export interface AgentReply {
  content: string;
  trace: InteractionTrace;
}

export interface AgentControllerOptions {
  llm: LLMProvider;
  registry: ToolRegistry;
  executor: ToolExecutor;
  toolRouterAgent?: ToolRouterAgent | null;
  memoryAgent?: MemoryAgent | null;
  skillRetriever?: SkillRetrievalPort | null;
  parameterActivator?: ParameterActivationPort | null;
  safetyAgent?: SafetyAgent | null;
  training?: TrainingSink | null;
  learning?: InteractionLearningSink | null;
  behaviorGuardrail?: BehaviorGuardrailPort | null;
  pendingConfirmations?: PendingConfirmationStore;
  logger: Logger;
  botName?: string;
  toolCallingEnabled?: boolean;
  /** Extra resources passed into ToolExecutionContext. */
  toolContextExtras?: {
    db?: PrismaClient | null;
    memory?: ToolMemoryAccess | null;
    discordClient?: Client;
  };
}

export interface InteractionLearningSink {
  captureInteraction(trace: InteractionTrace, training?: TrainingSinkResult): Promise<void>;
}

export interface BehaviorGuardrailPort {
  respond(input: {
    ctx: BotMessageContext;
    prompt: string;
    candidateToolNames: string[];
    likelyNeedsTool: boolean;
  }): Promise<BehaviorGuardrailDecision | null> | BehaviorGuardrailDecision | null;
}

export interface BehaviorGuardrailDecision {
  action: Extract<AssistantAction, { type: "message" | "clarification" }>;
  model: string;
  matchedRule: string;
  latencyMs?: number;
}

export interface SkillRetrievalPort {
  retrieve(input: { query: string; candidateToolNames?: string[]; topK?: number }): Promise<SkillHint[]>;
}

export interface ParameterActivationPort {
  retrieve(input: { query: string; candidateToolNames?: string[]; topK?: number }): Promise<ParameterModuleHint[]>;
}

const CONFIRM_PATTERN = /^(yes|y|yep|yeah|confirm|do it|go ahead|sure|ok|okay)\b/i;
const CANCEL_PATTERN = /^(no|n|nope|nah|cancel|stop|abort|don'?t)\b/i;
const PENDING_TTL_MS = 2 * 60 * 1000;

/**
 * Central orchestrator. Message flow:
 *
 *   context/recent transcript → pending-confirmation check → safety precheck → memory retrieval
 *   → tool candidate retrieval → prompt build → LLM → parse → (tool gates →
 *   execute → follow-up LLM) → reply → training/conversation logging →
 *   optional memory write-back
 *
 * Design rules enforced here:
 *  - The model's output is data, not authority: every tool call passes the
 *    executor's validation/permission/cooldown/confirmation gates.
 *  - Casual chat takes the fast path (no tool section, no second LLM call).
 *  - Every turn produces a complete InteractionTrace for training capture,
 *    including failures — failed parses are valuable training signal.
 */
export class AgentController {
  private readonly llm: LLMProvider;
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly toolRouterAgent: ToolRouterAgent | null;
  private readonly memoryAgent: MemoryAgent | null;
  private readonly skillRetriever: SkillRetrievalPort | null;
  private readonly parameterActivator: ParameterActivationPort | null;
  private readonly safetyAgent: SafetyAgent | null;
  private readonly training: TrainingSink | null;
  private readonly learning: InteractionLearningSink | null;
  private readonly behaviorGuardrail: BehaviorGuardrailPort | null;
  private readonly logger: Logger;
  private readonly botName: string;
  private readonly toolCallingEnabled: boolean;
  private readonly conversation: ConversationAgent;
  private readonly evaluation = new EvaluationAgent();
  private readonly toolContextExtras: AgentControllerOptions["toolContextExtras"];
  private readonly pendingConfirmations: PendingConfirmationStore;

  constructor(options: AgentControllerOptions) {
    this.llm = options.llm;
    this.registry = options.registry;
    this.executor = options.executor;
    this.toolRouterAgent = options.toolRouterAgent ?? null;
    this.memoryAgent = options.memoryAgent ?? null;
    this.skillRetriever = options.skillRetriever ?? null;
    this.parameterActivator = options.parameterActivator ?? null;
    this.safetyAgent = options.safetyAgent ?? null;
    this.training = options.training ?? null;
    this.learning = options.learning ?? null;
    this.behaviorGuardrail = options.behaviorGuardrail ?? null;
    this.logger = options.logger;
    this.botName = options.botName ?? DEFAULT_BOT_NAME;
    this.toolCallingEnabled = options.toolCallingEnabled ?? true;
    this.conversation = new ConversationAgent(options.llm, options.logger);
    this.toolContextExtras = options.toolContextExtras ?? {};
    this.pendingConfirmations = options.pendingConfirmations ?? new InMemoryPendingConfirmationStore();
  }

  async handleDiscordMessage(
    ctx: BotMessageContext,
    options?: { transcript?: string | null },
  ): Promise<AgentReply> {
    const startedAt = Date.now();
    const trace = this.newTrace(ctx);

    try {
      // 0. Pending confirmation resolution ("yes"/"no" after a confirm prompt).
      const pendingReply = await this.resolvePendingConfirmation(ctx, trace);
      if (pendingReply !== null) {
        return this.finish(ctx, trace, pendingReply, startedAt);
      }

      // 1. Safety precheck (rate limit, moderation).
      if (this.safetyAgent) {
        const verdict = await this.safetyAgent.precheck(ctx);
        if (!verdict.allowed) {
          trace.errors.push(`safety_block: ${verdict.reason ?? "blocked"}`);
          const reply = verdict.userReply ?? this.safetyAgent.refusal(verdict.reason ?? "blocked");
          return this.finish(ctx, trace, reply, startedAt, { skipMemoryWrite: true });
        }
      }

      // 2. Memory retrieval (top-K relevant memories only).
      let memorySection: string | null = null;
      let memoryHits: MemoryHit[] = [];
      if (this.memoryAgent) {
        const retrieval = await this.memoryAgent.retrieve(ctx, 5);
        memoryHits = retrieval.hits;
        memorySection = retrieval.section ?? buildMemorySection(retrieval.hits);
        trace.memoriesRetrieved = retrieval.hits;
      }

      // 3. Tool candidate retrieval (top-N subset, never the whole registry).
      let toolSection: string | null = null;
      let candidateToolNames: string[] = [];
      if (this.toolCallingEnabled && this.toolRouterAgent) {
        const selection = await this.toolRouterAgent.selectCandidates(ctx, { maxTools: 10 });
        toolSection = selection.toolSection;
        trace.likelyNeedsTool = selection.routing.likelyNeedsTool;
        trace.routerReasoning = selection.routing.reasoning;
        trace.routerConfidence = selection.routing.confidence;
        candidateToolNames = selection.routing.candidateTools.map((t) => t.name);
        trace.candidateToolNames = candidateToolNames;
      }

      // 3b. Approved learned-skill retrieval. Skills are prompt hints only;
      // tool execution still goes through normal candidate and executor gates.
      let skillSection: string | null = null;
      if (this.skillRetriever) {
        try {
          const skills = await this.skillRetriever.retrieve({
            query: ctx.content,
            candidateToolNames,
            topK: 3,
          });
          trace.skillsRetrieved = skills;
          skillSection = buildSkillSection(skills);
        } catch (err) {
          this.logger.warn({ err: toErrorMessage(err) }, "skill retrieval failed; continuing without");
        }
      }

      // 3c. Active learned parameter-module retrieval. This is the live
      // runtime view of promoted growth modules; the actual executor/tool gates
      // still decide whether any external action can happen.
      let parameterModuleSection: string | null = null;
      if (this.parameterActivator) {
        try {
          const modules = await this.parameterActivator.retrieve({
            query: ctx.content,
            candidateToolNames,
            topK: 3,
          });
          trace.parameterModulesActivated = modules;
          parameterModuleSection = buildParameterModuleSection(modules);
        } catch (err) {
          this.logger.warn({ err: toErrorMessage(err) }, "parameter-module activation failed; continuing without");
        }
      }

      // 4. Prompt build.
      const systemPrompt = buildSystemPrompt({
        botName: this.botName,
        guildName: ctx.guildName,
        channelName: ctx.channelName,
        isDM: ctx.isDM,
        toolSection,
        memorySection: memoryHits.length > 0 ? memorySection : null,
        skillSection,
        parameterModuleSection,
        safetySection: buildSafetySection(),
      });
      trace.systemPrompt = systemPrompt;

      const behaviorGuardrailReply = await this.tryBehaviorGuardrail(ctx, trace, {
        candidateToolNames,
        likelyNeedsTool: trace.likelyNeedsTool,
      });
      if (behaviorGuardrailReply !== null) {
        return this.finish(ctx, trace, behaviorGuardrailReply, startedAt);
      }

      // 5. LLM call + 6. parse.
      const turn = await this.conversation.run({
        systemPrompt,
        transcript: options?.transcript ?? null,
        username: ctx.username,
        userMessage: ctx.content,
      });
      trace.rawModelOutput = turn.response.content;
      trace.llmLatencyMs = turn.response.latencyMs;
      trace.model = turn.response.model;
      trace.parseOk = turn.parsed.parseOk;
      trace.parsedAction = turn.parsed.action;
      if (turn.parsed.parseError) trace.errors.push(`parse: ${turn.parsed.parseError}`);

      // 7. Act on the parsed action.
      const reply = await this.actOn(ctx, trace, turn.parsed.action);
      return this.finish(ctx, trace, reply, startedAt);
    } catch (err) {
      const msg = toErrorMessage(err);
      trace.errors.push(`fatal: ${msg}`);
      this.logger.error({ err: msg, userId: ctx.userId }, "agent failed to handle message");
      const reply =
        "Something went wrong on my end while handling that — mind trying again in a moment?";
      return this.finish(ctx, trace, reply, startedAt, { skipMemoryWrite: true });
    }
  }

  // ── Action handling ─────────────────────────────────────────────────────

  private async actOn(
    ctx: BotMessageContext,
    trace: InteractionTrace,
    action: AssistantAction,
  ): Promise<string> {
    switch (action.type) {
      case "message":
        return action.content;

      case "clarification":
        return action.content;

      case "confirmation_request": {
        await this.setPending(ctx, {
          tool: action.pending_tool_call.tool,
          arguments: action.pending_tool_call.arguments,
          expiresAt: Date.now() + PENDING_TTL_MS,
          originalUserMessage: ctx.content,
        });
        return `${action.content}\n\n*(reply "yes" to confirm or "no" to cancel — expires in 2 minutes)*`;
      }

      case "tool_call":
        return this.handleToolCall(ctx, trace, action);
    }
  }

  private async tryBehaviorGuardrail(
    ctx: BotMessageContext,
    trace: InteractionTrace,
    routing: { candidateToolNames: string[]; likelyNeedsTool: boolean },
  ): Promise<string | null> {
    if (!this.behaviorGuardrail || routing.likelyNeedsTool) return null;
    const decision = await this.behaviorGuardrail.respond({
      ctx,
      prompt: ctx.content,
      candidateToolNames: routing.candidateToolNames,
      likelyNeedsTool: routing.likelyNeedsTool,
    });
    if (!decision) return null;

    trace.behaviorGuardrail = {
      model: decision.model,
      matchedRule: decision.matchedRule,
      ...(typeof decision.latencyMs === "number" ? { latencyMs: decision.latencyMs } : {}),
    };
    trace.rawModelOutput = JSON.stringify(decision.action);
    trace.parseOk = true;
    trace.parsedAction = decision.action;
    trace.model = decision.model;
    trace.llmLatencyMs = decision.latencyMs ?? 0;
    return this.actOn(ctx, trace, decision.action);
  }

  private async handleToolCall(
    ctx: BotMessageContext,
    trace: InteractionTrace,
    action: Extract<AssistantAction, { type: "tool_call" }>,
  ): Promise<string> {
    trace.toolCall = { name: action.tool, arguments: action.arguments, reason: action.reason };

    if (!trace.candidateToolNames.includes(action.tool)) {
      trace.toolDenied = "not_in_candidate_set";
      trace.errors.push(`tool_not_in_candidate_set: ${action.tool}`);
      return `I can't use \`${action.tool}\` for this request.`;
    }

    const outcome = await this.executor.execute(
      action.tool,
      action.arguments,
      this.buildToolContext(ctx),
      { confirmed: false, source: "llm" },
    );

    if (outcome.status === "denied" && outcome.denialReason === "confirmation_required") {
      await this.setPending(ctx, {
        tool: action.tool,
        arguments: action.arguments,
        expiresAt: Date.now() + PENDING_TTL_MS,
        originalUserMessage: ctx.content,
      });
      trace.toolDenied = "confirmation_required";
      const argsPreview = JSON.stringify(action.arguments);
      return (
        `I'm about to run **${action.tool}** with arguments \`${argsPreview}\`` +
        `${action.reason ? ` (${action.reason})` : ""}. ` +
        `This is a ${this.registry.getTool(action.tool)?.riskLevel ?? "risky"}-risk action.\n\n` +
        `*(reply "yes" to confirm or "no" to cancel — expires in 2 minutes)*`
      );
    }

    if (outcome.status === "denied") {
      trace.toolDenied = outcome.denialReason ?? "denied";
      return this.denialReply(outcome);
    }

    return this.composeToolFollowUp(ctx, trace, action.tool, action.arguments, outcome);
  }

  /** Second LLM turn: turn the real tool result into a natural reply. */
  private async composeToolFollowUp(
    ctx: BotMessageContext,
    trace: InteractionTrace,
    toolName: string,
    args: Record<string, unknown>,
    outcome: ToolExecutionOutcome,
  ): Promise<string> {
    trace.toolResult = outcome.result;
    trace.toolSuccess = outcome.status === "ok";

    const resultJson = JSON.stringify(outcome.result ?? { ok: false, error: outcome.message });
    const callJson = JSON.stringify({ type: "tool_call", tool: toolName, arguments: args });

    try {
      const followUp = await this.conversation.runToolFollowUp({
        systemPrompt: buildSystemPrompt({
          botName: this.botName,
          guildName: ctx.guildName,
          channelName: ctx.channelName,
          isDM: ctx.isDM,
          toolSection: null,
          memorySection: null,
          skillSection: null,
          safetySection: buildSafetySection(),
        }),
        username: ctx.username,
        userMessage: ctx.content,
        toolName,
        toolCallJson: callJson,
        toolResultJson: resultJson,
      });
      trace.llmLatencyMs = (trace.llmLatencyMs ?? 0) + followUp.response.latencyMs;
      const act = followUp.parsed.action;
      if (act.type === "message" && act.content.trim().length > 0) {
        return act.content;
      }
    } catch (err) {
      trace.errors.push(`follow_up_llm: ${toErrorMessage(err)}`);
    }

    // Template fallback — never leave the user hanging because the second
    // LLM turn failed.
    if (outcome.result && outcome.result.ok) {
      return `✅ \`${toolName}\` done:\n\`\`\`json\n${truncate(resultJson, 1200)}\n\`\`\``;
    }
    return `⚠️ \`${toolName}\` failed: ${outcome.result && !outcome.result.ok ? outcome.result.error : outcome.message}`;
  }

  // ── Confirmation flow ───────────────────────────────────────────────────

  private pendingKey(ctx: BotMessageContext): string {
    return `${ctx.channelId}:${ctx.userId}`;
  }

  private async setPending(ctx: BotMessageContext, pending: PendingToolCall): Promise<void> {
    await this.pendingConfirmations.set(this.pendingKey(ctx), pending, Math.max(1, pending.expiresAt - Date.now()));
  }

  /** Returns a reply when this message resolved a pending confirmation, else null. */
  private async resolvePendingConfirmation(
    ctx: BotMessageContext,
    trace: InteractionTrace,
  ): Promise<string | null> {
    const key = this.pendingKey(ctx);
    const pending = await this.pendingConfirmations.get(key);
    if (!pending) return null;

    if (pending.expiresAt < Date.now()) {
      await this.pendingConfirmations.delete(key);
      return null;
    }

    const content = ctx.content.trim();
    if (CANCEL_PATTERN.test(content)) {
      await this.pendingConfirmations.delete(key);
      return "Cancelled — nothing was executed.";
    }
    if (!CONFIRM_PATTERN.test(content)) {
      // Not a confirmation answer; let normal handling continue (pending
      // stays until it expires or is answered).
      return null;
    }

    await this.pendingConfirmations.delete(key);
    trace.toolCall = { name: pending.tool, arguments: pending.arguments, reason: "user confirmed" };

    const outcome = await this.executor.execute(
      pending.tool,
      pending.arguments,
      this.buildToolContext(ctx),
      { confirmed: true, source: "llm" },
    );

    if (outcome.status === "denied") {
      trace.toolDenied = outcome.denialReason ?? "denied";
      return this.denialReply(outcome);
    }

    return this.composeToolFollowUp(
      { ...ctx, content: pending.originalUserMessage },
      trace,
      pending.tool,
      pending.arguments,
      outcome,
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private denialReply(outcome: ToolExecutionOutcome): string {
    switch (outcome.denialReason) {
      case "permission":
        return `You don't have permission for that: ${outcome.message}`;
      case "cooldown":
        return `Easy there — ${outcome.message.toLowerCase()}`;
      case "invalid_args":
        return `I couldn't run that tool — ${outcome.message}`;
      case "not_found":
        return `I tried to use a tool that doesn't exist (\`${outcome.toolName}\`) — that one's on me. Anything else I can do?`;
      case "disabled":
        return `That tool is currently disabled on this server.`;
      default:
        return outcome.message;
    }
  }

  private buildToolContext(ctx: BotMessageContext): ToolExecutionContext {
    return {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      memberPermissions: ctx.memberPermissions,
      disabledTools: ctx.guildSettings?.disabledTools,
      message: ctx.raw,
      discordClient: this.toolContextExtras?.discordClient ?? ctx.raw?.client,
      logger: this.logger.child({ component: "tool" }),
      db: this.toolContextExtras?.db ?? null,
      memory: this.toolContextExtras?.memory ?? null,
    };
  }

  private newTrace(ctx: BotMessageContext): InteractionTrace {
    return {
      id: newId(),
      createdAt: nowIso(),
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      username: ctx.username,
      discordMessageId: ctx.messageId,
      userMessage: ctx.content,
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
      systemPrompt: "",
      memoriesRetrieved: [],
      skillsRetrieved: [],
      parameterModulesActivated: [],
      candidateToolNames: [],
      likelyNeedsTool: false,
      finalResponse: "",
      errors: [],
    };
  }

  private async finish(
    ctx: BotMessageContext,
    trace: InteractionTrace,
    reply: string,
    startedAt: number,
    options?: { skipMemoryWrite?: boolean },
  ): Promise<AgentReply> {
    trace.finalResponse = reply;
    trace.totalLatencyMs = Date.now() - startedAt;
    let trainingResult: TrainingSinkResult = {};

    // Training/conversation capture — failures must never break the reply.
    if (this.training) {
      try {
        trainingResult = await this.training.logInteraction(trace);
      } catch (err) {
        this.logger.warn({ err: toErrorMessage(err) }, "training capture failed");
      }
    }

    // Live-learning candidate capture — also best-effort.
    if (this.learning) {
      try {
        await this.learning.captureInteraction(trace, trainingResult);
      } catch (err) {
        this.logger.warn({ err: toErrorMessage(err) }, "interaction learning capture failed");
      }
    }

    // Optional memory write-back (policy decides; best-effort).
    if (this.memoryAgent && !options?.skipMemoryWrite) {
      await this.memoryAgent.maybeWriteBack(ctx, ctx.content, reply);
    }

    return { content: reply, trace };
  }

  /** Exposed for evaluation pipelines/tests. */
  scoreTrace(trace: InteractionTrace): number {
    return this.evaluation.scoreInteraction(trace);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
