import type { z } from "zod";
import type { Client, Message } from "discord.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";
import type { JsonValue } from "../types/common";
import type { MemoryHit, MemoryScopeName } from "../types/ai";

/** Risk classification drives confirmation gates and safety checks. */
export type ToolRiskLevel = "low" | "medium" | "high" | "critical";

/** Structured result envelope every tool must return. */
export interface ToolSuccess {
  ok: true;
  data: JsonValue;
}

export interface ToolFailure {
  ok: false;
  error: string;
  details?: JsonValue;
}

export type ToolResultEnvelope = ToolSuccess | ToolFailure;

export function toolOk(data: JsonValue): ToolSuccess {
  return { ok: true, data };
}

export function toolFail(error: string, details?: JsonValue): ToolFailure {
  return details === undefined ? { ok: false, error } : { ok: false, error, details };
}

/**
 * Minimal structural interface tools use to access memory. MemoryService
 * satisfies this; keeping it local avoids a tools→memory import cycle and
 * lets tests pass simple fakes.
 */
export interface ToolMemoryAccess {
  remember(input: {
    content: string;
    scope?: MemoryScopeName;
    userId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    importance?: number;
    explicit?: boolean;
  }): Promise<{ id: string | null; stored: boolean; reason: string }>;
  search(
    query: string,
    ctx: { userId: string; guildId: string | null; channelId: string },
    topK?: number,
  ): Promise<MemoryHit[]>;
  forget(
    id: string,
    requester: { userId: string; isAdmin: boolean },
  ): Promise<{ deleted: boolean; reason: string }>;
}

/** Everything a tool gets at execution time. */
export interface ToolExecutionContext {
  guildId: string | null;
  channelId: string;
  userId: string;
  /** Normalized UPPER_SNAKE Discord permission names of the invoking member. */
  memberPermissions: readonly string[];
  /** Raw Discord message — present for message-triggered executions. */
  disabledTools?: readonly string[];
  message?: Message;
  discordClient?: Client;
  logger: Logger;
  db?: PrismaClient | null;
  memory?: ToolMemoryAccess | null;
}

/**
 * The core tool contract. `argsSchema` is the single source of truth for
 * argument validation — the executor refuses to run a tool on args that do
 * not parse. Descriptions/examples double as routing documents (ToolRouter)
 * and prompt material, so write them like search content.
 */
export interface ToolDefinition<TArgs = unknown, TResult extends ToolResultEnvelope = ToolResultEnvelope> {
  /** snake_case unique name, e.g. "timeout_user". */
  name: string;
  /** Category for routing/listing, e.g. "moderation". */
  category: string;
  description: string;
  /** Natural-language invocation examples — used by the router for matching. */
  examples?: string[];
  riskLevel: ToolRiskLevel;
  requiresConfirmation: boolean;
  /** UPPER_SNAKE Discord permissions the *member* must hold. */
  requiredDiscordPermissions?: string[];
  cooldownSeconds?: number;
  /** Per-tool execution timeout (default applied by the executor). */
  timeoutMs?: number;
  /** Disabled tools stay registered but are never routed or executed. */
  enabled?: boolean;
  argsSchema: z.ZodType<TArgs>;
  execute: (args: TArgs, context: ToolExecutionContext) => Promise<TResult>;
}

/**
 * Type-erased form stored in the registry. `execute` takes `never` so any
 * concrete ToolDefinition assigns to it; the executor performs the single,
 * documented cast after Zod validation (see ToolExecutor).
 */
export interface RegisteredTool {
  name: string;
  category: string;
  description: string;
  examples?: string[];
  riskLevel: ToolRiskLevel;
  requiresConfirmation: boolean;
  requiredDiscordPermissions?: string[];
  cooldownSeconds?: number;
  timeoutMs?: number;
  enabled?: boolean;
  argsSchema: z.ZodTypeAny;
  execute: (args: never, context: ToolExecutionContext) => Promise<ToolResultEnvelope>;
}

/** Identity helper that preserves inference from the Zod schema. */
export function defineTool<TSchema extends z.ZodTypeAny, TResult extends ToolResultEnvelope>(
  def: Omit<ToolDefinition<z.infer<TSchema>, TResult>, "argsSchema" | "execute"> & {
    argsSchema: TSchema;
    execute: (args: z.infer<TSchema>, context: ToolExecutionContext) => Promise<TResult>;
  },
): ToolDefinition<z.infer<TSchema>, TResult> {
  return def;
}
