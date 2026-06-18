import type { GuildSettings } from "../database/repositories/GuildRepository";
import type { RegisteredTool } from "../tools/ToolDefinition";

export interface TextChannelPolicyInput {
  guildId: string | null;
  channelId: string;
  isDM: boolean;
  settings?: GuildSettings | null;
}

export function isTextChannelAllowed(input: TextChannelPolicyInput): boolean {
  if (input.isDM || !input.guildId) return true;
  const allowChannels = normalizeStringList(input.settings?.allowChannels);
  return allowChannels.length === 0 || allowChannels.includes(input.channelId);
}

export function isToolDisabledByGuild(toolName: string, disabledTools?: readonly string[] | null): boolean {
  return normalizeToolNameSet(disabledTools).has(toolName.toLowerCase());
}

export function filterGuildDisabledTools<T extends Pick<RegisteredTool, "name">>(
  tools: T[],
  disabledTools?: readonly string[] | null,
): T[] {
  const disabled = normalizeToolNameSet(disabledTools);
  if (disabled.size === 0) return tools;
  return tools.filter((tool) => !disabled.has(tool.name.toLowerCase()));
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeToolNameSet(disabledTools?: readonly string[] | null): Set<string> {
  return new Set(normalizeStringList(disabledTools).map((name) => name.toLowerCase()));
}
