import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildKnowledgeEvalMessages,
  runKnowledgeEvalPredictions,
} from "../src/training/eval/KnowledgeEvalPredictionRunner";
import type { KnowledgeEvalCase } from "../src/training/eval/KnowledgeEvalSuite";
import { MockLLMProvider } from "./helpers";

describe("KnowledgeEvalPredictionRunner", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds plain-text eval messages without tool protocol", () => {
    const evalCase = knowledgeCase("case-1", "dolly", "Who wrote Hamlet?", "William Shakespeare");
    const messages = buildKnowledgeEvalMessages(evalCase);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("Do not call tools");
    expect(messages[0]?.content).toContain("Do not");
    expect(messages[0]?.content).not.toContain("Output format");
    expect(messages[1]).toEqual({ role: "user", content: evalCase.prompt });
  });

  it("writes prediction JSONL and forwards metadata to the LLM", async () => {
    dir = await mkdtemp(join(tmpdir(), "knowledge-eval-runner-"));
    const suitePath = join(dir, "suite.jsonl");
    const outPath = join(dir, "predictions.jsonl");
    await writeFile(
      suitePath,
      `${JSON.stringify(knowledgeCase("case-1", "dolly", "Who wrote Hamlet?", "William Shakespeare"))}\n`,
      "utf8",
    );
    const llm = new MockLLMProvider(["William Shakespeare"]);

    const summary = await runKnowledgeEvalPredictions({
      suitePath,
      outPath,
      llm,
      maxTokens: 32,
      temperature: 0.2,
    });

    expect(summary).toMatchObject({ attempted: 1, written: 1, errors: 0, model: "mock-model" });
    const predictions = (await readFile(outPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(predictions[0]).toMatchObject({ id: "case-1", output: "William Shakespeare", latencyMs: 1 });
    expect(llm.requests[0]).toMatchObject({
      responseFormat: "text",
      maxTokens: 32,
      temperature: 0.2,
      metadata: { evalCaseId: "case-1", evalKind: "knowledge" },
    });
  });
});

function knowledgeCase(id: string, source: string, prompt: string, expected: string): KnowledgeEvalCase {
  return { id, source, prompt, expected, metadata: {} };
}
