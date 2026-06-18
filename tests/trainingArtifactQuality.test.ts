import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTrainingArtifacts, compareTrainingRuns } from "../src/training/quality/TrainingArtifactQuality";

describe("TrainingArtifactQuality", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("validates dataset splits, metrics, artifacts, and run comparison", async () => {
    const fixture = await writeFixture();
    const report = await checkTrainingArtifacts({
      datasetReportPath: fixture.datasetReport,
      metricsPath: fixture.candidateMetrics,
      baselineMetricsPath: fixture.baselineMetrics,
    });

    expect(report.status).toBe("ok");
    expect(report.train).toBe(1);
    expect(report.validation).toBe(1);
    expect(report.splitValidation).toEqual([
      expect.objectContaining({ split: "train", records: 1, uniqueIds: 1 }),
      expect.objectContaining({ split: "validation", records: 1, uniqueIds: 1 }),
    ]);
    expect(report.bestCheckpoint).toBe(fixture.bestCheckpoint);
    expect(report.comparison).toMatchObject({ improved: true });

    await expect(compareTrainingRuns(fixture.baselineMetrics, fixture.candidateMetrics)).resolves.toMatchObject({
      improved: true,
    });
  });

  it("rejects train/validation overlap by stable example id", async () => {
    const fixture = await writeFixture({ overlappingId: true });
    await expect(
      checkTrainingArtifacts({
        datasetReportPath: fixture.datasetReport,
        metricsPath: fixture.candidateMetrics,
      }),
    ).rejects.toThrow(/Train\/validation overlap/);
  });

  it("rejects incomplete best-checkpoint metadata", async () => {
    const fixture = await writeFixture({ omitBestCheckpointStep: true });
    await expect(
      checkTrainingArtifacts({
        datasetReportPath: fixture.datasetReport,
        metricsPath: fixture.candidateMetrics,
      }),
    ).rejects.toThrow(/Best-checkpoint metadata must include artifact path, step, and validation loss together/);
  });

  it("rejects stale best-checkpoint metadata that does not match history", async () => {
    const fixture = await writeFixture({ staleBestCheckpointLoss: true });
    await expect(
      checkTrainingArtifacts({
        datasetReportPath: fixture.datasetReport,
        metricsPath: fixture.candidateMetrics,
      }),
    ).rejects.toThrow(/Best-checkpoint validation loss mismatch/);
  });

  async function writeFixture(options?: {
    overlappingId?: boolean;
    omitBestCheckpointStep?: boolean;
    staleBestCheckpointLoss?: boolean;
  }): Promise<{
    datasetReport: string;
    candidateMetrics: string;
    baselineMetrics: string;
    bestCheckpoint: string;
  }> {
    dir = await mkdtemp(join(tmpdir(), "training-quality-"));
    const checkpoint = join(dir, "tiny_char_lm.npz");
    const bestCheckpoint = join(dir, "tiny_char_lm.best.npz");
    const vocab = join(dir, "vocab.json");
    const tokenizer = join(dir, "tokenizer_config.json");
    const trainPath = join(dir, "sft.train.jsonl");
    const validationPath = join(dir, "sft.validation.jsonl");
    const datasetReport = join(dir, "dataset_report.json");
    const candidateMetrics = join(dir, "candidate_metrics.json");
    const baselineMetrics = join(dir, "baseline_metrics.json");
    await mkdir(dir, { recursive: true });

    const trainId = "example-train";
    const validationId = options?.overlappingId ? trainId : "example-validation";
    await writeFile(trainPath, `${JSON.stringify(record(trainId, "train"))}\n`, "utf8");
    await writeFile(validationPath, `${JSON.stringify(record(validationId, "validation"))}\n`, "utf8");
    await writeFile(checkpoint, "checkpoint", "utf8");
    await writeFile(bestCheckpoint, "best checkpoint", "utf8");
    await writeFile(vocab, "{}", "utf8");
    await writeFile(tokenizer, "{}", "utf8");

    const trainInfo = await fileInfo(trainPath);
    const validationInfo = await fileInfo(validationPath);
    await writeFile(
      datasetReport,
      JSON.stringify(
        {
          accepted: 2,
          train: 1,
          validation: 1,
          files: [
            { path: trainPath, lines: 1, ...trainInfo },
            { path: validationPath, lines: 1, ...validationInfo },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const commonMetrics = {
      train_path: trainPath,
      val_path: validationPath,
      train_sha256: trainInfo.sha256,
      val_sha256: validationInfo.sha256,
      parameters: 123,
      ...(options?.omitBestCheckpointStep ? {} : { best_checkpoint_step: 2 }),
      best_checkpoint_val_loss: options?.staleBestCheckpointLoss ? 2.5 : 1.5,
      sample: "this is a long enough generated sample",
      artifacts: { checkpoint, bestCheckpoint, vocab, tokenizer },
    };
    await writeFile(
      candidateMetrics,
      JSON.stringify({
        ...commonMetrics,
        history: [
          { step: 1, train_loss: 4, val_loss: 4 },
          { step: 2, train_loss: 2, val_loss: 1.5 },
        ],
      }),
      "utf8",
    );
    await writeFile(
      baselineMetrics,
      JSON.stringify({
        ...commonMetrics,
        history: [
          { step: 1, train_loss: 4, val_loss: 4 },
          { step: 2, train_loss: 3, val_loss: 2.5 },
        ],
      }),
      "utf8",
    );

    return { datasetReport, candidateMetrics, baselineMetrics, bestCheckpoint };
  }
});

function record(id: string, split: "train" | "validation"): unknown {
  return {
    messages: [
      { role: "system", content: "You are a test assistant." },
      { role: "user", content: `Prompt for ${id}` },
      { role: "assistant", content: `Answer for ${id}` },
    ],
    metadata: {
      id,
      source: "fixture",
      license: "fixture-license",
      split,
    },
  };
}

async function fileInfo(path: string): Promise<{ bytes: number; sha256: string }> {
  const body = await readFile(path);
  return {
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}
