import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DatasetExporter,
  type ExportableExampleRow,
  type ExportableFeedbackPreferenceRow,
} from "../src/training/DatasetExporter";
import { testLogger } from "./helpers";

const rows: ExportableExampleRow[] = [
  {
    id: "1",
    source: "CONVERSATION",
    format: "CHATML",
    inputJson: { systemPrompt: "You are a bot.", userMessage: "hey what's up" },
    outputJson: { finalResponse: "not much, you?", parseOk: true, toolCall: null },
    qualityScore: 0.8,
    reviewed: false,
    metadataJson: {},
  },
  {
    id: "2",
    source: "TOOL_CALL",
    format: "TOOL_CALLING_JSONL",
    inputJson: { systemPrompt: "You are a bot.", userMessage: "ping the bot" },
    outputJson: {
      finalResponse: "Pong.",
      parseOk: true,
      toolCall: { name: "ping", arguments: {}, reason: "user asked" },
      toolResult: { ok: true, data: { pong: true } },
    },
    qualityScore: 0.9,
    reviewed: false,
    metadataJson: {},
  },
  {
    id: "3",
    source: "CONVERSATION",
    format: "CHATML",
    inputJson: { systemPrompt: "You are a bot.", userMessage: "low quality turn" },
    outputJson: { finalResponse: "meh", parseOk: true, toolCall: null },
    qualityScore: 0.1, // below threshold → skipped
    reviewed: false,
    metadataJson: {},
  },
  {
    id: "4",
    source: "CONVERSATION",
    format: "CHATML",
    inputJson: { systemPrompt: "You are a bot.", userMessage: "broken format turn" },
    outputJson: { finalResponse: "raw text reply", parseOk: false, toolCall: null },
    qualityScore: 0.7, // parse failure → skipped from SFT
    reviewed: false,
    metadataJson: {},
  },
  {
    id: "5",
    source: "SYNTHETIC",
    format: "TOOL_CALLING_JSONL",
    inputJson: { systemPrompt: "You are a bot.", userMessage: "use ping" },
    outputJson: {
      finalResponse: "",
      parseOk: true,
      toolCall: null,
      dpo: {
        prompt: "use ping",
        chosen: '{"type":"tool_call","tool":"ping","arguments":{}}',
        rejected: '{"type":"tool_call","tool":"ping_v2_real","arguments":{}}',
      },
    },
    qualityScore: 0.6,
    reviewed: false,
    metadataJson: {},
  },
  {
    id: "6",
    source: "FEEDBACK",
    format: "CHATML",
    inputJson: { systemPrompt: "You are a bot.", userMessage: "answer better" },
    outputJson: {
      finalResponse: "",
      parseOk: true,
      toolCall: null,
      dpo: {
        prompt: "answer better",
        chosen: "A reviewed human-preferred answer.",
        rejected: "The original answer that received negative feedback.",
      },
    },
    qualityScore: 0.95,
    reviewed: true,
    metadataJson: { conversationId: "conversation-6" },
  },
];

const feedbackRows: ExportableFeedbackPreferenceRow[] = [
  {
    id: "feedback-1",
    conversationId: "conversation-7",
    userId: "user-7",
    rating: 1,
    feedbackText: "The second answer is more precise.",
    prompt: "What is pgvector?",
    chosen: "pgvector stores vector embeddings in Postgres.",
    rejected: "It is a generic database.",
    reviewed: true,
    metadataJson: { reviewer: "human" },
  },
  {
    id: "feedback-unreviewed",
    conversationId: "conversation-8",
    userId: "user-8",
    rating: -1,
    feedbackText: "Needs review.",
    prompt: "What is Qdrant?",
    chosen: "Qdrant is a vector database.",
    rejected: "Qdrant is a CSS framework.",
    reviewed: false,
    metadataJson: {},
  },
];

describe("DatasetExporter", () => {
  let dir: string;

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("exports valid JSONL in all formats with quality/parse filtering", async () => {
    dir = await mkdtemp(join(tmpdir(), "export-test-"));
    const exporter = new DatasetExporter({
      source: { listAll: async () => rows },
      feedbackSource: { listReviewedPreferencePairs: async () => feedbackRows },
      logger: testLogger,
    });
    const summary = await exporter.exportAll(dir);

    expect(summary.skipped).toBe(2); // low quality + parse failure
    expect(summary.feedbackPreferences).toBe(2);

    const chatml = (await readFile(join(dir, "chatml.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    expect(chatml).toHaveLength(1);
    const chatmlRecord = JSON.parse(chatml[0] ?? "{}") as { messages: Array<{ role: string; content: string }> };
    expect(chatmlRecord.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(chatmlRecord.messages[2]?.content).toBe("not much, you?");

    const toolCalling = (await readFile(join(dir, "tool-calling.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    expect(toolCalling).toHaveLength(1);
    const toolRecord = JSON.parse(toolCalling[0] ?? "{}") as { messages: Array<{ role: string; content: string; name?: string }> };
    expect(toolRecord.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    // assistant tool_call turn must itself be valid JSON
    const callTurn = JSON.parse(toolRecord.messages[2]?.content ?? "{}") as { type: string; tool: string };
    expect(callTurn).toMatchObject({ type: "tool_call", tool: "ping" });

    const dpo = (await readFile(join(dir, "dpo-placeholder.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    expect(dpo).toHaveLength(1);
    expect(JSON.parse(dpo[0] ?? "{}")).toMatchObject({ prompt: "use ping", metadata: { source: "SYNTHETIC" } });

    const feedbackDpo = (await readFile(join(dir, "preference-feedback.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    expect(feedbackDpo).toHaveLength(2);
    expect(JSON.parse(feedbackDpo[0] ?? "{}")).toMatchObject({
      prompt: "answer better",
      metadata: { source: "FEEDBACK", reviewed: true, conversationId: "conversation-6" },
    });
    expect(JSON.parse(feedbackDpo[1] ?? "{}")).toMatchObject({
      prompt: "What is pgvector?",
      chosen: "pgvector stores vector embeddings in Postgres.",
      metadata: { source: "FEEDBACK", reviewed: true, reviewer: "human", conversationId: "conversation-7" },
    });

    const alpaca = (await readFile(join(dir, "alpaca.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    expect(JSON.parse(alpaca[0] ?? "{}")).toMatchObject({ input: "hey what's up" });
  });
});
