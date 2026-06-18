import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTrainingIterationReport } from "../src/training/quality/TrainingIterationReportQuality";

describe("TrainingIterationReportQuality", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("accepts a complete review report even when behavior gates fail", async () => {
    const reportPath = await writeReport(makeReport());

    const report = await checkTrainingIterationReport({ reportPath });

    expect(report.status).toBe("ready");
    expect(report.summary).toMatchObject({
      candidateRunName: "candidate-run",
      promotionStatus: "rejected",
      toolGateStatus: "fail",
      knowledgeGateStatus: "fail",
    });
    expect(report.checks.filter((check) => check.status === "fail")).toHaveLength(0);
    expect(report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(["tool-gate", "knowledge-gate", "candidate-artifacts"]),
    );
  });

  it("requires behavior and router evidence when requested", async () => {
    const reportPath = await writeReport(
      makeReport({
        behavior: makeEvidence("behavior"),
        router: makeEvidence("router"),
      }),
    );

    const report = await checkTrainingIterationReport({
      reportPath,
      requireBehavior: true,
      requireRouter: true,
    });

    expect(report.status).toBe("ready");
    expect(report.summary).toMatchObject({
      behaviorGateStatus: "fail",
      routerGateStatus: "fail",
    });
    expect(report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(["behavior-gate", "router-gate", "behavior-candidate-match", "router-candidate-match"]),
    );
  });

  it("rejects the same report in promotion mode", async () => {
    const reportPath = await writeReport(makeReport());

    const report = await checkTrainingIterationReport({ reportPath, mode: "promotion" });

    expect(report.status).toBe("not_ready");
    expect(report.checks.filter((check) => check.status === "fail").map((check) => check.id)).toEqual(
      expect.arrayContaining(["promotion-status", "tool-gate", "knowledge-gate"]),
    );
  });

  it("fails review mode when attached evidence does not match the candidate", async () => {
    const reportPath = await writeReport(
      makeReport({
        tool: makeEvidence("tool", {
          candidateModelMatched: false,
          warnings: ["tool_prediction_model_mismatch"],
        }),
      }),
    );

    const report = await checkTrainingIterationReport({ reportPath });

    expect(report.status).toBe("not_ready");
    expect(report.checks.filter((check) => check.status === "fail").map((check) => check.id)).toEqual(
      expect.arrayContaining(["tool-candidate-match", "tool-warnings"]),
    );
  });

  async function writeReport(report: Record<string, unknown>): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "training-report-quality-"));
    const reportPath = join(dir, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    return reportPath;
  }
});

function makeReport(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    leaderboard: {
      runRoot: "training/runs",
      generatedAt: "2026-01-01T00:00:00.000Z",
      totalRuns: 1,
      runs: [],
    },
    promotion: {
      status: "rejected",
      candidate: {
        runName: "candidate-run",
        metricsPath: "training/runs/candidate-run/metrics.json",
        allArtifactsPresent: true,
        warnings: [],
      },
      reasons: ["Candidate did not beat the baseline."],
    },
    tool: makeEvidence("tool"),
    knowledge: makeEvidence("knowledge"),
    ...overrides,
  };
}

function makeEvidence(
  kind: "tool" | "knowledge" | "behavior" | "router",
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    reportPath: `training/evals/candidate-run.${kind}.report.json`,
    predictionModels: ["tiny_pytorch_transformer_lm:candidate-run"],
    candidateRunName: "candidate-run",
    candidateModelMatched: true,
    warnings: [],
    gate: {
      status: "fail",
      candidate: { total: kind === "tool" ? 35 : 200 },
      failures: [{ metric: "score", message: "below threshold" }],
      warnings: [],
      thresholds: {},
    },
    ...overrides,
  };
}
