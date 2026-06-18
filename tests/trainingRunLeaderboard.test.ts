import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTrainingRunLeaderboard,
  buildTrainingRunReport,
  evaluateTrainingRunPromotion,
} from "../src/training/quality/TrainingRunLeaderboard";

describe("TrainingRunLeaderboard", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("ranks comparable runs by best validation loss and reports speed diagnostics", async () => {
    const root = await makeRoot();
    await writeRun(root, {
      name: "tiny-transformer-iter1",
      history: [
        { step: 1, train_loss: 4.5, val_loss: 4.7 },
        { step: 100, train_loss: 2.8, val_loss: 2.9 },
      ],
      elapsedSeconds: 10,
      trainTokens: 1000,
    });
    await writeRun(root, {
      name: "tiny-transformer-iter2",
      history: [
        { step: 1, train_loss: 4.4, val_loss: 4.6 },
        { step: 100, train_loss: 2.5, val_loss: 2.4 },
      ],
      elapsedSeconds: 20,
      trainTokens: 3000,
      withBestCheckpoint: true,
    });

    const report = await buildTrainingRunLeaderboard({ runRoot: root });

    expect(report.totalRuns).toBe(2);
    expect(report.runs[0]).toMatchObject({
      rank: 1,
      runName: "tiny-transformer-iter2",
      bestValLoss: 2.4,
      tokensPerSecond: 150,
      allArtifactsPresent: true,
      bestCheckpointStep: 100,
      bestCheckpointValLoss: 2.4,
    });
    expect(report.runs[0]?.bestCheckpoint).toContain("tiny_transformer_lm.best.pt");
    expect(report.runs[0]?.artifactStatus).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "bestCheckpoint", exists: true })]),
    );
    expect(report.runs[0]?.sampleDiagnostics.hasAssistantMarker).toBe(true);
  });

  it("accepts a candidate that improves over the chosen baseline", async () => {
    const root = await makeRoot();
    const baseline = await writeRun(root, {
      name: "baseline",
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 3, val_loss: 3 },
      ],
    });
    const candidate = await writeRun(root, {
      name: "candidate",
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 2, val_loss: 2 },
      ],
    });

    await expect(
      evaluateTrainingRunPromotion({
        candidateMetricsPath: candidate,
        baselineMetricsPath: baseline,
        minAbsoluteLossImprovement: 0.5,
      }),
    ).resolves.toMatchObject({
      status: "accepted",
      absoluteImprovement: 1,
      reasons: [],
    });
  });

  it("rejects a candidate with a missing declared best checkpoint", async () => {
    const root = await makeRoot();
    const baseline = await writeRun(root, {
      name: "baseline",
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 3, val_loss: 3 },
      ],
    });
    const candidate = await writeRun(root, {
      name: "candidate",
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 2, val_loss: 2 },
      ],
      missingBestCheckpoint: true,
    });

    const report = await evaluateTrainingRunPromotion({
      candidateMetricsPath: candidate,
      baselineMetricsPath: baseline,
      minAbsoluteLossImprovement: 0.5,
    });

    expect(report.status).toBe("rejected");
    expect(report.absoluteImprovement).toBe(1);
    expect(report.candidate.allArtifactsPresent).toBe(false);
    expect(report.candidate.warnings).toContain("missing_artifact");
    expect(report.candidate.artifactStatus).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "bestCheckpoint", exists: false })]),
    );
    expect(report.reasons).toEqual(["Candidate has missing or empty artifacts."]);
  });

  it("rejects a candidate that does not beat the best existing comparable run", async () => {
    const root = await makeRoot();
    await writeRun(root, {
      name: "best",
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 2, val_loss: 2 },
      ],
    });
    const candidate = await writeRun(root, {
      name: "candidate",
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 2.2, val_loss: 2.2 },
      ],
    });

    const report = await evaluateTrainingRunPromotion({
      candidateMetricsPath: candidate,
      runRoot: root,
      minAbsoluteLossImprovement: 0,
    });

    expect(report.status).toBe("rejected");
    expect(report.baseline?.runName).toBe("best");
    expect(report.reasons.join(" ")).toMatch(/did not clear the baseline/);
  });

  it("keeps assistant-loss runs out of all-token loss comparisons", async () => {
    const root = await makeRoot();
    await writeRun(root, {
      name: "all-token-loss",
      config: { loss_scope: "all" },
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 2, val_loss: 2 },
      ],
    });
    const candidate = await writeRun(root, {
      name: "assistant-loss",
      config: { loss_scope: "assistant" },
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 1.8, val_loss: 1.8 },
      ],
    });

    const report = await evaluateTrainingRunPromotion({
      candidateMetricsPath: candidate,
      runRoot: root,
    });

    expect(report.status).toBe("no_baseline");
    expect(report.reasons).toEqual(["No comparable baseline run was found."]);
  });

  it("attaches knowledge-eval evidence to the training run report", async () => {
    const root = await makeRoot();
    const candidateMetricsPath = await writeRun(root, {
      name: "candidate",
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 2, val_loss: 2 },
      ],
    });
    const knowledgeReportPath = join(root, "candidate-knowledge.report.json");
    await writeKnowledgeReport(knowledgeReportPath, { model: "tiny_pytorch_transformer_lm:candidate" });

    const report = await buildTrainingRunReport({
      runRoot: root,
      candidateMetricsPath,
      knowledgeReportPath,
      knowledgeThresholds: {
        minTotalCases: 2,
        minAnswerRate: 0.5,
        minAverageTokenF1: 0.4,
        minAverageRougeL: 0.4,
        maxLowScoreRate: 0.5,
      },
    });

    expect(report.leaderboard.totalRuns).toBe(1);
    expect(report.knowledge).toMatchObject({
      reportPath: knowledgeReportPath,
      predictionModels: ["tiny_pytorch_transformer_lm:candidate"],
      candidateRunName: "candidate",
      candidateModelMatched: true,
      warnings: [],
      gate: {
        status: "pass",
        candidate: {
          total: 2,
          answerRate: 1,
          averageTokenF1: 0.6,
          averageRougeL: 0.55,
          lowScoreRate: 0.5,
        },
      },
    });
  });

  it("attaches protocol eval evidence to the training run report", async () => {
    const root = await makeRoot();
    const candidateMetricsPath = await writeRun(root, {
      name: "candidate",
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 2, val_loss: 2 },
      ],
    });
    const toolReportPath = join(root, "candidate-tool.report.json");
    await writeToolReport(toolReportPath, { model: "tiny_pytorch_transformer_lm:candidate" });

    const report = await buildTrainingRunReport({
      runRoot: root,
      candidateMetricsPath,
      toolReportPath,
      toolThresholds: {
        minTotalCases: 2,
        minValidJsonRate: 0.9,
        minActionTypeAccuracy: 0.9,
        minToolNameAccuracy: 0.9,
        minToolArgumentValidity: 0.9,
        minNoToolAccuracy: 0.9,
      },
    });

    expect(report.tool).toMatchObject({
      reportPath: toolReportPath,
      predictionModels: ["tiny_pytorch_transformer_lm:candidate"],
      candidateRunName: "candidate",
      candidateModelMatched: true,
      warnings: [],
      gate: {
        status: "pass",
        candidate: {
          total: 2,
          validJsonRate: 1,
          actionTypeAccuracy: 1,
          hallucinatedToolRate: 0,
        },
      },
    });
  });

  it("warns when attached knowledge predictions do not match the candidate run", async () => {
    const root = await makeRoot();
    const candidateMetricsPath = await writeRun(root, {
      name: "candidate",
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 2, val_loss: 2 },
      ],
    });
    const knowledgeReportPath = join(root, "wrong-run-knowledge.report.json");
    await writeKnowledgeReport(knowledgeReportPath, { model: "tiny_pytorch_transformer_lm:other-run" });

    const report = await buildTrainingRunReport({
      runRoot: root,
      candidateMetricsPath,
      knowledgeReportPath,
      knowledgeThresholds: {
        minTotalCases: 2,
        minAnswerRate: 0.5,
        minAverageTokenF1: 0.4,
        minAverageRougeL: 0.4,
        maxLowScoreRate: 0.5,
      },
    });

    expect(report.knowledge).toMatchObject({
      predictionModels: ["tiny_pytorch_transformer_lm:other-run"],
      candidateRunName: "candidate",
      candidateModelMatched: false,
      warnings: ["knowledge_prediction_model_mismatch"],
      gate: { status: "pass" },
    });
  });

  it("warns when attached protocol predictions do not match the candidate run", async () => {
    const root = await makeRoot();
    const candidateMetricsPath = await writeRun(root, {
      name: "candidate",
      history: [
        { step: 1, train_loss: 5, val_loss: 5 },
        { step: 100, train_loss: 2, val_loss: 2 },
      ],
    });
    const toolReportPath = join(root, "wrong-run-tool.report.json");
    await writeToolReport(toolReportPath, { model: "tiny_pytorch_transformer_lm:other-run" });

    const report = await buildTrainingRunReport({
      runRoot: root,
      candidateMetricsPath,
      toolReportPath,
      toolThresholds: {
        minTotalCases: 2,
        minValidJsonRate: 0.9,
        minActionTypeAccuracy: 0.9,
        minToolNameAccuracy: 0.9,
        minToolArgumentValidity: 0.9,
        minNoToolAccuracy: 0.9,
      },
    });

    expect(report.tool).toMatchObject({
      predictionModels: ["tiny_pytorch_transformer_lm:other-run"],
      candidateRunName: "candidate",
      candidateModelMatched: false,
      warnings: ["tool_prediction_model_mismatch"],
      gate: { status: "pass" },
    });
  });

  async function makeRoot(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "training-runs-"));
    return dir;
  }
});

async function writeRun(
  root: string,
  options: {
    name: string;
    history: Array<{ step: number; train_loss: number; val_loss: number }>;
    elapsedSeconds?: number;
    trainTokens?: number;
    config?: Record<string, unknown>;
    withBestCheckpoint?: boolean;
    missingBestCheckpoint?: boolean;
  },
): Promise<string> {
  const runDir = join(root, options.name);
  await mkdir(runDir, { recursive: true });
  const trainPath = join(runDir, "sft.train.jsonl");
  const valPath = join(runDir, "sft.validation.jsonl");
  const checkpoint = join(runDir, "tiny_transformer_lm.pt");
  const bestCheckpoint = join(runDir, "tiny_transformer_lm.best.pt");
  const vocab = join(runDir, "vocab.json");
  const tokenizer = join(runDir, "tokenizer_config.json");
  const metricsPath = join(runDir, "metrics.json");
  const declareBestCheckpoint = options.withBestCheckpoint || options.missingBestCheckpoint;
  const bestPoint = options.history.reduce((best, item) => (item.val_loss < best.val_loss ? item : best));

  await writeFile(trainPath, `${JSON.stringify({ messages: [] })}\n`, "utf8");
  await writeFile(valPath, `${JSON.stringify({ messages: [] })}\n`, "utf8");
  await writeFile(checkpoint, "checkpoint", "utf8");
  if (options.withBestCheckpoint) await writeFile(bestCheckpoint, "best checkpoint", "utf8");
  await writeFile(vocab, "{}", "utf8");
  await writeFile(tokenizer, "{}", "utf8");

  const trainInfo = await fileInfo(trainPath);
  const valInfo = await fileInfo(valPath);
  await writeFile(
    metricsPath,
    JSON.stringify(
      {
        model: "tiny_pytorch_transformer_lm",
        seed: 2026,
        device: "cpu",
        train_path: trainPath,
        val_path: valPath,
        train_sha256: trainInfo.sha256,
        val_sha256: valInfo.sha256,
        train_records: 1,
        val_records: 1,
        train_tokens: options.trainTokens ?? 1000,
        val_tokens: 100,
        vocab_size: 256,
        parameters: 12345,
        elapsed_seconds: options.elapsedSeconds ?? 10,
        config: { steps: options.history.at(-1)?.step ?? 100, ...options.config },
        history: options.history,
        ...(declareBestCheckpoint
          ? { best_checkpoint_step: bestPoint.step, best_checkpoint_val_loss: bestPoint.val_loss }
          : {}),
        sample:
          "<|assistant|> This generated fixture sample is long enough for review and contains no unknown tokens.",
        artifacts: {
          checkpoint,
          ...(declareBestCheckpoint ? { bestCheckpoint } : {}),
          vocab,
          tokenizer,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return metricsPath;
}

async function fileInfo(path: string): Promise<{ sha256: string }> {
  const body = await readFile(path);
  return {
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function writeKnowledgeReport(path: string, options?: { model?: string }): Promise<void> {
  const predictionsPath = join(dirname(path), "candidate.predictions.jsonl");
  await writeFile(
    predictionsPath,
    [
      { id: "case-1", output: "alpha", model: options?.model ?? "tiny_pytorch_transformer_lm:candidate", latencyMs: 80 },
      { id: "case-2", output: "beta", model: options?.model ?? "tiny_pytorch_transformer_lm:candidate", latencyMs: 100 },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path,
    JSON.stringify(
      {
        suitePath: "training/evals/knowledge.eval.jsonl",
        predictionsPath,
        total: 2,
        answered: 2,
        answerRate: 1,
        exactMatchRate: 0.5,
        averageTokenF1: 0.6,
        averageRougeL: 0.55,
        missingPredictions: 0,
        lowScoreCount: 1,
        latencyMs: { count: 2, average: 80, p95: 100, max: 100 },
        bySource: {
          fixture: { total: 2, averageTokenF1: 0.6, averageRougeL: 0.55 },
        },
        failures: [],
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function writeToolReport(path: string, options?: { model?: string }): Promise<void> {
  const predictionsPath = join(dirname(path), "candidate-tool.predictions.jsonl");
  await writeFile(
    predictionsPath,
    [
      { id: "tool:add_numbers:direct", output: "{\"type\":\"tool_call\",\"tool\":\"add_numbers\",\"arguments\":{\"a\":1}}", model: options?.model ?? "tiny_pytorch_transformer_lm:candidate", latencyMs: 75 },
      { id: "no_tool:casual_1", output: "{\"type\":\"message\",\"content\":\"ok\"}", model: options?.model ?? "tiny_pytorch_transformer_lm:candidate", latencyMs: 90 },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path,
    JSON.stringify(
      {
        suitePath: "training/evals/tool-routing.eval.jsonl",
        predictionsPath,
        total: 2,
        parseOk: 2,
        validJsonRate: 1,
        actionTypeAccuracy: 1,
        toolNameAccuracy: 1,
        toolArgumentValidity: 1,
        noToolAccuracy: 1,
        hallucinatedToolRate: 0,
        missingPredictions: 0,
        latencyMs: { count: 2, average: 82.5, p95: 90, max: 90 },
        byKind: {
          tool_call: { total: 1, correctType: 1, correctTool: 1, validArgs: 1 },
          no_tool: { total: 1, correctType: 1, correctTool: 0, validArgs: 0 },
        },
        failures: [],
      },
      null,
      2,
    ),
    "utf8",
  );
}
