import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { EvalReport } from "../eval/ToolEvalSuite";
import type { KnowledgeEvalReport } from "../eval/KnowledgeEvalSuite";
import type { BehaviorEvalReport } from "../eval/BehaviorEvalSuite";
import type { SpecialistRoutingReport } from "../eval/SpecialistRoutingEvalSuite";
import {
  applyPromotionGate,
  type PromotionGateResult,
  type PromotionThresholds,
} from "../eval/PromotionGate";
import {
  applyKnowledgePromotionGate,
  type KnowledgePromotionGateResult,
  type KnowledgePromotionThresholds,
} from "../eval/KnowledgePromotionGate";
import {
  applyBehaviorPromotionGate,
  type BehaviorPromotionGateResult,
  type BehaviorPromotionThresholds,
} from "../eval/BehaviorPromotionGate";
import {
  applySpecialistRoutingPromotionGate,
  type SpecialistRoutingPromotionResult,
  type SpecialistRoutingPromotionThresholds,
} from "../eval/SpecialistRoutingPromotionGate";
import { trainingMetricsSchema } from "./TrainingArtifactQuality";

const trainingRunMetadataSchema = z
  .object({
    model: z.string().default("unknown"),
    seed: z.number().int().optional(),
    device: z.string().optional(),
    train_records: z.number().int().positive().optional(),
    val_records: z.number().int().positive().optional(),
    train_tokens: z.number().int().positive().optional(),
    val_tokens: z.number().int().positive().optional(),
    vocab_size: z.number().int().positive().optional(),
    elapsed_seconds: z.number().positive().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .passthrough();

export interface TrainingRunSummary {
  rank?: number;
  runName: string;
  metricsPath: string;
  model: string;
  comparisonKey: string;
  trainSha256: string;
  validationSha256: string;
  seed?: number;
  device?: string;
  parameters: number;
  trainRecords?: number;
  validationRecords?: number;
  trainTokens?: number;
  validationTokens?: number;
  vocabSize?: number;
  elapsedSeconds?: number;
  tokensPerSecond?: number;
  stepsPerSecond?: number;
  firstValLoss: number;
  bestValLoss: number;
  bestStep: number;
  bestCheckpoint?: string;
  bestCheckpointStep?: number;
  bestCheckpointValLoss?: number;
  finalValLoss: number;
  absoluteLossDrop: number;
  relativeLossDrop: number;
  lossImprovedWithinRun: boolean;
  finalRegressedFromBest: boolean;
  artifactStatus: ArtifactStatus[];
  allArtifactsPresent: boolean;
  sampleDiagnostics: SampleDiagnostics;
  warnings: string[];
}

export interface ArtifactStatus {
  kind: "checkpoint" | "bestCheckpoint" | "vocab" | "tokenizer";
  path: string;
  exists: boolean;
  bytes?: number;
}

export interface SampleDiagnostics {
  chars: number;
  roleTokenCount: number;
  unknownTokenCount: number;
  unknownTokenRate: number;
  hasAssistantMarker: boolean;
}

export interface TrainingRunLeaderboard {
  runRoot: string;
  generatedAt: string;
  totalRuns: number;
  runs: TrainingRunSummary[];
}

export interface TrainingRunPromotionOptions {
  candidateMetricsPath: string;
  runRoot?: string;
  baselineMetricsPath?: string;
  model?: string;
  minAbsoluteLossImprovement?: number;
  maxUnknownTokenRate?: number;
}

export interface TrainingRunPromotionReport {
  status: "accepted" | "rejected" | "no_baseline";
  candidate: TrainingRunSummary;
  baseline?: TrainingRunSummary;
  absoluteImprovement?: number;
  relativeImprovement?: number;
  thresholds: {
    minAbsoluteLossImprovement: number;
    maxUnknownTokenRate: number;
  };
  reasons: string[];
}

export interface TrainingRunReportOptions {
  runRoot?: string;
  model?: string;
  candidateMetricsPath?: string;
  baselineMetricsPath?: string;
  minAbsoluteLossImprovement?: number;
  maxUnknownTokenRate?: number;
  toolReportPath?: string;
  toolBaselineReportPath?: string;
  toolThresholds?: Partial<PromotionThresholds>;
  knowledgeReportPath?: string;
  knowledgeBaselineReportPath?: string;
  knowledgeThresholds?: Partial<KnowledgePromotionThresholds>;
  behaviorReportPath?: string;
  behaviorBaselineReportPath?: string;
  behaviorThresholds?: Partial<BehaviorPromotionThresholds>;
  routerReportPath?: string;
  routerBaselineReportPath?: string;
  routerThresholds?: Partial<SpecialistRoutingPromotionThresholds>;
}

export interface TrainingRunToolEvidence {
  reportPath: string;
  baselineReportPath?: string;
  predictionModels: string[];
  candidateRunName?: string;
  candidateModelMatched?: boolean;
  warnings: string[];
  gate: PromotionGateResult;
}

export interface TrainingRunKnowledgeEvidence {
  reportPath: string;
  baselineReportPath?: string;
  predictionModels: string[];
  candidateRunName?: string;
  candidateModelMatched?: boolean;
  warnings: string[];
  gate: KnowledgePromotionGateResult;
}

export interface TrainingRunBehaviorEvidence {
  reportPath: string;
  baselineReportPath?: string;
  predictionModels: string[];
  candidateRunName?: string;
  candidateModelMatched?: boolean;
  warnings: string[];
  gate: BehaviorPromotionGateResult;
}

export interface TrainingRunRouterEvidence {
  reportPath: string;
  baselineReportPath?: string;
  predictionModels: string[];
  candidateRunName?: string;
  candidateModelMatched?: boolean;
  warnings: string[];
  gate: SpecialistRoutingPromotionResult;
}

export interface TrainingRunReport {
  leaderboard: TrainingRunLeaderboard;
  promotion?: TrainingRunPromotionReport;
  tool?: TrainingRunToolEvidence;
  knowledge?: TrainingRunKnowledgeEvidence;
  behavior?: TrainingRunBehaviorEvidence;
  router?: TrainingRunRouterEvidence;
}

type TrainingMetrics = z.infer<typeof trainingMetricsSchema>;

export async function buildTrainingRunReport(options?: TrainingRunReportOptions): Promise<TrainingRunReport> {
  const leaderboard = await buildTrainingRunLeaderboard({
    runRoot: options?.runRoot,
    ...(options?.model ? { model: options.model } : {}),
  });
  const promotion = options?.candidateMetricsPath
    ? await evaluateTrainingRunPromotion({
        candidateMetricsPath: options.candidateMetricsPath,
        runRoot: options.runRoot,
        ...(options.baselineMetricsPath ? { baselineMetricsPath: options.baselineMetricsPath } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.minAbsoluteLossImprovement !== undefined
          ? { minAbsoluteLossImprovement: options.minAbsoluteLossImprovement }
          : {}),
        ...(options.maxUnknownTokenRate !== undefined ? { maxUnknownTokenRate: options.maxUnknownTokenRate } : {}),
      })
    : undefined;
  const tool = options?.toolReportPath
    ? await readTrainingRunToolEvidence({
        reportPath: options.toolReportPath,
        ...(options.toolBaselineReportPath ? { baselineReportPath: options.toolBaselineReportPath } : {}),
        ...(promotion?.candidate ? { candidate: promotion.candidate } : {}),
        thresholds: options.toolThresholds,
      })
    : undefined;
  const knowledge = options?.knowledgeReportPath
    ? await readTrainingRunKnowledgeEvidence({
        reportPath: options.knowledgeReportPath,
        ...(options.knowledgeBaselineReportPath ? { baselineReportPath: options.knowledgeBaselineReportPath } : {}),
        ...(promotion?.candidate ? { candidate: promotion.candidate } : {}),
        thresholds: options.knowledgeThresholds,
      })
    : undefined;
  const behavior = options?.behaviorReportPath
    ? await readTrainingRunBehaviorEvidence({
        reportPath: options.behaviorReportPath,
        ...(options.behaviorBaselineReportPath ? { baselineReportPath: options.behaviorBaselineReportPath } : {}),
        ...(promotion?.candidate ? { candidate: promotion.candidate } : {}),
        thresholds: options.behaviorThresholds,
      })
    : undefined;
  const router = options?.routerReportPath
    ? await readTrainingRunRouterEvidence({
        reportPath: options.routerReportPath,
        ...(options.routerBaselineReportPath ? { baselineReportPath: options.routerBaselineReportPath } : {}),
        ...(promotion?.candidate ? { candidate: promotion.candidate } : {}),
        thresholds: options.routerThresholds,
      })
    : undefined;

  return {
    leaderboard,
    ...(promotion ? { promotion } : {}),
    ...(tool ? { tool } : {}),
    ...(knowledge ? { knowledge } : {}),
    ...(behavior ? { behavior } : {}),
    ...(router ? { router } : {}),
  };
}

export async function buildTrainingRunLeaderboard(options?: {
  runRoot?: string;
  model?: string;
  metricsPaths?: string[];
}): Promise<TrainingRunLeaderboard> {
  const runRoot = options?.runRoot ?? "training/runs";
  const metricsPaths = options?.metricsPaths ?? (await discoverTrainingRunMetrics(runRoot));
  const summaries = await Promise.all(metricsPaths.map((metricsPath) => readTrainingRunSummary(metricsPath)));
  const filtered = options?.model ? summaries.filter((summary) => summary.model === options.model) : summaries;
  const runs = filtered
    .sort((left, right) => {
      if (left.bestValLoss !== right.bestValLoss) return left.bestValLoss - right.bestValLoss;
      if (left.finalValLoss !== right.finalValLoss) return left.finalValLoss - right.finalValLoss;
      return (left.elapsedSeconds ?? Number.POSITIVE_INFINITY) - (right.elapsedSeconds ?? Number.POSITIVE_INFINITY);
    })
    .map((run, index) => ({ ...run, rank: index + 1 }));

  return {
    runRoot,
    generatedAt: new Date().toISOString(),
    totalRuns: runs.length,
    runs,
  };
}

async function readTrainingRunToolEvidence(options: {
  reportPath: string;
  baselineReportPath?: string;
  candidate?: TrainingRunSummary;
  thresholds?: Partial<PromotionThresholds>;
}): Promise<TrainingRunToolEvidence> {
  const candidate = await readToolEvalReport(options.reportPath);
  const baseline = options.baselineReportPath ? await readToolEvalReport(options.baselineReportPath) : undefined;
  const predictionModels = await readPredictionModels(candidate.predictionsPath);
  const candidateModelMatched = options.candidate
    ? predictionModels.length > 0 && predictionModels.some((model) => modelMatchesRunName(model, options.candidate?.runName ?? ""))
    : undefined;
  const warnings = predictionEvidenceWarnings({
    kind: "tool",
    predictionModels,
    candidate: options.candidate,
    candidateModelMatched,
  });
  const gate = applyPromotionGate({
    candidate,
    ...(baseline ? { baseline } : {}),
    ...(options.thresholds ? { thresholds: options.thresholds } : {}),
  });
  return {
    reportPath: options.reportPath,
    ...(options.baselineReportPath ? { baselineReportPath: options.baselineReportPath } : {}),
    predictionModels,
    ...(options.candidate ? { candidateRunName: options.candidate.runName } : {}),
    ...(candidateModelMatched !== undefined ? { candidateModelMatched } : {}),
    warnings,
    gate,
  };
}

async function readTrainingRunKnowledgeEvidence(options: {
  reportPath: string;
  baselineReportPath?: string;
  candidate?: TrainingRunSummary;
  thresholds?: Partial<KnowledgePromotionThresholds>;
}): Promise<TrainingRunKnowledgeEvidence> {
  const candidate = await readKnowledgeEvalReport(options.reportPath);
  const baseline = options.baselineReportPath ? await readKnowledgeEvalReport(options.baselineReportPath) : undefined;
  const predictionModels = await readPredictionModels(candidate.predictionsPath);
  const candidateModelMatched = options.candidate
    ? predictionModels.length > 0 && predictionModels.some((model) => modelMatchesRunName(model, options.candidate?.runName ?? ""))
    : undefined;
  const warnings = predictionEvidenceWarnings({
    kind: "knowledge",
    predictionModels,
    candidate: options.candidate,
    candidateModelMatched,
  });
  const gate = applyKnowledgePromotionGate({
    candidate,
    ...(baseline ? { baseline } : {}),
    ...(options.thresholds ? { thresholds: options.thresholds } : {}),
  });
  return {
    reportPath: options.reportPath,
    ...(options.baselineReportPath ? { baselineReportPath: options.baselineReportPath } : {}),
    predictionModels,
    ...(options.candidate ? { candidateRunName: options.candidate.runName } : {}),
    ...(candidateModelMatched !== undefined ? { candidateModelMatched } : {}),
    warnings,
    gate,
  };
}

async function readTrainingRunBehaviorEvidence(options: {
  reportPath: string;
  baselineReportPath?: string;
  candidate?: TrainingRunSummary;
  thresholds?: Partial<BehaviorPromotionThresholds>;
}): Promise<TrainingRunBehaviorEvidence> {
  const candidate = await readBehaviorEvalReport(options.reportPath);
  const baseline = options.baselineReportPath ? await readBehaviorEvalReport(options.baselineReportPath) : undefined;
  const predictionModels = await readPredictionModels(candidate.predictionsPath);
  const candidateModelMatched = options.candidate
    ? predictionModels.length > 0 && predictionModels.some((model) => modelMatchesRunName(model, options.candidate?.runName ?? ""))
    : undefined;
  const warnings = predictionEvidenceWarnings({
    kind: "behavior",
    predictionModels,
    candidate: options.candidate,
    candidateModelMatched,
  });
  const gate = applyBehaviorPromotionGate({
    candidate,
    ...(baseline ? { baseline } : {}),
    ...(options.thresholds ? { thresholds: options.thresholds } : {}),
  });
  return {
    reportPath: options.reportPath,
    ...(options.baselineReportPath ? { baselineReportPath: options.baselineReportPath } : {}),
    predictionModels,
    ...(options.candidate ? { candidateRunName: options.candidate.runName } : {}),
    ...(candidateModelMatched !== undefined ? { candidateModelMatched } : {}),
    warnings,
    gate,
  };
}

async function readTrainingRunRouterEvidence(options: {
  reportPath: string;
  baselineReportPath?: string;
  candidate?: TrainingRunSummary;
  thresholds?: Partial<SpecialistRoutingPromotionThresholds>;
}): Promise<TrainingRunRouterEvidence> {
  const candidate = await readRouterEvalReport(options.reportPath);
  const baseline = options.baselineReportPath ? await readRouterEvalReport(options.baselineReportPath) : undefined;
  const predictionModels = await readPredictionModels(candidate.predictionsPath);
  const candidateModelMatched = options.candidate
    ? predictionModels.length > 0 && predictionModels.some((model) => modelMatchesRunName(model, options.candidate?.runName ?? ""))
    : undefined;
  const warnings = predictionEvidenceWarnings({
    kind: "router",
    predictionModels,
    candidate: options.candidate,
    candidateModelMatched,
  });
  const gate = applySpecialistRoutingPromotionGate({
    candidate,
    ...(baseline ? { baseline } : {}),
    ...(options.thresholds ? { thresholds: options.thresholds } : {}),
  });
  return {
    reportPath: options.reportPath,
    ...(options.baselineReportPath ? { baselineReportPath: options.baselineReportPath } : {}),
    predictionModels,
    ...(options.candidate ? { candidateRunName: options.candidate.runName } : {}),
    ...(candidateModelMatched !== undefined ? { candidateModelMatched } : {}),
    warnings,
    gate,
  };
}

async function readToolEvalReport(path: string): Promise<EvalReport> {
  return JSON.parse(await readFile(path, "utf8")) as EvalReport;
}

async function readKnowledgeEvalReport(path: string): Promise<KnowledgeEvalReport> {
  return JSON.parse(await readFile(path, "utf8")) as KnowledgeEvalReport;
}

async function readBehaviorEvalReport(path: string): Promise<BehaviorEvalReport> {
  return JSON.parse(await readFile(path, "utf8")) as BehaviorEvalReport;
}

async function readRouterEvalReport(path: string): Promise<SpecialistRoutingReport> {
  return JSON.parse(await readFile(path, "utf8")) as SpecialistRoutingReport;
}

async function readPredictionModels(path: string): Promise<string[]> {
  const body = await readFile(path, "utf8");
  const models = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const prediction = JSON.parse(line) as { model?: unknown };
    if (typeof prediction.model === "string" && prediction.model.trim()) models.add(prediction.model.trim());
  }
  return [...models].sort();
}

function predictionEvidenceWarnings(input: {
  kind: "knowledge" | "tool" | "behavior" | "router";
  predictionModels: string[];
  candidate?: TrainingRunSummary;
  candidateModelMatched?: boolean;
}): string[] {
  const warnings: string[] = [];
  if (input.predictionModels.length === 0) warnings.push(`${input.kind}_predictions_missing_model_metadata`);
  if (input.candidate && input.candidateModelMatched === false) warnings.push(`${input.kind}_prediction_model_mismatch`);
  return warnings;
}

function modelMatchesRunName(model: string, runName: string): boolean {
  if (!runName) return false;
  const normalizedModel = model.toLowerCase();
  const normalizedRunName = runName.toLowerCase();
  return (
    normalizedModel === normalizedRunName ||
    normalizedModel.endsWith(`:${normalizedRunName}`) ||
    normalizedModel.endsWith(`/${normalizedRunName}`) ||
    normalizedModel.endsWith(`\\${normalizedRunName}`)
  );
}

export async function evaluateTrainingRunPromotion(
  options: TrainingRunPromotionOptions,
): Promise<TrainingRunPromotionReport> {
  const minAbsoluteLossImprovement = options.minAbsoluteLossImprovement ?? 0;
  const maxUnknownTokenRate = options.maxUnknownTokenRate ?? 0.12;
  const candidate = await readTrainingRunSummary(options.candidateMetricsPath);
  const baseline = options.baselineMetricsPath
    ? await readTrainingRunSummary(options.baselineMetricsPath)
    : await findBestBaseline({
        candidate,
        runRoot: options.runRoot ?? "training/runs",
        model: options.model ?? candidate.model,
      });

  const thresholds = { minAbsoluteLossImprovement, maxUnknownTokenRate };
  if (!baseline) {
    return {
      status: "no_baseline",
      candidate,
      thresholds,
      reasons: ["No comparable baseline run was found."],
    };
  }

  const absoluteImprovement = baseline.bestValLoss - candidate.bestValLoss;
  const relativeImprovement = baseline.bestValLoss > 0 ? absoluteImprovement / baseline.bestValLoss : 0;
  const reasons = promotionRejectionReasons(candidate, absoluteImprovement, thresholds);

  return {
    status: reasons.length === 0 ? "accepted" : "rejected",
    candidate,
    baseline,
    absoluteImprovement,
    relativeImprovement,
    thresholds,
    reasons,
  };
}

export async function readTrainingRunSummary(metricsPath: string): Promise<TrainingRunSummary> {
  const rawBody = await readFile(metricsPath, "utf8");
  const raw = JSON.parse(rawBody) as unknown;
  const metrics = trainingMetricsSchema.parse(raw);
  const metadata = trainingRunMetadataSchema.parse(raw);
  const first = metrics.history[0];
  const last = metrics.history.at(-1);
  if (!first || !last) throw new Error(`Metrics history is empty for ${metricsPath}`);

  const best = bestHistoryPoint(metrics);
  const elapsedSeconds = metadata.elapsed_seconds;
  const trainTokens = metadata.train_tokens;
  const steps = typeof metadata.config?.steps === "number" ? metadata.config.steps : undefined;
  const tokenizerMode = typeof metadata.config?.tokenizer_mode === "string" ? metadata.config.tokenizer_mode : "wordpunct";
  const lossScope = typeof metadata.config?.loss_scope === "string" ? metadata.config.loss_scope : "all";
  const absoluteLossDrop = first.val_loss - last.val_loss;
  const artifactStatus = await readArtifactStatus(metrics.artifacts);
  const sampleDiagnostics = inspectSample(metrics.sample);
  const finalRegressedFromBest = last.val_loss > best.val_loss * 1.02;
  const warnings = buildWarnings({
    metricsPath,
    metrics,
    firstValLoss: first.val_loss,
    finalValLoss: last.val_loss,
    bestValLoss: best.val_loss,
    finalRegressedFromBest,
    artifactStatus,
    sampleDiagnostics,
  });

  return {
    runName: basename(dirname(metricsPath)),
    metricsPath,
    model: metadata.model,
    comparisonKey: [metadata.model, metrics.val_sha256, metadata.vocab_size ?? "unknown-vocab", tokenizerMode, lossScope].join(
      ":",
    ),
    trainSha256: metrics.train_sha256,
    validationSha256: metrics.val_sha256,
    ...(metadata.seed !== undefined ? { seed: metadata.seed } : {}),
    ...(metadata.device ? { device: metadata.device } : {}),
    parameters: metrics.parameters,
    ...(metadata.train_records !== undefined ? { trainRecords: metadata.train_records } : {}),
    ...(metadata.val_records !== undefined ? { validationRecords: metadata.val_records } : {}),
    ...(trainTokens !== undefined ? { trainTokens } : {}),
    ...(metadata.val_tokens !== undefined ? { validationTokens: metadata.val_tokens } : {}),
    ...(metadata.vocab_size !== undefined ? { vocabSize: metadata.vocab_size } : {}),
    ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
    ...(trainTokens !== undefined && elapsedSeconds !== undefined
      ? { tokensPerSecond: round(trainTokens / elapsedSeconds, 2) }
      : {}),
    ...(steps !== undefined && elapsedSeconds !== undefined ? { stepsPerSecond: round(steps / elapsedSeconds, 3) } : {}),
    firstValLoss: first.val_loss,
    bestValLoss: best.val_loss,
    bestStep: best.step,
    ...(metrics.artifacts.bestCheckpoint ? { bestCheckpoint: metrics.artifacts.bestCheckpoint } : {}),
    ...(metrics.best_checkpoint_step !== undefined ? { bestCheckpointStep: metrics.best_checkpoint_step } : {}),
    ...(metrics.best_checkpoint_val_loss !== undefined
      ? { bestCheckpointValLoss: metrics.best_checkpoint_val_loss }
      : {}),
    finalValLoss: last.val_loss,
    absoluteLossDrop,
    relativeLossDrop: first.val_loss > 0 ? round(absoluteLossDrop / first.val_loss, 6) : 0,
    lossImprovedWithinRun: last.val_loss < first.val_loss,
    finalRegressedFromBest,
    artifactStatus,
    allArtifactsPresent: artifactStatus.every((item) => item.exists && (item.bytes ?? 0) > 0),
    sampleDiagnostics,
    warnings,
  };
}

async function discoverTrainingRunMetrics(runRoot: string): Promise<string[]> {
  const root = resolve(runRoot);
  const out: string[] = [];
  await walk(root, out);
  return out.sort();
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") return;
    throw err;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) await walk(fullPath, out);
    else if (entry.isFile() && entry.name === "metrics.json") out.push(fullPath);
  }
}

async function findBestBaseline(options: {
  candidate: TrainingRunSummary;
  runRoot: string;
  model: string;
}): Promise<TrainingRunSummary | undefined> {
  const candidatePath = resolve(options.candidate.metricsPath);
  const leaderboard = await buildTrainingRunLeaderboard({ runRoot: options.runRoot, model: options.model });
  return leaderboard.runs.find(
    (run) => resolve(run.metricsPath) !== candidatePath && run.comparisonKey === options.candidate.comparisonKey,
  );
}

function promotionRejectionReasons(
  candidate: TrainingRunSummary,
  absoluteImprovement: number,
  thresholds: { minAbsoluteLossImprovement: number; maxUnknownTokenRate: number },
): string[] {
  const reasons: string[] = [];
  if (!candidate.allArtifactsPresent) reasons.push("Candidate has missing or empty artifacts.");
  if (!candidate.lossImprovedWithinRun) reasons.push("Candidate validation loss did not improve within the run.");
  if (candidate.finalRegressedFromBest) reasons.push("Candidate final validation loss regressed more than 2% from its best step.");
  if (absoluteImprovement <= thresholds.minAbsoluteLossImprovement) {
    reasons.push(
      `Candidate best validation loss did not clear the baseline by more than ${thresholds.minAbsoluteLossImprovement}.`,
    );
  }
  if (candidate.sampleDiagnostics.unknownTokenRate > thresholds.maxUnknownTokenRate) {
    reasons.push(
      `Candidate sample unknown-token rate ${candidate.sampleDiagnostics.unknownTokenRate} exceeds ${thresholds.maxUnknownTokenRate}.`,
    );
  }
  return reasons;
}

function buildWarnings(input: {
  metricsPath: string;
  metrics: TrainingMetrics;
  firstValLoss: number;
  finalValLoss: number;
  bestValLoss: number;
  finalRegressedFromBest: boolean;
  artifactStatus: ArtifactStatus[];
  sampleDiagnostics: SampleDiagnostics;
}): string[] {
  const warnings: string[] = [];
  if (input.finalValLoss >= input.firstValLoss) warnings.push("validation_loss_did_not_improve");
  if (input.finalRegressedFromBest) warnings.push("final_validation_loss_regressed_from_best");
  if (input.artifactStatus.some((item) => !item.exists || (item.bytes ?? 0) <= 0)) warnings.push("missing_artifact");
  if (!input.sampleDiagnostics.hasAssistantMarker) warnings.push("sample_missing_assistant_marker");
  if (input.sampleDiagnostics.unknownTokenRate > 0.12) warnings.push("sample_high_unknown_token_rate");
  if (input.metrics.sample.length < 80) warnings.push("sample_too_short_for_review");
  return warnings;
}

function bestHistoryPoint(metrics: TrainingMetrics): { step: number; val_loss: number } {
  return metrics.history.reduce((best, item) => (item.val_loss < best.val_loss ? item : best));
}

async function readArtifactStatus(artifacts: TrainingMetrics["artifacts"]): Promise<ArtifactStatus[]> {
  const entries: ArtifactStatus[] = [
    await artifactInfo("checkpoint", artifacts.checkpoint),
  ];
  if (artifacts.bestCheckpoint) entries.push(await artifactInfo("bestCheckpoint", artifacts.bestCheckpoint));
  entries.push(await artifactInfo("vocab", artifacts.vocab));
  if (artifacts.tokenizer) entries.push(await artifactInfo("tokenizer", artifacts.tokenizer));
  return entries;
}

async function artifactInfo(kind: ArtifactStatus["kind"], path: string): Promise<ArtifactStatus> {
  try {
    const info = await stat(path);
    return { kind, path, exists: true, bytes: info.size };
  } catch (err) {
    const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") return { kind, path, exists: false };
    throw err;
  }
}

function inspectSample(sample: string): SampleDiagnostics {
  const unknownTokenCount = countMatches(sample, /<unk>/g);
  const tokenLikeCount = Math.max(1, sample.trim().split(/\s+/).length);
  return {
    chars: sample.length,
    roleTokenCount: countMatches(sample, /<\|(system|user|assistant)\|>/g),
    unknownTokenCount,
    unknownTokenRate: round(unknownTokenCount / tokenLikeCount, 6),
    hasAssistantMarker: sample.includes("<|assistant|>"),
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
