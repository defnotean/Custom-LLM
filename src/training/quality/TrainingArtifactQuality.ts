import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

const datasetFileSchema = z.object({
  path: z.string(),
  lines: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
});

export const datasetReportSchema = z.object({
  accepted: z.number().int().positive(),
  train: z.number().int().nonnegative(),
  validation: z.number().int().positive(),
  files: z.array(datasetFileSchema).min(1),
});

export const trainingMetricsSchema = z.object({
  train_path: z.string(),
  val_path: z.string(),
  train_sha256: z.string().length(64),
  val_sha256: z.string().length(64),
  parameters: z.number().int().positive(),
  history: z
    .array(
      z.object({
        step: z.number().int().positive(),
        train_loss: z.number(),
        val_loss: z.number(),
      }),
    )
    .min(2),
  best_checkpoint_step: z.number().int().positive().optional(),
  best_checkpoint_val_loss: z.number().optional(),
  sample: z.string().min(20),
  artifacts: z.object({
    checkpoint: z.string(),
    bestCheckpoint: z.string().optional(),
    vocab: z.string(),
    tokenizer: z.string().optional(),
  }),
});

const chatMlRecordSchema = z.object({
  messages: z
    .tuple([
      z.object({ role: z.literal("system"), content: z.string().min(1) }),
      z.object({ role: z.literal("user"), content: z.string().min(1) }),
      z.object({ role: z.literal("assistant"), content: z.string().min(1) }),
    ])
    .rest(z.object({ role: z.string(), content: z.string() })),
  metadata: z
    .object({
      id: z.string().min(1),
      source: z.string().min(1),
      license: z.string().min(1),
      split: z.enum(["train", "validation"]),
    })
    .passthrough(),
});

export interface TrainingQualityOptions {
  datasetReportPath: string;
  metricsPath: string;
  baselineMetricsPath?: string;
}

export interface DatasetSplitValidation {
  path: string;
  split: "train" | "validation";
  records: number;
  uniqueIds: number;
}

export interface TrainingRunComparison {
  baselinePath: string;
  candidatePath: string;
  baselineBestValLoss: number;
  candidateBestValLoss: number;
  absoluteImprovement: number;
  improved: boolean;
}

export interface TrainingQualityReport {
  status: "ok";
  accepted: number;
  train: number;
  validation: number;
  parameters: number;
  firstValLoss: number;
  bestValLoss: number;
  lastValLoss: number;
  bestCheckpoint?: string;
  splitValidation: DatasetSplitValidation[];
  comparison?: TrainingRunComparison;
}

type DatasetReport = z.infer<typeof datasetReportSchema>;
type TrainingMetrics = z.infer<typeof trainingMetricsSchema>;

export async function checkTrainingArtifacts(options: TrainingQualityOptions): Promise<TrainingQualityReport> {
  const datasetReport = datasetReportSchema.parse(JSON.parse(await readFile(options.datasetReportPath, "utf8")));
  const metrics = trainingMetricsSchema.parse(JSON.parse(await readFile(options.metricsPath, "utf8")));

  if (datasetReport.train + datasetReport.validation !== datasetReport.accepted) {
    throw new Error(
      `Dataset split mismatch: train(${datasetReport.train}) + validation(${datasetReport.validation}) != accepted(${datasetReport.accepted})`,
    );
  }

  for (const file of datasetReport.files) {
    const actual = await fileInfo(file.path);
    if (actual.bytes !== file.bytes) throw new Error(`Byte mismatch for ${file.path}`);
    if (actual.sha256 !== file.sha256) throw new Error(`SHA256 mismatch for ${file.path}`);
  }

  const trainHash = (await fileInfo(metrics.train_path)).sha256;
  const valHash = (await fileInfo(metrics.val_path)).sha256;
  if (trainHash !== metrics.train_sha256) throw new Error(`Training input hash mismatch for ${metrics.train_path}`);
  if (valHash !== metrics.val_sha256) throw new Error(`Validation input hash mismatch for ${metrics.val_path}`);

  await assertNonEmpty(metrics.artifacts.checkpoint);
  if (metrics.artifacts.bestCheckpoint) await assertNonEmpty(metrics.artifacts.bestCheckpoint);
  await assertNonEmpty(metrics.artifacts.vocab);
  if (metrics.artifacts.tokenizer) await assertNonEmpty(metrics.artifacts.tokenizer);

  const trainFile = findReportFile(datasetReport, "sft.train.jsonl");
  const validationFile = findReportFile(datasetReport, "sft.validation.jsonl");
  const trainRecords = await validateChatMlSplit(trainFile.path, "train", trainFile.lines);
  const validationRecords = await validateChatMlSplit(validationFile.path, "validation", validationFile.lines);
  assertNoOverlap(trainRecords.ids, validationRecords.ids);

  const first = metrics.history.at(0);
  const last = metrics.history.at(-1);
  if (!first || !last || last.val_loss >= first.val_loss) {
    throw new Error(`Validation loss did not improve: first=${first?.val_loss} last=${last?.val_loss}`);
  }

  const bestValLoss = bestValidationLoss(metrics);
  validateBestCheckpointMetadata(metrics, bestValLoss);
  const comparison = options.baselineMetricsPath
    ? await compareTrainingRuns(options.baselineMetricsPath, options.metricsPath)
    : undefined;

  return {
    status: "ok",
    accepted: datasetReport.accepted,
    train: datasetReport.train,
    validation: datasetReport.validation,
    parameters: metrics.parameters,
    firstValLoss: first.val_loss,
    bestValLoss,
    lastValLoss: last.val_loss,
    ...(metrics.artifacts.bestCheckpoint ? { bestCheckpoint: metrics.artifacts.bestCheckpoint } : {}),
    splitValidation: [
      { path: trainFile.path, split: "train", records: trainRecords.records, uniqueIds: trainRecords.ids.size },
      {
        path: validationFile.path,
        split: "validation",
        records: validationRecords.records,
        uniqueIds: validationRecords.ids.size,
      },
    ],
    ...(comparison ? { comparison } : {}),
  };
}

export async function compareTrainingRuns(
  baselineMetricsPath: string,
  candidateMetricsPath: string,
): Promise<TrainingRunComparison> {
  const baseline = trainingMetricsSchema.parse(JSON.parse(await readFile(baselineMetricsPath, "utf8")));
  const candidate = trainingMetricsSchema.parse(JSON.parse(await readFile(candidateMetricsPath, "utf8")));
  const baselineBestValLoss = bestValidationLoss(baseline);
  const candidateBestValLoss = bestValidationLoss(candidate);
  const absoluteImprovement = baselineBestValLoss - candidateBestValLoss;

  return {
    baselinePath: baselineMetricsPath,
    candidatePath: candidateMetricsPath,
    baselineBestValLoss,
    candidateBestValLoss,
    absoluteImprovement,
    improved: candidateBestValLoss < baselineBestValLoss,
  };
}

function findReportFile(datasetReport: DatasetReport, filename: string): z.infer<typeof datasetFileSchema> {
  const file = datasetReport.files.find((item) => basename(item.path) === filename);
  if (!file) throw new Error(`Dataset report is missing ${filename}`);
  return file;
}

async function validateChatMlSplit(
  path: string,
  expectedSplit: "train" | "validation",
  expectedLines: number,
): Promise<{ records: number; ids: Set<string> }> {
  const body = await readFile(path, "utf8");
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== expectedLines) {
    throw new Error(`Line count mismatch for ${path}: expected ${expectedLines}, got ${lines.length}`);
  }

  const ids = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    const parsed = chatMlRecordSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`Invalid ChatML record in ${path}:${index + 1}: ${parsed.error.message}`);
    }
    if (parsed.data.metadata.split !== expectedSplit) {
      throw new Error(
        `Wrong split label in ${path}:${index + 1}: expected ${expectedSplit}, got ${parsed.data.metadata.split}`,
      );
    }
    if (ids.has(parsed.data.metadata.id)) {
      throw new Error(`Duplicate example id in ${path}:${index + 1}: ${parsed.data.metadata.id}`);
    }
    ids.add(parsed.data.metadata.id);
  }

  return { records: lines.length, ids };
}

function assertNoOverlap(trainIds: Set<string>, validationIds: Set<string>): void {
  for (const id of trainIds) {
    if (validationIds.has(id)) throw new Error(`Train/validation overlap detected for example id: ${id}`);
  }
}

function bestValidationLoss(metrics: TrainingMetrics): number {
  return Math.min(...metrics.history.map((item) => item.val_loss));
}

function validateBestCheckpointMetadata(metrics: TrainingMetrics, bestValLoss: number): void {
  const hasBestCheckpoint = Boolean(metrics.artifacts.bestCheckpoint);
  const hasBestStep = metrics.best_checkpoint_step !== undefined;
  const hasBestLoss = metrics.best_checkpoint_val_loss !== undefined;
  if (!hasBestCheckpoint && !hasBestStep && !hasBestLoss) return;
  if (!hasBestCheckpoint || !hasBestStep || !hasBestLoss) {
    throw new Error("Best-checkpoint metadata must include artifact path, step, and validation loss together");
  }

  const historyPoint = metrics.history.find((item) => item.step === metrics.best_checkpoint_step);
  if (!historyPoint) throw new Error(`Best-checkpoint step ${metrics.best_checkpoint_step} is not present in history`);
  if (!nearlyEqual(historyPoint.val_loss, metrics.best_checkpoint_val_loss ?? Number.NaN)) {
    throw new Error(
      `Best-checkpoint validation loss mismatch: history=${historyPoint.val_loss} metadata=${metrics.best_checkpoint_val_loss}`,
    );
  }
  if (!nearlyEqual(bestValLoss, metrics.best_checkpoint_val_loss ?? Number.NaN)) {
    throw new Error(
      `Best-checkpoint validation loss is not the best history value: best=${bestValLoss} metadata=${metrics.best_checkpoint_val_loss}`,
    );
  }
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

async function fileInfo(path: string): Promise<{ bytes: number; sha256: string }> {
  const body = await readFile(path);
  return {
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function assertNonEmpty(path: string): Promise<void> {
  const info = await stat(path);
  if (info.size <= 0) throw new Error(`Expected non-empty artifact: ${path}`);
}
