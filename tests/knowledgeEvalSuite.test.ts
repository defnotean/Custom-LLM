import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateKnowledgePredictions,
  makeKnowledgeOraclePredictions,
  writeKnowledgeEvalSuite,
  type KnowledgeEvalCase,
} from "../src/training/eval/KnowledgeEvalSuite";

describe("KnowledgeEvalSuite", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds a deterministic suite from eval seed records", async () => {
    dir = await mkdtemp(join(tmpdir(), "knowledge-eval-"));
    const input = join(dir, "eval.seed.jsonl");
    const suite = join(dir, "knowledge.eval.jsonl");
    await writeJsonl(input, [
      seed("case-1", "dolly", "Who wrote Hamlet?", "William Shakespeare"),
      seed("case-2", "oasst", "What is 2 + 2?", "four"),
      seed("case-2", "oasst", "What is 2 + 2?", "four"),
      seed("bad", "dolly", "x", ""),
    ]);

    const summary = await writeKnowledgeEvalSuite({ inputPath: input, outPath: suite, maxCases: 10 });
    expect(summary.cases).toBe(2);
    expect(summary.bySource).toMatchObject({ dolly: 1, oasst: 1 });

    const cases = await readJsonl<KnowledgeEvalCase>(suite);
    expect(cases[0]?.metadata.expectedHash).toEqual(expect.any(String));
  });

  it("scores oracle and weak predictions with overlap metrics", async () => {
    dir = await mkdtemp(join(tmpdir(), "knowledge-eval-score-"));
    const suite = join(dir, "knowledge.eval.jsonl");
    const oraclePredictions = join(dir, "oracle.predictions.jsonl");
    const weakPredictions = join(dir, "weak.predictions.jsonl");
    await writeJsonl(suite, [
      knowledgeCase("case-1", "dolly", "Who wrote Hamlet?", "William Shakespeare"),
      knowledgeCase("case-2", "dolly", "Name a primary color", "red"),
    ]);

    await makeKnowledgeOraclePredictions(suite, oraclePredictions);
    const oracle = await evaluateKnowledgePredictions({ suitePath: suite, predictionsPath: oraclePredictions });
    expect(oracle.answerRate).toBe(1);
    expect(oracle.exactMatchRate).toBe(1);
    expect(oracle.averageTokenF1).toBe(1);
    expect(oracle.lowScoreCount).toBe(0);

    await writeJsonl(weakPredictions, [
      { id: "case-1", output: "I do not know", latencyMs: 25 },
      { id: "case-2", output: "blue", latencyMs: 50 },
    ]);
    const weak = await evaluateKnowledgePredictions({ suitePath: suite, predictionsPath: weakPredictions });
    expect(weak.answerRate).toBe(0.5);
    expect(weak.lowScoreCount).toBe(2);
    expect(weak.latencyMs.p95).toBe(50);
    expect(weak.failures.length).toBeGreaterThan(0);
  });

  it("does not flag high-overlap references as non-answers because they contain AI disclaimer text", async () => {
    dir = await mkdtemp(join(tmpdir(), "knowledge-eval-disclaimer-"));
    const suite = join(dir, "knowledge.eval.jsonl");
    const predictions = join(dir, "predictions.jsonl");
    const disclaimerAnswer =
      "As an AI language model, I don't have personal preferences, but both examples are popular.";
    await writeJsonl(suite, [knowledgeCase("case-1", "oasst1_ready", "Which is more popular?", disclaimerAnswer)]);
    await writeJsonl(predictions, [{ id: "case-1", output: disclaimerAnswer }]);

    const report = await evaluateKnowledgePredictions({ suitePath: suite, predictionsPath: predictions });
    expect(report.answerRate).toBe(1);
    expect(report.failures).toEqual([]);
  });
});

function seed(id: string, source: string, prompt: string, expected: string): unknown {
  return { id, source, prompt, expected };
}

function knowledgeCase(id: string, source: string, prompt: string, expected: string): KnowledgeEvalCase {
  return { id, source, prompt, expected, metadata: {} };
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function readJsonl<T>(path: string): Promise<T[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
