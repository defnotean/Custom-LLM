import type { Logger } from "pino";
import { toErrorMessage, withTimeout } from "../utils/errors";
import { toJsonValue, type JsonValue } from "../types/common";
import type {
  RegisteredTool,
  ToolExecutionContext,
  ToolResultEnvelope,
} from "./ToolDefinition";
import { toolFail } from "./ToolDefinition";
import type { ToolRegistry } from "./ToolRegistry";
import type { ToolPermissionService } from "./ToolPermissionService";
import type { ToolCooldownService } from "./ToolCooldownService";

export type DenialReason =
  | "not_found"
  | "disabled"
  | "invalid_args"
  | "permission"
  | "cooldown"
  | "confirmation_required";

export interface ToolExecutionOutcome {
  status: "ok" | "error" | "denied";
  toolName: string;
  result?: ToolResultEnvelope;
  denialReason?: DenialReason;
  /** Human-readable summary suitable for showing the user. */
  message: string;
  latencyMs: number;
}

export interface ToolLogSink {
  log(entry: {
    toolName: string;
    toolCategory: string;
    guildId: string | null;
    channelId: string | null;
    userId: string | null;
    inputJson: JsonValue;
    outputJson: JsonValue | null;
    error: string | null;
    latencyMs: number;
    success: boolean;
  }): Promise<void>;
}

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  permissions: ToolPermissionService;
  cooldowns: ToolCooldownService;
  logger: Logger;
  /** Persisted tool logging (Prisma-backed); optional so the bot runs without a DB. */
  logSink?: ToolLogSink | null;
  defaultTimeoutMs?: number;
  /** When true, high/critical-risk tools additionally require confirmation. */
  safetyEnabled?: boolean;
}

export interface ExecuteOptions {
  /** True when the user already confirmed this exact call. */
  confirmed?: boolean;
  /** Origin of the call, for logs. */
  source?: "llm" | "command" | "api" | "synthetic";
}

/**
 * The single choke point for tool execution. Order of gates:
 *   exists → enabled → args valid (Zod) → permissions → cooldown →
 *   confirmation/risk gate → execute (with timeout) → log.
 *
 * Nothing — including the LLM — can run a tool without passing every gate.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly permissions: ToolPermissionService;
  private readonly cooldowns: ToolCooldownService;
  private readonly logger: Logger;
  private readonly logSink: ToolLogSink | null;
  private readonly defaultTimeoutMs: number;
  private readonly safetyEnabled: boolean;

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry;
    this.permissions = options.permissions;
    this.cooldowns = options.cooldowns;
    this.logger = options.logger;
    this.logSink = options.logSink ?? null;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.safetyEnabled = options.safetyEnabled ?? true;
  }

  requiresConfirmation(tool: RegisteredTool): boolean {
    if (tool.requiresConfirmation) return true;
    if (this.safetyEnabled && (tool.riskLevel === "high" || tool.riskLevel === "critical")) {
      return true;
    }
    return false;
  }

  async execute(
    name: string,
    rawArgs: unknown,
    ctx: ToolExecutionContext,
    options?: ExecuteOptions,
  ): Promise<ToolExecutionOutcome> {
    const started = Date.now();

    const validation = this.registry.validateToolCall(name, rawArgs);
    if (!validation.ok) {
      const denialReason: DenialReason = validation.tool
        ? validation.tool.enabled === false
          ? "disabled"
          : "invalid_args"
        : "not_found";
      return this.deny(name, validation.tool, rawArgs, ctx, denialReason, validation.error, started);
    }

    const { tool, args } = validation;

    const permission = this.permissions.check(tool, ctx.memberPermissions);
    if (!permission.allowed) {
      return this.deny(
        name,
        tool,
        rawArgs,
        ctx,
        "permission",
        `Missing required permission(s): ${permission.missing.join(", ")}`,
        started,
      );
    }

    const cooldown = await this.cooldowns.check(tool.name, ctx.userId);
    if (!cooldown.allowed) {
      const seconds = Math.ceil(cooldown.remainingMs / 1000);
      return this.deny(
        name,
        tool,
        rawArgs,
        ctx,
        "cooldown",
        `Tool "${tool.name}" is on cooldown for another ${seconds}s`,
        started,
      );
    }

    if (this.requiresConfirmation(tool) && !options?.confirmed) {
      return this.deny(
        name,
        tool,
        rawArgs,
        ctx,
        "confirmation_required",
        `Tool "${tool.name}" (risk: ${tool.riskLevel}) requires explicit user confirmation`,
        started,
      );
    }

    await this.cooldowns.markUsed(tool.name, ctx.userId, tool.cooldownSeconds ?? 0);

    let result: ToolResultEnvelope;
    try {
      // Args were validated by tool.argsSchema above; this is the one
      // documented type-erasure boundary (RegisteredTool stores `never` args).
      const exec = tool.execute as (a: unknown, c: ToolExecutionContext) => Promise<ToolResultEnvelope>;
      result = await withTimeout(
        exec(args, ctx),
        tool.timeoutMs ?? this.defaultTimeoutMs,
        `tool ${tool.name}`,
      );
    } catch (err) {
      result = toolFail(toErrorMessage(err));
    }

    const latencyMs = Date.now() - started;
    const outcome: ToolExecutionOutcome = result.ok
      ? { status: "ok", toolName: tool.name, result, message: `Tool ${tool.name} succeeded`, latencyMs }
      : {
          status: "error",
          toolName: tool.name,
          result,
          message: `Tool ${tool.name} failed: ${result.error}`,
          latencyMs,
        };

    this.logger[result.ok ? "info" : "warn"](
      { tool: tool.name, ok: result.ok, latencyMs, source: options?.source ?? "llm" },
      "tool executed",
    );
    await this.persistLog(tool, rawArgs, ctx, result, null, latencyMs);

    return outcome;
  }

  private async deny(
    name: string,
    tool: RegisteredTool | undefined,
    rawArgs: unknown,
    ctx: ToolExecutionContext,
    reason: DenialReason,
    message: string,
    started: number,
  ): Promise<ToolExecutionOutcome> {
    const latencyMs = Date.now() - started;
    this.logger.warn({ tool: name, reason, latencyMs }, "tool execution denied");
    if (tool) {
      await this.persistLog(tool, rawArgs, ctx, null, `${reason}: ${message}`, latencyMs);
    }
    return { status: "denied", toolName: name, denialReason: reason, message, latencyMs };
  }

  private async persistLog(
    tool: RegisteredTool,
    rawArgs: unknown,
    ctx: ToolExecutionContext,
    result: ToolResultEnvelope | null,
    error: string | null,
    latencyMs: number,
  ): Promise<void> {
    if (!this.logSink) return;
    try {
      await this.logSink.log({
        toolName: tool.name,
        toolCategory: tool.category,
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
        inputJson: toJsonValue(rawArgs),
        outputJson: result ? toJsonValue(result) : null,
        error: error ?? (result && !result.ok ? result.error : null),
        latencyMs,
        success: result?.ok ?? false,
      });
    } catch (err) {
      this.logger.warn({ err: toErrorMessage(err) }, "failed to persist tool log");
    }
  }
}
