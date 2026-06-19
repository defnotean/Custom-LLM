import { ChannelType, type Client, type Message } from "discord.js";
import {
  makeRecentTurn,
  type RecentConversationWindow,
} from "../../state/RecentConversationWindow";
import type { BotMessageContext } from "../../types/discord";
import { memberPermissionNames } from "./permissions";

/** Build the normalized BotMessageContext from a raw discord.js message. */
export function buildMessageContext(message: Message, strippedContent: string): BotMessageContext {
  const isDM = message.channel.type === ChannelType.DM;
  const channelName =
    "name" in message.channel && typeof message.channel.name === "string"
      ? message.channel.name
      : null;

  return {
    guildId: message.guildId,
    guildName: message.guild?.name ?? null,
    channelId: message.channelId,
    channelName,
    userId: message.author.id,
    username: message.author.username,
    displayName: message.member?.displayName ?? message.author.displayName ?? null,
    messageId: message.id,
    content: strippedContent,
    isDM,
    mentionsBot: message.client.user ? message.mentions.has(message.client.user) : false,
    memberPermissions: isDM
      ? ["SEND_MESSAGES"] // DMs: no guild permissions; moderation tools self-guard on guild presence
      : memberPermissionNames(message.member),
    raw: message,
  };
}

/**
 * Fetch a short recent-history transcript for conversational context.
 * Best-effort: returns null on any failure. The runtime window is preferred
 * because it covers slash commands and can be Redis-backed across replicas;
 * Discord history remains the fallback for cold starts.
 */
export async function buildRecentTranscript(
  message: Message,
  client: Client,
  options: { limit?: number; window?: RecentConversationWindow | null } = {},
): Promise<string | null> {
  const limit = options.limit ?? 8;
  const windowTranscript = await readWindowTranscript(options.window ?? null, message.channelId, limit);
  if (windowTranscript) return windowTranscript;

  try {
    if (!message.channel.isTextBased()) return null;
    const messages = await message.channel.messages.fetch({ limit: limit + 1 });
    const botId = client.user?.id;
    const lines = [...messages.values()]
      .filter((m) => m.id !== message.id && m.content.trim().length > 0)
      .reverse()
      .slice(-limit)
      .map((m) => {
        const name = m.author.id === botId ? "you (the assistant)" : m.author.username;
        return `[${name}]: ${m.content.slice(0, 280)}`;
      });
    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

export async function buildRecentTranscriptForChannel(
  channelId: string,
  window: RecentConversationWindow | null | undefined,
  limit = 8,
): Promise<string | null> {
  return readWindowTranscript(window ?? null, channelId, limit);
}

export async function recordHandledConversationTurn(
  ctx: BotMessageContext,
  assistantReply: string,
  window: RecentConversationWindow | null | undefined,
): Promise<void> {
  if (!window) return;
  const createdAt = new Date();
  try {
    await window.append(ctx.channelId, [
      makeRecentTurn({
        id: ctx.messageId,
        role: "user",
        channelId: ctx.channelId,
        userId: ctx.userId,
        username: ctx.username,
        content: ctx.content,
        createdAt,
      }),
      makeRecentTurn({
        id: `${ctx.messageId}:assistant`,
        role: "assistant",
        channelId: ctx.channelId,
        userId: null,
        username: "Irene",
        content: assistantReply,
        createdAt,
      }),
    ]);
  } catch {
    return;
  }
}

async function readWindowTranscript(
  window: RecentConversationWindow | null,
  channelId: string,
  limit: number,
): Promise<string | null> {
  if (!window) return null;
  try {
    return await window.transcript(channelId, limit);
  } catch {
    return null;
  }
}
