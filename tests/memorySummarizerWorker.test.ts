import { describe, expect, it, vi } from "vitest";
import type { RememberInput } from "../src/memory/MemoryService";
import {
  summarizeRecentChannelConversations,
  type ConversationSummaryTurn,
} from "../src/jobs/workers/memorySummarizerWorker";
import { MockLLMProvider, testLogger } from "./helpers";

const activeChannel = {
  guildId: "guild-1",
  channelId: "channel-1",
  conversationCount: 4,
  lastConversationAt: "2026-06-18T18:04:00.000Z",
};

describe("memory summarizer worker", () => {
  it("summarizes recent channel turns into channel-scoped memory and live-learning metadata", async () => {
    const remembers: RememberInput[] = [];
    const llm = new MockLLMProvider([
      "- The project uses Friday game nights as durable server context.\n- Irene should keep setup progress visible.",
    ]);

    const report = await summarizeRecentChannelConversations({
      conversations: {
        listActiveChannelsSince: async () => [activeChannel],
        listRecentByChannel: async () => turns(),
      },
      memory: {
        remember: async (input) => {
          remembers.push(input);
          return { id: "memory-1", stored: true, reason: "ok", learnedItemId: "learned-1" };
        },
      },
      learning: { findLearnedItemByMetadata: async () => null },
      llm,
      logger: testLogger,
      now: () => new Date("2026-06-18T19:00:00.000Z"),
      minConversations: 2,
    });

    expect(report).toMatchObject({ status: "summarized", summariesWritten: 1, channelsScanned: 1 });
    expect(remembers).toHaveLength(1);
    expect(remembers[0]).toMatchObject({
      scope: "CHANNEL",
      guildId: "guild-1",
      channelId: "channel-1",
      importance: 4,
      explicit: true,
      learning: {
        source: "channel_summary",
        confidence: 0.88,
        accessPaths: ["memory_rag"],
        retention: { canRetrieve: true, canTrain: false },
      },
    });
    expect(remembers[0]?.content).toContain("Friday game nights");
    expect(remembers[0]?.metadata).toMatchObject({
      summaryKind: "rolling_channel_summary",
      summarySource: "channel_summary",
      conversationCount: 4,
      canTrainWithoutReview: false,
    });
    expect(typeof (remembers[0]?.metadata as Record<string, unknown>)?.summaryFingerprint).toBe("string");
  });

  it("skips a channel window when its summary fingerprint already exists", async () => {
    const remember = vi.fn();

    const report = await summarizeRecentChannelConversations({
      conversations: {
        listActiveChannelsSince: async () => [activeChannel],
        listRecentByChannel: async () => turns("duplicate"),
      },
      memory: { remember },
      learning: { findLearnedItemByMetadata: async () => ({ id: "learned-existing" }) as never },
      logger: testLogger,
      now: () => new Date("2026-06-18T19:00:00.000Z"),
      minConversations: 2,
    });

    expect(remember).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      status: "skipped",
      summariesWritten: 0,
      channels: [expect.objectContaining({ reason: "summary fingerprint already exists" })],
    });
  });

  it("marks long transcript summaries for the SubQ sparse-attention route", async () => {
    const remembers: RememberInput[] = [];
    const llm = new MockLLMProvider(["This long channel window should become durable continuity for Irene."]);

    await summarizeRecentChannelConversations({
      conversations: {
        listActiveChannelsSince: async () => [{ ...activeChannel, channelId: "channel-long" }],
        listRecentByChannel: async () =>
          turns("long", "I prefer very detailed project continuity updates ".repeat(40)),
      },
      memory: {
        remember: async (input) => {
          remembers.push(input);
          return { id: "memory-long", stored: true, reason: "ok" };
        },
      },
      learning: { findLearnedItemByMetadata: async () => null },
      llm,
      logger: testLogger,
      now: () => new Date("2026-06-18T19:00:00.000Z"),
      minConversations: 2,
      transcriptMaxChars: 300,
    });

    expect(llm.requests[0]?.metadata).toMatchObject({
      purpose: "memory_summary",
      longContext: true,
      preferredProvider: "subq",
      architectureTarget: "subquadratic-sparse-attention",
    });
    expect(remembers[0]?.learning?.retention).toMatchObject({ canTrain: false });
  });

  it("falls back deterministically and redacts credentials before storing", async () => {
    const remembers: RememberInput[] = [];
    const llm = new MockLLMProvider([]);

    const report = await summarizeRecentChannelConversations({
      conversations: {
        listActiveChannelsSince: async () => [{ ...activeChannel, channelId: "channel-redact" }],
        listRecentByChannel: async () => turns("redact", "remember this setup detail but token: abc123"),
      },
      memory: {
        remember: async (input) => {
          remembers.push(input);
          return { id: "memory-redacted", stored: true, reason: "ok" };
        },
      },
      learning: { findLearnedItemByMetadata: async () => null },
      llm,
      logger: testLogger,
      now: () => new Date("2026-06-18T19:00:00.000Z"),
      minConversations: 2,
    });

    expect(report.summariesWritten).toBe(1);
    expect(remembers[0]?.content).toContain("[credential redacted]");
    expect(remembers[0]?.content).not.toContain("abc123");
    expect(remembers[0]?.learning?.confidence).toBe(0.72);
  });
});

function turns(seed = "base", userMessage = "remember that the server game night is Friday"): ConversationSummaryTurn[] {
  return [1, 2, 3, 4].map((index) => ({
    id: `${seed}-conversation-${index}`,
    guildId: "guild-1",
    channelId: seed === "long" ? "channel-long" : seed === "redact" ? "channel-redact" : "channel-1",
    userId: index % 2 === 0 ? "user-2" : "user-1",
    userMessage: `${userMessage} (${index})`,
    assistantResponse: `Irene acknowledged durable context ${index}.`,
    createdAt: new Date(`2026-06-18T18:0${index}:00.000Z`),
  }));
}
