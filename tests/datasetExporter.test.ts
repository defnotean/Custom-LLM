import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DatasetExporter, type ExportableExampleRow } from "../src/training/DatasetExporter";
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
      logger: testLogger,
    });
    const summary = await exporter.exportAll(dir);

    expect(summary.skipped).toBe(2); // low quality + parse failure

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
    expect(JSON.parse(dpo[0] ?? "{}")).toMatchObject({ prompt: "use ping" });

    const alpaca = (await readFile(join(dir, "alpaca.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    expect(JSON.parse(alpaca[0] ?? "{}")).toMatchObject({ input: "hey what's up" });
  });
});
