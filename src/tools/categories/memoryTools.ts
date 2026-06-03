import { z } from "zod";
import type { RegisteredTool } from "../ToolDefinition";
import { defineTool, toolFail, toolOk } from "../ToolDefinition";

/**
 * memory — tools that read/write the long-term memory system. They go through
 * ToolMemoryAccess (implemented by MemoryService), which applies MemoryPolicy:
 * even an explicit "remember" request is refused for secrets.
 */

const rememberFact = defineTool({
  name: "remember_fact",
  category: "memory",
  description:
    "Store a fact in long-term memory, e.g. a user preference or important server info. Scope USER remembers it about the requesting user; GUILD remembers it for the whole server.",
  examples: [
    "remember that I prefer to be called Lex",
    "remember my timezone is CET",
    "remember that this server's game night is Friday",
  ],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 3,
  argsSchema: z.object({
    content: z.string().min(3).max(1000),
    scope: z.enum(["USER", "GUILD", "CHANNEL"]).default("USER"),
  }),
  execute: async (args, ctx) => {
    if (!ctx.memory) return toolFail("Memory system is not enabled.");
    if (args.scope === "GUILD" && !ctx.guildId) {
      return toolFail("GUILD scope only works inside a server.");
    }
    const result = await ctx.memory.remember({
      content: args.content,
      scope: args.scope,
      userId: args.scope === "USER" ? ctx.userId : null,
      guildId: ctx.guildId,
      channelId: args.scope === "CHANNEL" ? ctx.channelId : null,
      explicit: true,
    });
    if (!result.stored) {
      return toolFail(`Not stored: ${result.reason}`);
    }
    return toolOk({ stored: true, memoryId: result.id, scope: args.scope, content: args.content });
  },
});

const recallMemory = defineTool({
  name: "recall_memory",
  category: "memory",
  description:
    "Search long-term memory for facts relevant to a query (the requesting user's memories plus this server's shared memories).",
  examples: ["what do you remember about me?", "recall my preferences", "what did I tell you about my project?"],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 3,
  argsSchema: z.object({
    query: z.string().min(2).max(300),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  execute: async (args, ctx) => {
    if (!ctx.memory) return toolFail("Memory system is not enabled.");
    const hits = await ctx.memory.search(
      args.query,
      { userId: ctx.userId, guildId: ctx.guildId, channelId: ctx.channelId },
      args.limit,
    );
    return toolOk({
      count: hits.length,
      memories: hits.map((h) => ({
        id: h.id,
        scope: h.scope,
        content: h.content,
        score: Math.round(h.score * 1000) / 1000,
      })),
    });
  },
});

const forgetMemory = defineTool({
  name: "forget_memory",
  category: "memory",
  description:
    "Delete a stored memory by its id (get ids from recall_memory). Users can delete their own memories; guild/global memories require ADMINISTRATOR.",
  examples: ["forget that memory", "delete the memory about my old username"],
  riskLevel: "medium",
  requiresConfirmation: false,
  cooldownSeconds: 3,
  argsSchema: z.object({
    memoryId: z.string().min(3),
  }),
  execute: async (args, ctx) => {
    if (!ctx.memory) return toolFail("Memory system is not enabled.");
    const isAdmin = ctx.memberPermissions.includes("ADMINISTRATOR");
    const result = await ctx.memory.forget(args.memoryId, { userId: ctx.userId, isAdmin });
    if (!result.deleted) return toolFail(`Not deleted: ${result.reason}`);
    return toolOk({ deleted: true, memoryId: args.memoryId });
  },
});

export const memoryTools: RegisteredTool[] = [rememberFact, recallMemory, forgetMemory];
