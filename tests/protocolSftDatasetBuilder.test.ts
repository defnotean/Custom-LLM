import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProtocolSftDataset } from "../src/training/mixture/ProtocolSftDatasetBuilder";

describe("ProtocolSftDatasetBuilder", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds protocol ChatML splits and excludes held-out eval prompts", async () => {
    dir = await mkdtemp(join(tmpdir(), "protocol-sft-"));
    const rawDir = join(dir, "raw");
    const outDir = join(dir, "out");
    await mkdir(rawDir, { recursive: true });
    const syntheticPath = join(rawDir, "synthetic.jsonl");
    const evalSuitePath = join(rawDir, "eval.jsonl");

    await writeJsonl(syntheticPath, [
      syntheticTool("ping", "ping", { type: "tool_call", tool: "ping", arguments: {} }),
      syntheticTool("hello", "hello there", { type: "message", content: "hi" }, {
        requiredPermissions: ["SEND_MESSAGES"],
        requiredArgs: ["content"],
        providedArgs: { content: "hello" },
      }),
      syntheticTool("clarify", "summarize please", { type: "clarification", content: "What channel?" }, {
        requiredArgs: ["channelId"],
        missingArg: "channelId",
      }),
      syntheticTool("chat", "just chatting", { type: "message", content: "hi" }, { tool: undefined }, []),
      { inputJson: { systemPrompt: "Use tools.", userMessage: "broken" }, outputJson: { finalResponse: "not json" } },
    ]);
    await writeJsonl(evalSuitePath, [{ id: "heldout", prompt: "ping" }]);

    const report = await buildProtocolSftDataset({
      syntheticPath,
      evalSuitePath,
      outDir,
      validationShare: 0.5,
      paraphrasesPerRecord: 0,
    });

    expect(report).toMatchObject({
      raw: 5,
      accepted: 3,
      train: 2,
      validation: 1,
      augmented: 0,
      skippedMalformed: 1,
      skippedEvalOverlap: 1,
    });

    const trainLines = (await readFile(join(outDir, "sft.train.jsonl"), "utf8")).trim().split("\n");
    const validationLines = (await readFile(join(outDir, "sft.validation.jsonl"), "utf8")).trim().split("\n");
    expect(trainLines).toHaveLength(2);
    expect(validationLines).toHaveLength(1);

    const first = JSON.parse(trainLines[0] ?? "{}") as {
      messages: Array<{ role: string; content: string }>;
      metadata: Record<string, unknown>;
    };
    expect(first.messages[0]?.content).toContain("Candidate tools:");
    expect(first.messages[0]?.content).toContain("Only use candidate tools listed here");
    expect(first.messages[0]?.content).toContain("copy the tool name exactly as ping");
    expect(first.messages[0]?.content).toContain("Required arguments for ping: content");
    expect(first.messages[0]?.content).toContain("includes required argument details: content=hello");
    expect(first.messages[0]?.content).toContain("lacks required permissions");
    expect(first.messages[0]?.content).toContain("not tool_call or confirmation_request");
    expect(first.messages[2]?.role).toBe("assistant");
    expect(JSON.parse(first.messages[2]?.content ?? "{}")).toHaveProperty("type");
    expect(first.metadata).toMatchObject({
      source: "synthetic_protocol",
      license: "project-owned",
      split: "train",
      heldoutEvalGuard: "exact-prompt-match",
    });
    const noTool = trainLines
      .map((line) => JSON.parse(line) as { messages: Array<{ role: string; content: string }> })
      .find((line) => line.messages.some((message) => message.content === "just chatting"));
    expect(noTool?.messages[0]?.content).toContain("No candidate tools are available");
    const clarify = [...trainLines, ...validationLines]
      .map((line) => JSON.parse(line) as { messages: Array<{ role: string; content: string }> })
      .find((line) => line.messages.some((message) => message.content === "summarize please"));
    expect(clarify?.messages[0]?.content).toContain("missing required argument channelId");
  });
});

function syntheticTool(
  id: string,
  userMessage: string,
  assistantAction: unknown,
  metadata: Record<string, unknown> = {},
  candidateTools: string[] = ["ping"],
): unknown {
  return {
    inputJson: {
      systemPrompt: "Use tools safely.",
      userMessage,
      candidateTools,
    },
    outputJson: {
      finalResponse: JSON.stringify(assistantAction),
      toolCall: null,
    },
    metadataJson: { id, kind: "fixture", tool: "ping", ...metadata },
  };
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}
