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
      includeRepoArtifacts: false,
      includeRepoSnapshots: false,
    });

    expect(summary.cases).toBe(4);
    expect(summary.byNeedlePosition).toMatchObject({ early: 2, middle: 0, late: 2 });
    expect(summary.bySource).toMatchObject({ "synthetic-needle-in-context": 4 });
    expect(summary.byTaskType).toMatchObject({ needle_retrieval: 4 });
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
      includeRepoArtifacts: false,
      includeRepoSnapshots: false,
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

  it("includes repository artifact reasoning cases in the default suite", async () => {
    dir = await mkdtemp(join(tmpdir(), "long-context-repo-artifact-"));
    const suite = join(dir, "long-context.eval.jsonl");
    const oraclePredictions = join(dir, "oracle.predictions.jsonl");
    const summary = await writeLongContextEvalSuite({
      outPath: suite,
      contextCharTargets: [1024],
      needlePositions: ["middle"],
      includeRepoSnapshots: false,
    });

    expect(summary.cases).toBe(4);
    expect(summary.bySource).toMatchObject({
      "synthetic-needle-in-context": 1,
      "synthetic-repo-artifact": 3,
    });
    expect(summary.byTaskType).toMatchObject({
      needle_retrieval: 1,
      repo_file_lookup: 1,
      repo_env_lookup: 1,
      repo_routing_contract: 1,
    });

    const cases = await readJsonl<LongContextEvalCase>(suite);
    const repoCase = cases.find((item) => item.source === "synthetic-repo-artifact");
    expect(repoCase?.metadata.taskType).toMatch(/^repo_/);
    expect(repoCase?.prompt).toContain("<repo_artifact_bundle>");

    await makeLongContextOraclePredictions(suite, oraclePredictions);
    const oracle = await evaluateLongContextPredictions({ suitePath: suite, predictionsPath: oraclePredictions });
    expect(oracle.bySource["synthetic-repo-artifact"]?.exactMatchRate).toBe(1);
    expect(oracle.byTaskType.repo_file_lookup?.expectedContainRate).toBe(1);
  });

  it("includes real repository snapshot cases when a workspace root is provided", async () => {
    dir = await mkdtemp(join(tmpdir(), "long-context-real-repo-"));
    await writeRepoFixture(dir);
    const suite = join(dir, "evals", "long-context.eval.jsonl");
    const oraclePredictions = join(dir, "evals", "oracle.predictions.jsonl");
    const summary = await writeLongContextEvalSuite({
      outPath: suite,
      contextCharTargets: [1024],
      needlePositions: ["middle"],
      includeRepoArtifacts: false,
      workspaceRoot: dir,
    });

    expect(summary.cases).toBe(6);
    expect(summary.bySource).toMatchObject({
      "synthetic-needle-in-context": 1,
      "real-repo-snapshot": 3,
      "real-repo-multifile": 2,
    });
    expect(summary.byTaskType).toMatchObject({
      repo_script_lookup: 1,
      repo_readiness_contract: 1,
      repo_router_provider: 1,
      repo_script_readiness_chain: 1,
      repo_router_subq_chain: 1,
    });

    const cases = await readJsonl<LongContextEvalCase>(suite);
    const snapshotCase = cases.find((item) => item.source === "real-repo-snapshot");
    expect(snapshotCase?.prompt).toContain("<real_repo_snapshot>");
    expect(snapshotCase?.prompt).toContain("--- BEGIN FILE:");

    await makeLongContextOraclePredictions(suite, oraclePredictions);
    const oracle = await evaluateLongContextPredictions({ suitePath: suite, predictionsPath: oraclePredictions });
    expect(oracle.bySource["real-repo-snapshot"]?.exactMatchRate).toBe(1);
    expect(oracle.bySource["real-repo-multifile"]?.exactMatchRate).toBe(1);
    expect(oracle.byTaskType.repo_router_provider?.expectedContainRate).toBe(1);
    expect(oracle.byTaskType.repo_script_readiness_chain?.expectedContainRate).toBe(1);
  });
});

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function writeRepoFixture(root: string): Promise<void> {
  await mkdir(join(root, "src", "training", "quality"), { recursive: true });
  await mkdir(join(root, "src", "ai", "llm"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        scripts: {
          "eval:long-context:gate": "tsx scripts/check-long-context-promotion.ts",
          "eval:gate": "tsx scripts/check-eval-promotion.ts",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(root, "src", "training", "quality", "ProductionTrainingReadiness.ts"),
    'const checkId = "long-context-eval-harness";\nconst distractor = "router-eval-harness";\n',
    "utf8",
  );
  await writeFile(
    join(root, "src", "ai", "llm", "LLMRouter.ts"),
    'const provider = request.metadata?.longContext === true ? "subq" : "openai-compatible";\n',
    "utf8",
  );
  await writeFile(
    join(root, "docs", "LOCAL_LLM_SETUP.md"),
    "Long-context requests use metadata.longContext=true and route to subq when SubQ is configured.\n",
    "utf8",
  );
}

async function readJsonl<T>(path: string): Promise<T[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
