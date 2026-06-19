import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { LLMProvider } from "../../ai/llm/LLMProvider";
import type { ActiveConversationChannel } from "../../database/repositories/ConversationRepository";
import type { LearnedItem } from "../../learning/LiveLearningRegistry";
import type { RememberInput, RememberResult } from "../../memory/MemoryService";
import type { JsonObject } from "../../types/common";
import { toErrorMessage } from "../../utils/errors";
import type { JobQueue } from "../queue";

const SUMMARY_SOURCE = "channel_summary";
const DEFAULT_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SCHEDULE_MS = 60 * 60 * 1000;
const DEFAULT_CHANNEL_LIMIT = 25;
const DEFAULT_CONVERSATION_LIMIT = 30;
const DEFAULT_MIN_CONVERSATIONS = 4;
const DEFAULT_TRANSCRIPT_MAX_CHARS = 12_000;

const processLocalFingerprints = new Set<string>();

export interface ConversationSummaryTurn {
  id: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  userMessage: string;
  assistantResponse: string | null;
  createdAt: Date | string;
}

export interface ConversationSummarySource {
  listActiveChannelsSince(since: Date, limit?: number): Promise<ActiveConversationChannel[]>;
  listRecentByChannel(channelId: string, limit?: number): Promise<ConversationSummaryTurn[]>;
}

export interface MemorySummarySink {
  remember(input: RememberInput): Promise<RememberResult>;
}

export interface MemorySummaryLedger {
  findLearnedItemByMetadata(source: string, key: string, value: string): Promise<LearnedItem | null>;
}

export interface MemorySummarizerPayload {
  reason: string;
  lookbackMs?: number;
  channelLimit?: number;
  conversationLimit?: number;
  minConversations?: number;
}

export interface MemorySummarizerDeps {
  conversations?: ConversationSummarySource | null;
  memory?: MemorySummarySink | null;
  learning?: MemorySummaryLedger | null;
  llm?: LLMProvider | null;
  logger: Logger;
  now?: () => Date;
  scheduleMs?: number;
  lookbackMs?: number;
  channelLimit?: number;
  conversationLimit?: number;
  minConversations?: number;
  transcriptMaxChars?: number;
}

export interface MemorySummaryChannelResult {
  channelId: string;
  guildId: string | null;
  conversationCount: number;
  status: "summarized" | "skipped";
  reason?: string;
  memoryId?: string | null;
  learnedItemId?: string;
  summaryFingerprint?: string;
}

export interface MemorySummaryReport {
  status: "summarized" | "skipped";
  reason: string;
  channelsScanned: number;
  summariesWritten: number;
  channels: MemorySummaryChannelResult[];
}

export function registerMemorySummarizerWorker(queue: JobQueue, deps: MemorySummarizerDeps): void {
  queue.process<MemorySummarizerPayload>("memory:summarize", async (payload) => {
    const report = await summarizeRecentChannelConversations({
      ...deps,
      lookbackMs: payload.lookbackMs ?? deps.lookbackMs,
      channelLimit: payload.channelLimit ?? deps.channelLimit,
      conversationLimit: payload.conversationLimit ?? deps.conversationLimit,
      minConversations: payload.minConversations ?? deps.minConversations,
    });
    deps.logger.info(
      {
        reason: payload.reason,
        status: report.status,
        channelsScanned: report.channelsScanned,
        summariesWritten: report.summariesWritten,
      },
      "memory summarizer tick complete",
    );
  });

  const scheduleMs = deps.scheduleMs ?? DEFAULT_SCHEDULE_MS;
  if (scheduleMs > 0) {
    queue.every("memory:summarize", { reason: "scheduled" }, scheduleMs);
  }
}

export async function summarizeRecentChannelConversations(deps: MemorySummarizerDeps): Promise<MemorySummaryReport> {
  if (!deps.conversations) return skippedReport("conversation repository unavailable");
  if (!deps.memory) return skippedReport("memory service unavailable");

  const now = deps.now?.() ?? new Date();
  const lookbackMs = deps.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const channelLimit = deps.channelLimit ?? DEFAULT_CHANNEL_LIMIT;
  const conversationLimit = deps.conversationLimit ?? DEFAULT_CONVERSATION_LIMIT;
  const minConversations = deps.minConversations ?? DEFAULT_MIN_CONVERSATIONS;
  const since = new Date(now.getTime() - lookbackMs);

  const activeChannels = await deps.conversations.listActiveChannelsSince(since, channelLimit);
  const channels: MemorySummaryChannelResult[] = [];

  for (const channel of activeChannels) {
    const recent = await deps.conversations.listRecentByChannel(channel.channelId, conversationLimit);
    const turns = normalizeTurns(recent).filter((turn) => turn.userMessage.trim() && turn.assistantResponse?.trim());
    if (turns.length < minConversations) {
      channels.push({
        channelId: channel.channelId,
        guildId: channel.guildId,
        conversationCount: turns.length,
        status: "skipped",
        reason: `needs at least ${minConversations} complete turns`,
      });
      continue;
    }

    const fingerprint = buildSummaryFingerprint(channel, turns);
    if (processLocalFingerprints.has(fingerprint) || (await hasDurableFingerprint(deps, fingerprint))) {
      channels.push({
        channelId: channel.channelId,
        guildId: channel.guildId,
        conversationCount: turns.length,
        status: "skipped",
        reason: "summary fingerprint already exists",
        summaryFingerprint: fingerprint,
      });
      continue;
    }

    const summary = await buildChannelSummary(deps, channel, turns);
    const metadata = buildSummaryMetadata(channel, turns, fingerprint, summary.generatedBy);
    const stored = await deps.memory.remember({
      content: summary.content,
      scope: "CHANNEL",
      guildId: channel.guildId,
      channelId: channel.channelId,
      importance: 4,
      metadata,
      explicit: true,
      learning: {
        source: SUMMARY_SOURCE,
        confidence: summary.generatedBy === "llm" ? 0.88 : 0.72,
        accessPaths: ["memory_rag"],
        retention: { canRetrieve: true, canTrain: false },
        metadata,
      },
    });

    if (!stored.stored) {
      channels.push({
        channelId: channel.channelId,
        guildId: channel.guildId,
        conversationCount: turns.length,
        status: "skipped",
        reason: stored.reason,
        summaryFingerprint: fingerprint,
      });
      continue;
    }

    processLocalFingerprints.add(fingerprint);
    channels.push({
      channelId: channel.channelId,
      guildId: channel.guildId,
      conversationCount: turns.length,
      status: "summarized",
      memoryId: stored.id,
      ...(stored.learnedItemId ? { learnedItemId: stored.learnedItemId } : {}),
      summaryFingerprint: fingerprint,
    });
  }

  const summariesWritten = channels.filter((channel) => channel.status === "summarized").length;
  return {
    status: summariesWritten > 0 ? "summarized" : "skipped",
    reason: summariesWritten > 0 ? "summaries written" : "no eligible channel windows",
    channelsScanned: activeChannels.length,
    summariesWritten,
    channels,
  };
}

function skippedReport(reason: string): MemorySummaryReport {
  return { status: "skipped", reason, channelsScanned: 0, summariesWritten: 0, channels: [] };
}

async function hasDurableFingerprint(deps: MemorySummarizerDeps, fingerprint: string): Promise<boolean> {
  if (!deps.learning) return false;
  try {
    return Boolean(await deps.learning.findLearnedItemByMetadata(SUMMARY_SOURCE, "summaryFingerprint", fingerprint));
  } catch (err) {
    deps.logger.warn({ err: toErrorMessage(err), fingerprint }, "failed to check memory summary fingerprint");
    return false;
  }
}

async function buildChannelSummary(
  deps: MemorySummarizerDeps,
  channel: ActiveConversationChannel,
  turns: ConversationSummaryTurn[],
): Promise<{ content: string; generatedBy: "llm" | "deterministic" }> {
  if (deps.llm) {
    try {
      const transcriptMaxChars = deps.transcriptMaxChars ?? DEFAULT_TRANSCRIPT_MAX_CHARS;
      const transcript = buildTranscript(turns, transcriptMaxChars);
      const useLongContext = transcript.length >= transcriptMaxChars;
      const response = await deps.llm.generateChatCompletion({
        temperature: 0.1,
        maxTokens: 220,
        responseFormat: "text",
        metadata: {
          purpose: "memory_summary",
          channelId: channel.channelId,
          ...(useLongContext
            ? {
                longContext: true,
                preferredProvider: "subq",
                architectureTarget: "subquadratic-sparse-attention",
              }
            : {}),
        },
        messages: [
          {
            role: "system",
            content:
              "Create durable rolling Discord channel summaries for Irene's memory. Keep stable facts, decisions, preferences, unresolved tasks, and social context. Do not include secrets, tokens, passwords, or private credentials. Do not quote users verbatim beyond short phrases. Keep it under 160 words.",
          },
          {
            role: "user",
            content: `Channel ${channel.channelId} recent complete turns:\n${transcript}`,
          },
        ],
      });
      const content = normalizeSummaryText(response.content);
      if (content.length >= 40) return { content, generatedBy: "llm" };
    } catch (err) {
      deps.logger.warn({ err: toErrorMessage(err), channelId: channel.channelId }, "LLM channel summary failed");
    }
  }

  return { content: deterministicSummary(channel, turns), generatedBy: "deterministic" };
}

function deterministicSummary(channel: ActiveConversationChannel, turns: ConversationSummaryTurn[]): string {
  const participants = unique(turns.map((turn) => turn.userId)).slice(0, 8);
  const firstAt = toIso(turns[0]?.createdAt);
  const lastAt = toIso(turns[turns.length - 1]?.createdAt);
  const userContext = turns
    .slice(-4)
    .map((turn) => compactLine(turn.userMessage, 180))
    .filter(Boolean)
    .join(" / ");
  const assistantContext = turns
    .slice(-4)
    .map((turn) => compactLine(turn.assistantResponse ?? "", 180))
    .filter(Boolean)
    .join(" / ");

  return [
    `Channel summary for ${channel.channelId} (${turns.length} recent turns, ${firstAt} to ${lastAt}).`,
    `Participants: ${participants.join(", ")}.`,
    `Recent user context: ${userContext || "No durable user context extracted."}`,
    `Recent Irene context: ${assistantContext || "No durable assistant context extracted."}`,
    "Use this for conversational continuity only; it is not reviewed training data.",
  ].join("\n");
}

function buildTranscript(turns: ConversationSummaryTurn[], maxChars: number): string {
  const lines: string[] = [];
  for (const turn of turns) {
    lines.push(
      `[${toIso(turn.createdAt)}] user:${turn.userId}: ${compactLine(turn.userMessage, 800)}`,
      `[${toIso(turn.createdAt)}] Irene: ${compactLine(turn.assistantResponse ?? "", 800)}`,
    );
  }
  const transcript = lines.join("\n");
  if (transcript.length <= maxChars) return transcript;
  return transcript.slice(transcript.length - maxChars);
}

function buildSummaryMetadata(
  channel: ActiveConversationChannel,
  turns: ConversationSummaryTurn[],
  fingerprint: string,
  generatedBy: "llm" | "deterministic",
): JsonObject {
  return {
    summaryKind: "rolling_channel_summary",
    summaryVersion: 1,
    summarySource: SUMMARY_SOURCE,
    summaryFingerprint: fingerprint,
    generatedBy,
    guildId: channel.guildId,
    channelId: channel.channelId,
    conversationCount: turns.length,
    sourceConversationIds: turns.map((turn) => turn.id),
    participantUserIds: unique(turns.map((turn) => turn.userId)),
    startConversationAt: toIso(turns[0]?.createdAt),
    endConversationAt: toIso(turns[turns.length - 1]?.createdAt),
    canTrainWithoutReview: false,
  };
}

function buildSummaryFingerprint(channel: ActiveConversationChannel, turns: ConversationSummaryTurn[]): string {
  const payload = {
    source: SUMMARY_SOURCE,
    guildId: channel.guildId,
    channelId: channel.channelId,
    turns: turns.map((turn) => ({
      id: turn.id,
      userId: turn.userId,
      userMessage: turn.userMessage,
      assistantResponse: turn.assistantResponse,
      createdAt: toIso(turn.createdAt),
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function normalizeTurns(turns: ConversationSummaryTurn[]): ConversationSummaryTurn[] {
  return [...turns].sort((a, b) => toIso(a.createdAt).localeCompare(toIso(b.createdAt)));
}

function normalizeSummaryText(value: string): string {
  return redactSensitive(value).replace(/\r\n/g, "\n").trim().slice(0, 2_000);
}

function compactLine(value: string, maxChars: number): string {
  const compacted = redactSensitive(value).replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function redactSensitive(value: string): string {
  return value
    .replace(/\b(password|token|api[_-]?key|secret)\s*[:=]\s*\S+/gi, "[credential redacted]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email redacted]");
}

function toIso(value: Date | string | undefined): string {
  if (!value) return "unknown";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
