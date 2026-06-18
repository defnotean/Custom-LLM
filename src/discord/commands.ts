import type { Logger } from "pino";
import type { BotMessageContext } from "../types/discord";
import type { StatsPayload, HealthPayload } from "../types/common";
import type { ToolRegistry } from "../tools/ToolRegistry";
import type { ToolExecutor } from "../tools/ToolExecutor";
import type { ToolExecutionContext, ToolMemoryAccess } from "../tools/ToolDefinition";
import type { DiscordVoiceService } from "./voice/DiscordVoiceService";
import { toErrorMessage } from "../utils/errors";

/**
 * `!ai <command>` prefix commands — a deterministic ops/debug surface that
 * bypasses the LLM. Services arrive as optional structural deps so the
 * command set works in every phase of the boot (no DB? stats degrade, etc).
 */

export interface ExportSummary {
  files: Array<{ path: string; lines: number }>;
  totalExamples: number;
}

export interface CommandServices {
  registry: ToolRegistry;
  executor: ToolExecutor;
  buildToolContext: (ctx: BotMessageContext) => ToolExecutionContext;
  memory?: ToolMemoryAccess | null;
  voice?: DiscordVoiceService | null;
  exporter?: { exportAll(outDir: string): Promise<ExportSummary> } | null;
  stats?: (() => Promise<StatsPayload>) | null;
  health?: (() => Promise<HealthPayload>) | null;
  logger: Logger;
}

const HELP_TEXT = [
  "**Commands:**",
  "`!ai ping` — run the ping tool",
  "`!ai tools` — list registered tools by category",
  "`!ai tool <name>` — show one tool's details",
  "`!ai memory recall <query>` — search stored memories",
  "`!ai memory remember <text>` — store a memory",
  "`!ai voice status|policy|enable|disable|join|leave` — manage opt-in voice presence",
  "`!ai export-training` — export training datasets (admin)",
  "`!ai stats` — runtime statistics",
  "`!ai health` — health summary",
  "`!ai help` — this message",
  "",
  "Or just mention me / DM me to chat.",
].join("\n");

export async function handleCommand(
  ctx: BotMessageContext,
  services: CommandServices,
): Promise<string> {
  const [command = "", ...rest] = ctx.content.trim().split(/\s+/);
  const arg = rest.join(" ").trim();

  try {
    switch (command.toLowerCase()) {
      case "":
      case "help":
        return HELP_TEXT;

      case "ping": {
        const outcome = await services.executor.execute(
          "ping",
          {},
          services.buildToolContext(ctx),
          { confirmed: false, source: "command" },
        );
        if (outcome.result?.ok) {
          return `🏓 pong (tool round-trip ${outcome.latencyMs}ms)`;
        }
        return `ping failed: ${outcome.message}`;
      }

      case "tools": {
        const categories = services.registry.categories();
        const lines = categories.map((cat) => {
          const tools = services.registry.listByCategory(cat);
          return `**${cat}** (${tools.length}): ${tools.map((t) => `\`${t.name}\``).join(", ")}`;
        });
        return [`Registered tools: ${services.registry.size}`, ...lines].join("\n");
      }

      case "tool": {
        if (!arg) return "Usage: `!ai tool <name>`";
        const tool = services.registry.getTool(arg);
        if (!tool) {
          const near = services.registry.searchTools(arg, { limit: 3 });
          return `No tool named \`${arg}\`.${near.length > 0 ? ` Did you mean: ${near.map((t) => `\`${t.name}\``).join(", ")}?` : ""}`;
        }
        const meta = services.registry
          .exportToolMetadata()
          .find((m) => m.name === tool.name);
        return [
          `**${tool.name}** (${tool.category})`,
          tool.description,
          `Risk: ${tool.riskLevel} · Confirmation: ${tool.requiresConfirmation ? "yes" : "no"} · Cooldown: ${tool.cooldownSeconds ?? 0}s`,
          tool.requiredDiscordPermissions?.length
            ? `Requires: ${tool.requiredDiscordPermissions.join(", ")}`
            : null,
          meta ? `Args: \`${JSON.stringify(meta.argsShape)}\`` : null,
          tool.examples?.length ? `Examples: ${tool.examples.map((e) => `"${e}"`).join(" · ")}` : null,
        ]
          .filter((l): l is string => l !== null)
          .join("\n");
      }

      case "memory": {
        if (!services.memory) return "Memory system is not enabled (set MEMORY_ENABLED=true).";
        const [sub = "", ...memRest] = rest;
        const memArg = memRest.join(" ").trim();
        if (sub === "recall") {
          if (!memArg) return "Usage: `!ai memory recall <query>`";
          const hits = await services.memory.search(
            memArg,
            { userId: ctx.userId, guildId: ctx.guildId, channelId: ctx.channelId },
            5,
          );
          if (hits.length === 0) return "No matching memories.";
          return hits
            .map((h) => `• [${h.scope.toLowerCase()}] ${h.content} *(id: ${h.id}, score ${h.score.toFixed(2)})*`)
            .join("\n");
        }
        if (sub === "remember") {
          if (!memArg) return "Usage: `!ai memory remember <text>`";
          const result = await services.memory.remember({
            content: memArg,
            scope: "USER",
            userId: ctx.userId,
            guildId: ctx.guildId,
            channelId: ctx.channelId,
            explicit: true,
          });
          return result.stored
            ? `Got it — remembered. *(id: ${result.id})*`
            : `Not stored: ${result.reason}`;
        }
        return "Usage: `!ai memory recall <query>` or `!ai memory remember <text>`";
      }

      case "voice": {
        if (!services.voice) return "Voice service is unavailable.";
        const [sub = "status"] = rest;
        switch (sub.toLowerCase()) {
          case "status":
            return services.voice.status(ctx).message;
          case "policy":
            return (await services.voice.describeCurrentPolicy(ctx)).message;
          case "enable":
            return (await services.voice.enableCurrentChannel(ctx)).message;
          case "disable":
            return (await services.voice.disableGuild(ctx)).message;
          case "join":
            return (await services.voice.joinCurrentChannel(ctx)).message;
          case "leave":
            return services.voice.leaveGuild(ctx).message;
          default:
            return "Usage: `!ai voice status|policy|enable|disable|join|leave`";
        }
      }

      case "export-training": {
        if (!services.exporter) return "Training export unavailable (database not connected).";
        if (!ctx.memberPermissions.includes("ADMINISTRATOR") && !ctx.isDM) {
          return "Only administrators can run a training export.";
        }
        const summary = await services.exporter.exportAll("exports/training");
        const fileLines = summary.files.map((f) => `• \`${f.path}\` (${f.lines} lines)`);
        return [`Exported ${summary.totalExamples} training examples:`, ...fileLines].join("\n");
      }

      case "stats": {
        if (!services.stats) return "Stats unavailable.";
        const s = await services.stats();
        return [
          `Uptime: ${Math.floor(s.uptimeSec / 60)}m · Tools: ${s.registry.tools} in ${s.registry.categories.length} categories`,
          `LLM: ${s.llm.provider} (${s.llm.model})`,
          s.learning?.enabled
            ? `Learning: items ${s.learning.learnedItems} · queued ${s.learning.queuedItems} · trained ${s.learning.trainedItems} · active params ${s.learning.activeParamsPerRequest}`
            : "Learning: persistence disabled",
          s.db.available
            ? `DB: conversations ${s.db.conversations ?? 0} · tool logs ${s.db.toolLogs ?? 0} · training examples ${s.db.trainingExamples ?? 0} · memories ${s.db.memories ?? 0}`
            : "DB: not connected (persistence disabled)",
        ].join("\n");
      }

      case "health": {
        if (!services.health) return "Health check unavailable.";
        const h = await services.health();
        return [
          `Status: **${h.status}** · uptime ${Math.floor(h.uptimeSec / 60)}m`,
          `Discord: ${h.discord.connected ? "connected" : "disconnected"}`,
          `LLM: ${h.llm.provider} → ${h.llm.baseUrl} (${h.llm.model})`,
          `DB: ${h.database.available ? "ok" : "unavailable"} · Memory: ${h.memory.enabled ? h.memory.store : "disabled"}`,
        ].join("\n");
      }

      default:
        return `Unknown command \`${command}\`. ${HELP_TEXT}`;
    }
  } catch (err) {
    services.logger.error({ err: toErrorMessage(err), command }, "command failed");
    return `Command failed: ${toErrorMessage(err)}`;
  }
}
