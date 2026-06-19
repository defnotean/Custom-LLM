import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { RegisteredTool } from "../ToolDefinition";
import { defineTool, toolFail, toolOk } from "../ToolDefinition";
import { toErrorMessage } from "../../utils/errors";
import { toJsonValue } from "../../types/common";

interface ChannelSummaryAuthor {
  username?: string | null;
  displayName?: string | null;
  globalName?: string | null;
  id?: string | null;
}

export interface ChannelSummaryMessage {
  content?: string | null;
  createdAt?: Date | string | number | null;
  author?: ChannelSummaryAuthor | null;
}

export interface ChannelMessageHighlight {
  author: string;
  content: string;
  createdAt: string | null;
}

export interface ChannelRecentMessageSummary {
  summary: string;
  messageCount: number;
  textMessageCount: number;
  participants: string[];
  timeframe: { start: string | null; end: string | null };
  keyTopics: string[];
  highlights: ChannelMessageHighlight[];
  transcript: string;
}

interface NormalizedChannelMessage {
  author: string;
  content: string;
  createdAt: string | null;
  index: number;
}

const SUMMARY_CONTENT_LIMIT = 240;
const TRANSCRIPT_MESSAGE_LIMIT = 300;
const TRANSCRIPT_CHAR_LIMIT = 6_000;
const DEFAULT_HIGHLIGHT_LIMIT = 6;

const HIGHLIGHT_TERMS = [
  "blocked",
  "bug",
  "deploy",
  "error",
  "fix",
  "issue",
  "need",
  "plan",
  "please",
  "remember",
  "subq",
  "tool",
  "todo",
  "voice",
];

const TOPIC_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "but",
  "can",
  "did",
  "for",
  "from",
  "get",
  "had",
  "has",
  "have",
  "her",
  "here",
  "him",
  "his",
  "how",
  "into",
  "just",
  "last",
  "like",
  "more",
  "not",
  "now",
  "our",
  "out",
  "she",
  "should",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "was",
  "were",
  "what",
  "when",
  "will",
  "with",
  "you",
  "your",
]);

export function buildChannelRecentMessagesSummary(
  messages: Iterable<ChannelSummaryMessage>,
  options: { maxHighlights?: number; transcriptCharLimit?: number } = {},
): ChannelRecentMessageSummary {
  const allMessages = [...messages];
  const normalized = allMessages
    .map((message, index) => normalizeChannelMessage(message, index))
    .filter((message): message is NormalizedChannelMessage => message !== null);

  const participants = [...new Set(normalized.map((message) => message.author))];
  const timeframe = {
    start: normalized[0]?.createdAt ?? null,
    end: normalized[normalized.length - 1]?.createdAt ?? null,
  };
  const keyTopics = extractKeyTopics(normalized);
  const highlights = selectHighlights(normalized, options.maxHighlights ?? DEFAULT_HIGHLIGHT_LIMIT);
  const transcript = normalized
    .map((message) => `[${message.author}]: ${truncate(message.content, TRANSCRIPT_MESSAGE_LIMIT)}`)
    .join("\n")
    .slice(0, options.transcriptCharLimit ?? TRANSCRIPT_CHAR_LIMIT);

  return {
    summary: buildSummaryText({
      fetchedCount: allMessages.length,
      textCount: normalized.length,
      participants,
      keyTopics,
      highlights,
      timeframe,
    }),
    messageCount: allMessages.length,
    textMessageCount: normalized.length,
    participants,
    timeframe,
    keyTopics,
    highlights,
    transcript,
  };
}

/** Discord tools that interact with Discord beyond the current reply. */

const sendMessage = defineTool({
  name: "send_message",
  category: "discord",
  description:
    "Send a message to a channel (current channel by default). Use for announcements or posting to another channel the user names.",
  examples: ["post 'meeting at 5' in #general", "send a message to the announcements channel"],
  riskLevel: "medium",
  requiresConfirmation: false,
  requiredDiscordPermissions: ["SEND_MESSAGES"],
  cooldownSeconds: 5,
  argsSchema: z.object({
    content: z.string().min(1).max(1800),
    channelId: z.string().optional(),
  }),
  execute: async (args, ctx) => {
    const client = ctx.discordClient ?? ctx.message?.client;
    if (!client) return toolFail("Discord client unavailable in this context.");
    try {
      const channelId = args.channelId ?? ctx.channelId;
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        return toolFail(`Channel ${channelId} is not a sendable text channel.`);
      }
      const sent = await channel.send(args.content);
      return toolOk({ sent: true, messageId: sent.id, channelId });
    } catch (err) {
      return toolFail(`Send failed: ${toErrorMessage(err)}`);
    }
  },
});

const summarizeChannelRecentMessages = defineTool({
  name: "summarize_channel_recent_messages",
  category: "discord",
  description:
    "Fetch recent channel messages and return a deterministic recap with participants, key topics, highlights, timeframe, and a capped transcript for verification.",
  examples: ["summarize the last 20 messages", "what did I miss in this channel?", "catch me up"],
  riskLevel: "low",
  requiresConfirmation: false,
  requiredDiscordPermissions: ["READ_MESSAGE_HISTORY"],
  cooldownSeconds: 15,
  argsSchema: z.object({
    channelId: z.string().optional(),
    limit: z.number().int().min(5).max(50).default(20),
  }),
  execute: async (args, ctx) => {
    const client = ctx.discordClient ?? ctx.message?.client;
    if (!client) return toolFail("Discord client unavailable in this context.");
    try {
      const channelId = args.channelId ?? ctx.channelId;
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        return toolFail(`Channel ${channelId} is not a readable text channel.`);
      }
      const messages = await channel.messages.fetch({ limit: args.limit });
      const summary = buildChannelRecentMessagesSummary([...messages.values()].reverse());
      return toolOk(toJsonValue({
        channelId,
        messageCount: messages.size,
        textMessageCount: summary.textMessageCount,
        summary: summary.summary,
        participants: summary.participants,
        timeframe: summary.timeframe,
        keyTopics: summary.keyTopics,
        highlights: summary.highlights,
        transcript: summary.transcript,
        note: "Deterministic recap generated by the tool; use the capped transcript only to verify details.",
      }));
    } catch (err) {
      return toolFail(`Fetch failed: ${toErrorMessage(err)}`);
    }
  },
});

const getGuildStats = defineTool({
  name: "get_guild_stats",
  category: "discord",
  description:
    "Get statistics for the current server: members, channels, roles, emojis, boost count, plus Irene-observed activity from the conversation log when persistence is available.",
  examples: ["server stats", "how active is this server?", "guild statistics"],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 15,
  argsSchema: z.object({}),
  execute: async (_args, ctx) => {
    const guild = ctx.message?.guild;
    if (!guild) return toolFail("get_guild_stats only works inside a server.");
    const observedActivity = await readObservedGuildActivity(ctx.db, guild.id);
    return toolOk({
      name: guild.name,
      members: guild.memberCount,
      channels: guild.channels.cache.size,
      roles: guild.roles.cache.size,
      emojis: guild.emojis.cache.size,
      boosts: guild.premiumSubscriptionCount ?? 0,
      createdAt: guild.createdAt.toISOString(),
      observedActivity,
    });
  },
});

export const discordTools: RegisteredTool[] = [
  sendMessage,
  summarizeChannelRecentMessages,
  getGuildStats,
];

const ACTIVITY_WINDOW_HOURS = 24;

async function readObservedGuildActivity(db: PrismaClient | null | undefined, guildId: string) {
  if (!db) {
    return {
      available: false,
      source: "conversation_log",
      reason: "database unavailable; activity metrics require persisted conversation logs",
      windowHours: ACTIVITY_WINDOW_HOURS,
      observedConversations: null,
      observedConversationsPerDay: null,
      activeUsers: null,
      activeChannels: null,
      sampledConversationRows: null,
      lastObservedAt: null,
      note: "Activity reflects conversations Irene observed and logged, not total Discord server traffic.",
    };
  }

  const since = new Date(Date.now() - ACTIVITY_WINDOW_HOURS * 60 * 60 * 1000);
  const where = { guildId, createdAt: { gte: since } };
  const [conversationCount, rows] = await Promise.all([
    db.conversation.count({ where }),
    db.conversation.findMany({
      where,
      select: { userId: true, channelId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 5_000,
    }),
  ]);

  const activeUsers = new Set(rows.map((row) => row.userId)).size;
  const activeChannels = new Set(rows.map((row) => row.channelId)).size;
  const latest = rows[0]?.createdAt;

  return {
    available: true,
    source: "conversation_log",
    reason: null,
    windowHours: ACTIVITY_WINDOW_HOURS,
    observedConversations: conversationCount,
    observedConversationsPerDay: conversationCount,
    activeUsers,
    activeChannels,
    sampledConversationRows: rows.length,
    lastObservedAt: latest ? latest.toISOString() : null,
    note: "Activity reflects conversations Irene observed and logged, not total Discord server traffic.",
  };
}

function normalizeChannelMessage(message: ChannelSummaryMessage, index: number): NormalizedChannelMessage | null {
  const content = normalizeWhitespace(message.content ?? "");
  if (!content) return null;
  return {
    author: normalizeAuthor(message.author),
    content: truncate(content, SUMMARY_CONTENT_LIMIT),
    createdAt: normalizeTimestamp(message.createdAt),
    index,
  };
}

function normalizeAuthor(author: ChannelSummaryAuthor | null | undefined): string {
  const displayName = normalizeWhitespace(author?.displayName ?? "");
  if (displayName) return displayName;
  const globalName = normalizeWhitespace(author?.globalName ?? "");
  if (globalName) return globalName;
  const username = normalizeWhitespace(author?.username ?? "");
  if (username) return username;
  return author?.id ? `user:${author.id}` : "unknown";
}

function normalizeTimestamp(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function extractKeyTopics(messages: NormalizedChannelMessage[]): string[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const words = message.content.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [];
    for (const word of words) {
      const token = word.replace(/^'+|'+$/g, "");
      if (token.length < 3 || /^\d+$/.test(token) || TOPIC_STOP_WORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([word]) => word);
}

function selectHighlights(messages: NormalizedChannelMessage[], maxHighlights: number): ChannelMessageHighlight[] {
  if (messages.length === 0 || maxHighlights <= 0) return [];
  return messages
    .map((message) => ({ message, score: scoreHighlight(message, messages.length) }))
    .sort((left, right) => right.score - left.score || right.message.index - left.message.index)
    .slice(0, Math.min(maxHighlights, messages.length))
    .map(({ message }) => message)
    .sort((left, right) => left.index - right.index)
    .map((message) => ({
      author: message.author,
      content: message.content,
      createdAt: message.createdAt,
    }));
}

function scoreHighlight(message: NormalizedChannelMessage, messageCount: number): number {
  const content = message.content.toLowerCase();
  const recency = messageCount > 1 ? message.index / (messageCount - 1) : 1;
  let score = recency;
  if (content.includes("?")) score += 2;
  if (content.includes("@")) score += 0.5;
  if (content.length >= 80) score += 0.5;
  for (const term of HIGHLIGHT_TERMS) {
    if (content.includes(term)) score += 1;
  }
  return score;
}

function buildSummaryText(input: {
  fetchedCount: number;
  textCount: number;
  participants: string[];
  keyTopics: string[];
  highlights: ChannelMessageHighlight[];
  timeframe: { start: string | null; end: string | null };
}): string {
  if (input.textCount === 0) {
    return `Fetched ${input.fetchedCount} recent messages, but none contained text content to summarize.`;
  }

  const messageNoun = input.textCount === 1 ? "message" : "messages";
  const topicText = input.keyTopics.length > 0 ? ` Key topics: ${input.keyTopics.join(", ")}.` : "";
  const highlightText =
    input.highlights.length > 0
      ? ` Highlights: ${input.highlights.map((highlight) => `${highlight.author}: ${highlight.content}`).join(" | ")}.`
      : "";

  return (
    `Summarized ${input.textCount} text ${messageNoun} from ` +
    `${formatCount(input.participants.length, "participant")}${formatTimeframe(input.timeframe)}.` +
    topicText +
    highlightText
  );
}

function formatCount(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function formatTimeframe(timeframe: { start: string | null; end: string | null }): string {
  if (timeframe.start && timeframe.end && timeframe.start !== timeframe.end) {
    return ` between ${timeframe.start} and ${timeframe.end}`;
  }
  if (timeframe.start) return ` at ${timeframe.start}`;
  return "";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}
