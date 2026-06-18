import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateLongContextPredictions,
  makeLongContextOraclePredictions,
  writeLongContextEvalSuite,
  type LongContextEvalCase,
} from "../src/training/eval/LongContextEvalSuite";

describe("LongContextEvalSuite", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds a deterministic synthetic needle-in-context suite", async () => {
    dir = await mkdtemp(join(tmpdir(), "long-context-eval-"));
    const suite = join(dir, "long-context.eval.jsonl");

    const summary = await writeLongContextEvalSuite({
      outPath: suite,
      contextCharTargets: [1024, 2048],
      needlePositions: ["early", "late"],
    });

    expect(summary.cases).toBe(4);
    expect(summary.byNeedlePosition).toMatchObject({ early: 2, middle: 0, late: 2 });
    const cases = await readJsonl<LongContextEvalCase>(suite);
    expect(cases[0]?.metadata.longContext).toBe(true);
    expect(cases[0]?.metadata.preferredProvider).toBe("subq");
    expect(cases[0]?.metadata.architectureTarget).toBe("subquadratic-sparse-attention");
    expect(cases[0]?.prompt).toContain(cases[0]?.metadata.targetKey);
    expect(cases[0]?.prompt).toContain(cases[0]?.expected);
  });

  it("scores oracle and weak predictions with exact retrieval metrics", async () => {
    dir = await mkdtemp(join(tmpdir(), "long-context-score-"));
    const suite = join(dir, "long-context.eval.jsonl");
    const oraclePredictions = join(dir, "oracle.predictions.jsonl");
    const weakPredictions = join(dir, "weak.predictions.jsonl");
    await writeLongContextEvalSuite({
      outPath: suite,
      contextCharTargets: [1024],
      needlePositions: ["early", "middle", "late"],
    });

    await makeLongContextOraclePredictions(suite, oraclePredictions);
    const oracle = await evaluateLongContextPredictions({ suitePath: suite, predictionsPath: oraclePredictions });
    expect(oracle.answerRate).toBe(1);
    expect(oracle.exactMatchRate).toBe(1);
    expect(oracle.expectedContainRate).toBe(1);
    expect(oracle.falsePositiveCount).toBe(0);

    const cases = await readJsonl<LongContextEvalCase>(suite);
    const firstDistractor = cases[0]?.metadata.distractorAnswers[0];
    if (!firstDistractor) throw new Error("expected a distractor value");
    await writeJsonl(weakPredictions, [
      { id: cases[0]?.id, output: firstDistractor, latencyMs: 25 },
      { id: cases[1]?.id, output: "I do not know", latencyMs: 50 },
    ]);
    const weak = await evaluateLongContextPredictions({ suitePath: suite, predictionsPath: weakPredictions });
    expect(weak.answerRate).toBe(0.333333);
    expect(weak.exactMatchRate).toBe(0);
    expect(weak.expectedContainRate).toBe(0);
    expect(weak.falsePositiveCount).toBe(1);
    expect(weak.missingPredictions).toBe(1);
    expect(weak.latencyMs.p95).toBe(50);
    expect(weak.failures.length).toBeGreaterThan(0);
  });
});

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
