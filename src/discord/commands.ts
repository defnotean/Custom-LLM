import type { Logger } from "pino";
import type { GuildRepository, GuildSettings } from "../database/repositories/GuildRepository";
import type { BotMessageContext } from "../types/discord";
import type { StatsPayload, HealthPayload } from "../types/common";
import type { ToolRegistry } from "../tools/ToolRegistry";
import type { ToolExecutor } from "../tools/ToolExecutor";
import type { ToolExecutionContext, ToolMemoryAccess } from "../tools/ToolDefinition";
import type { DiscordVoiceService } from "./voice/DiscordVoiceService";
import { filterGuildDisabledTools, isToolDisabledByGuild, normalizeStringList } from "../guild/GuildPolicy";
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
  settingsStore?: Pick<GuildRepository, "getSettings" | "updateSettings"> | null;
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
  "`!ai settings show|allow-channel|disable-tool|enable-tool` - manage server policy (admin)",
  "`!ai voice status|policy|enable|disable|join|leave|say|listen|stop-speaking` — manage opt-in voice presence",
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
          const tools = filterGuildDisabledTools(services.registry.listByCategory(cat), ctx.guildSettings?.disabledTools);
          return `**${cat}** (${tools.length}): ${tools.map((t) => `\`${t.name}\``).join(", ")}`;
        });
        return [`Registered tools: ${services.registry.size}`, ...lines].join("\n");
      }

      case "tool": {
        if (!arg) return "Usage: `!ai tool <name>`";
        const tool = services.registry.getTool(arg);
        if (!tool) {
          const near = filterGuildDisabledTools(
            services.registry.searchTools(arg, { limit: 3 }),
            ctx.guildSettings?.disabledTools,
          );
          return `No tool named \`${arg}\`.${near.length > 0 ? ` Did you mean: ${near.map((t) => `\`${t.name}\``).join(", ")}?` : ""}`;
        }
        if (isToolDisabledByGuild(tool.name, ctx.guildSettings?.disabledTools)) {
          return `\`${tool.name}\` is disabled on this server.`;
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

      case "settings":
        return handleSettingsCommand(ctx, services, rest);

      case "voice": {
        if (!services.voice) return "Voice service is unavailable.";
        const [sub = "status", ...voiceRest] = rest;
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
          case "say": {
            const text = voiceRest.join(" ").trim();
            if (!text) return "Usage: `!ai voice say <text>`";
            return (await services.voice.say(ctx, text)).message;
          }
          case "listen": {
            const [action = "status"] = voiceRest;
            switch (action.toLowerCase()) {
              case "status":
                return (await services.voice.listenStatus(ctx)).message;
              case "enable":
              case "on":
              case "start":
                return (await services.voice.configureListening(ctx, true)).message;
              case "disable":
              case "off":
              case "stop":
                return (await services.voice.configureListening(ctx, false)).message;
              default:
                return "Usage: `!ai voice listen status|enable|disable`";
            }
          }
          case "stop-speaking":
          case "stop-speech":
            return (await services.voice.stopSpeaking(ctx)).message;
          default:
            return "Usage: `!ai voice status|policy|enable|disable|join|leave|say|listen|stop-speaking`";
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

async function handleSettingsCommand(
  ctx: BotMessageContext,
  services: CommandServices,
  args: string[],
): Promise<string> {
  if (!ctx.guildId) return "Settings commands only work in servers.";
  if (!canManageSettings(ctx)) return "Only administrators or server managers can change Irene settings.";
  if (!services.settingsStore) return "Guild settings persistence is unavailable because the database is not connected.";

  const [sub = "show", action = "", value = ""] = args;
  const settings = await services.settingsStore.getSettings(ctx.guildId);

  switch (sub.toLowerCase()) {
    case "":
    case "show":
    case "status":
      return formatGuildSettings(settings);

    case "allow-channel":
    case "allow-channels":
      return updateAllowChannels(ctx, services, settings, action, value);

    case "disable-tool":
      return updateDisabledTool(ctx, services, settings, action, true);

    case "enable-tool":
      return updateDisabledTool(ctx, services, settings, action, false);

    default:
      return SETTINGS_USAGE;
  }
}

const SETTINGS_USAGE =
  "Usage: `!ai settings show`, `!ai settings allow-channel add|remove [channel]`, `!ai settings allow-channel clear`, `!ai settings disable-tool <name>`, or `!ai settings enable-tool <name>`";

async function updateAllowChannels(
  ctx: BotMessageContext,
  services: CommandServices,
  settings: GuildSettings,
  action: string,
  value: string,
): Promise<string> {
  const normalizedAction = action.toLowerCase();
  if (!["add", "remove", "clear"].includes(normalizedAction)) return SETTINGS_USAGE;

  if (normalizedAction === "clear") {
    const next = { ...settings, allowChannels: [] };
    await services.settingsStore?.updateSettings(ctx.guildId as string, next, ctx.guildName ?? undefined);
    ctx.guildSettings = next;
    return "Text allowlist cleared; Irene may respond in all text channels for this server.";
  }

  const channelId = parseChannelId(value || "current", ctx.channelId);
  if (!channelId) return "Give a channel id, channel mention, or `current`.";

  const current = normalizeStringList(settings.allowChannels);
  const nextAllowChannels =
    normalizedAction === "add" ? unique([...current, channelId]) : current.filter((id) => id !== channelId);
  const next = { ...settings, allowChannels: nextAllowChannels };
  await services.settingsStore?.updateSettings(ctx.guildId as string, next, ctx.guildName ?? undefined);
  ctx.guildSettings = next;

  return normalizedAction === "add"
    ? `Text allowlist now includes <#${channelId}>.`
    : `Text allowlist no longer includes <#${channelId}>.${nextAllowChannels.length === 0 ? " Irene may respond in all text channels." : ""}`;
}

async function updateDisabledTool(
  ctx: BotMessageContext,
  services: CommandServices,
  settings: GuildSettings,
  toolName: string,
  disable: boolean,
): Promise<string> {
  const normalizedToolName = toolName.trim().toLowerCase();
  if (!normalizedToolName) return SETTINGS_USAGE;
  const tool = services.registry.getTool(normalizedToolName);
  if (!tool) return `No tool named \`${normalizedToolName}\`.`;

  const current = normalizeStringList(settings.disabledTools).map((name) => name.toLowerCase());
  const nextDisabledTools = disable ? unique([...current, tool.name]) : current.filter((name) => name !== tool.name);
  const next = { ...settings, disabledTools: nextDisabledTools };
  await services.settingsStore?.updateSettings(ctx.guildId as string, next, ctx.guildName ?? undefined);
  ctx.guildSettings = next;

  return disable ? `\`${tool.name}\` is disabled for this server.` : `\`${tool.name}\` is enabled for this server.`;
}

function formatGuildSettings(settings: GuildSettings): string {
  const allowChannels = normalizeStringList(settings.allowChannels);
  const disabledTools = normalizeStringList(settings.disabledTools);
  return [
    "**Irene server settings**",
    `Text channels: ${allowChannels.length > 0 ? allowChannels.map((id) => `<#${id}>`).join(", ") : "all channels"}`,
    `Disabled tools: ${disabledTools.length > 0 ? disabledTools.map((name) => `\`${name}\``).join(", ") : "none"}`,
  ].join("\n");
}

function parseChannelId(input: string, currentChannelId: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === "current") return currentChannelId;
  const mention = /^<#(\d+)>$/.exec(trimmed);
  if (mention?.[1]) return mention[1];
  if (/^\d{2,32}$/.test(trimmed)) return trimmed;
  return null;
}

function canManageSettings(ctx: BotMessageContext): boolean {
  return ctx.memberPermissions.some((permission) => ["ADMINISTRATOR", "MANAGE_GUILD"].includes(permission));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
