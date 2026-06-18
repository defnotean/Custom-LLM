import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  analyzeTrainingMixtureSequences,
  type TrainingMixtureSequenceReport,
} from "./TrainingMixtureSequenceStats";

const outputFileSchema = z.object({
  path: z.string().min(1),
  lines: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
});

const sourceSummarySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  required: z.boolean(),
  present: z.boolean(),
  kind: z.string().min(1),
  raw: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

const sftReportSchema = z.object({
  train: z.number().int().nonnegative(),
  validation: z.number().int().nonnegative(),
  maxSyntheticShare: z.number().min(0).max(1),
  syntheticTrainShare: z.number().min(0).max(1),
  sources: z.array(sourceSummarySchema),
  files: z.array(outputFileSchema).min(1),
});

const preferenceReportSchema = z.object({
  train: z.number().int().nonnegative(),
  validation: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  synthetic: z.number().int().nonnegative(),
  syntheticShare: z.number().min(0).max(1),
  syntheticOnly: z.boolean(),
  sources: z.array(sourceSummarySchema),
  files: z.array(outputFileSchema).min(1),
});

const toolEvalReportSchema = z.object({
  total: z.number().int().nonnegative(),
  validJsonRate: z.number().min(0).max(1),
  actionTypeAccuracy: z.number().min(0).max(1),
  toolNameAccuracy: z.number().min(0).max(1).nullable(),
  toolArgumentValidity: z.number().min(0).max(1).nullable(),
  noToolAccuracy: z.number().min(0).max(1).nullable(),
  hallucinatedToolRate: z.number().min(0).max(1),
  missingPredictions: z.number().int().nonnegative(),
  failures: z.array(z.unknown()),
});

const knowledgeEvalReportSchema = z.object({
  total: z.number().int().nonnegative(),
  answerRate: z.number().min(0).max(1),
  averageTokenF1: z.number().min(0).max(1),
  averageRougeL: z.number().min(0).max(1),
  missingPredictions: z.number().int().nonnegative(),
  lowScoreCount: z.number().int().nonnegative(),
  failures: z.array(z.unknown()),
});

const behaviorEvalReportSchema = z.object({
  total: z.number().int().nonnegative(),
  validJsonRate: z.number().min(0).max(1),
  actionTypeAccuracy: z.number().min(0).max(1),
  requirementPassRate: z.number().min(0).max(1),
  personaConsistencyRate: z.number().min(0).max(1).nullable(),
  socialCueAccuracy: z.number().min(0).max(1).nullable(),
  casualToneAccuracy: z.number().min(0).max(1).nullable(),
  toolAbstainAccuracy: z.number().min(0).max(1).nullable(),
  boundaryAccuracy: z.number().min(0).max(1).nullable(),
  missingPredictions: z.number().int().nonnegative(),
  failures: z.array(z.unknown()),
});

export type ProductionTrainingStage = "sft" | "dpo" | "all";
export type ReadinessStatus = "ready" | "not_ready";
export type ReadinessCheckStatus = "pass" | "warn" | "fail";

export interface ProductionTrainingReadinessOptions {
  stage?: ProductionTrainingStage;
  sftReportPath?: string;
  preferenceReportPath?: string;
  toolEvalReportPath?: string;
  knowledgeEvalReportPath?: string;
  behaviorEvalReportPath?: string;
  axolotlSftConfigPath?: string;
  axolotlDpoConfigPath?: string;
  unslothSftConfigPath?: string;
  unslothDpoConfigPath?: string;
  sftTrainPath?: string;
  sftValidationPath?: string;
  sequenceLength?: number;
  maxSftOverLengthRate?: number;
  maxSftTokenBudgetUsage?: number;
  minSftPackingEfficiency?: number;
  minSftTrainRecords?: number;
  minSftValidationRecords?: number;
  maxSyntheticTrainShare?: number;
  minPreferenceRecords?: number;
  allowSyntheticOnlyPreferences?: boolean;
}

export interface ReadinessCheck {
  id: string;
  status: ReadinessCheckStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ProductionTrainingReadinessReport {
  status: ReadinessStatus;
  stage: ProductionTrainingStage;
  generatedAt: string;
  summary: {
    sftTrain: number;
    sftValidation: number;
    syntheticTrainShare: number;
    sequenceLength: number;
    sftTrainP95Tokens: number;
    sftTrainMaxTokens: number;
    sftTrainMaxBudgetUsage: number;
    sftTrainOverLengthRate: number;
    sftEstimatedPackedSequences: number;
    sftPackingEfficiency: number;
    preferenceTotal: number;
    preferenceSyntheticOnly: boolean;
  };
  checks: ReadinessCheck[];
}

type SftReport = z.infer<typeof sftReportSchema>;
type PreferenceReport = z.infer<typeof preferenceReportSchema>;
type ToolEvalReport = z.infer<typeof toolEvalReportSchema>;
type KnowledgeEvalReport = z.infer<typeof knowledgeEvalReportSchema>;
type BehaviorEvalReport = z.infer<typeof behaviorEvalReportSchema>;

const DEFAULTS = {
  stage: "sft" as ProductionTrainingStage,
  sftReportPath: "training/data/mixtures/production-sft.report.json",
  preferenceReportPath: "training/data/preferences/production-dpo.report.json",
  toolEvalReportPath: "training/evals/oracle.report.json",
  knowledgeEvalReportPath: "training/evals/knowledge-oracle.report.json",
  behaviorEvalReportPath: "training/evals/behavior-oracle.report.json",
  axolotlSftConfigPath: "training/configs/axolotl/qwen3-qlora-sft.yaml",
  axolotlDpoConfigPath: "training/configs/axolotl/qwen3-qlora-dpo.yaml",
  unslothSftConfigPath: "training/configs/unsloth/qwen3_qlora_sft.py",
  unslothDpoConfigPath: "training/configs/unsloth/qwen3_dpo.py",
  sequenceLength: 2048,
  maxSftOverLengthRate: 0,
  maxSftTokenBudgetUsage: 0.95,
  minSftPackingEfficiency: 0.5,
  minSftTrainRecords: 1000,
  minSftValidationRecords: 100,
  minPreferenceRecords: 50,
};

type ResolvedReadinessOptions = typeof DEFAULTS &
  Pick<
    ProductionTrainingReadinessOptions,
    "maxSyntheticTrainShare" | "allowSyntheticOnlyPreferences" | "sftTrainPath" | "sftValidationPath"
  >;

export async function checkProductionTrainingReadiness(
  options: ProductionTrainingReadinessOptions = {},
): Promise<ProductionTrainingReadinessReport> {
  const config = { ...DEFAULTS, ...options };
  const sftReport = await readJson(config.sftReportPath, sftReportSchema);
  const preferenceReport = await readJson(config.preferenceReportPath, preferenceReportSchema);
  const sequenceReport = await analyzeTrainingMixtureSequences({
    trainPath: config.sftTrainPath ?? findOutputPath(sftReport, "train"),
    validationPath: config.sftValidationPath ?? findOutputPath(sftReport, "validation"),
    sequenceLength: config.sequenceLength,
    topLongest: 5,
  });
  const [toolEvalReport, knowledgeEvalReport, behaviorEvalReport] = await Promise.all([
    readJson(config.toolEvalReportPath, toolEvalReportSchema),
    readJson(config.knowledgeEvalReportPath, knowledgeEvalReportSchema),
    readJson(config.behaviorEvalReportPath, behaviorEvalReportSchema),
  ]);
  const [axolotlSft, axolotlDpo, unslothSft, unslothDpo] = await Promise.all([
    readFile(config.axolotlSftConfigPath, "utf8"),
    readFile(config.axolotlDpoConfigPath, "utf8"),
    readFile(config.unslothSftConfigPath, "utf8"),
    readFile(config.unslothDpoConfigPath, "utf8"),
  ]);

  const checks: ReadinessCheck[] = [];
  checks.push(...(await sftChecks(sftReport, config)));
  checks.push(...sftSequenceChecks(sequenceReport, config));
  checks.push(...sftConfigChecks(axolotlSft, unslothSft));
  checks.push(...evalHarnessChecks(toolEvalReport, knowledgeEvalReport, behaviorEvalReport));

  if (config.stage === "dpo" || config.stage === "all") {
    checks.push(...dpoChecks(preferenceReport, config, true));
    checks.push(...dpoConfigChecks(axolotlDpo, unslothDpo));
  } else {
    checks.push(...dpoChecks(preferenceReport, config, false));
  }

  return {
    status: checks.some((check) => check.status === "fail") ? "not_ready" : "ready",
    stage: config.stage,
    generatedAt: new Date().toISOString(),
    summary: {
      sftTrain: sftReport.train,
      sftValidation: sftReport.validation,
      syntheticTrainShare: round(sftReport.syntheticTrainShare),
      sequenceLength: sequenceReport.sequenceLength,
      sftTrainP95Tokens: sequenceReport.train.p95Tokens,
      sftTrainMaxTokens: sequenceReport.train.maxTokens,
      sftTrainMaxBudgetUsage: sequenceReport.train.maxTokenBudgetUsage,
      sftTrainOverLengthRate: sequenceReport.train.overLengthRate,
      sftEstimatedPackedSequences: sequenceReport.train.estimatedPackedSequences,
      sftPackingEfficiency: sequenceReport.train.packingEfficiency,
      preferenceTotal: preferenceReport.total,
      preferenceSyntheticOnly: preferenceReport.syntheticOnly,
    },
    checks,
  };
}

async function sftChecks(
  report: SftReport,
  options: ResolvedReadinessOptions,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  checks.push(await verifyOutputFiles("sft-output-files", report.files));
  checks.push(
    report.train >= options.minSftTrainRecords && report.validation >= options.minSftValidationRecords
      ? pass("sft-volume", `SFT mixture has ${report.train} train and ${report.validation} validation records`)
      : fail("sft-volume", "SFT mixture is too small for a production QLoRA run", {
          train: report.train,
          validation: report.validation,
          minTrain: options.minSftTrainRecords,
          minValidation: options.minSftValidationRecords,
        }),
  );

  const maxSyntheticShare = options.maxSyntheticTrainShare ?? report.maxSyntheticShare;
  checks.push(
    report.syntheticTrainShare <= maxSyntheticShare
      ? pass("sft-synthetic-share", `Synthetic SFT share is ${round(report.syntheticTrainShare)}`)
      : fail("sft-synthetic-share", "Synthetic SFT share exceeds the configured cap", {
          syntheticTrainShare: report.syntheticTrainShare,
          maxSyntheticShare,
        }),
  );

  const requiredMissing = report.sources.filter((source) => source.required && (!source.present || source.accepted === 0));
  checks.push(
    requiredMissing.length === 0
      ? pass("sft-required-sources", "All required SFT sources are present and accepted records")
      : fail("sft-required-sources", "Required SFT source is missing or empty", { requiredMissing }),
  );

  const firstPartyAccepted = report.sources
    .filter((source) => source.kind === "bot_log" || source.kind === "tool_calling")
    .reduce((sum, source) => sum + source.accepted, 0);
  checks.push(
    firstPartyAccepted > 0
      ? pass("sft-first-party-signal", `SFT mixture includes ${firstPartyAccepted} first-party bot/tool records`)
      : warn(
          "sft-first-party-signal",
          "SFT mixture is open-data/synthetic only; fine for scaffolding, not enough for the final bot personality",
        ),
  );
  return checks;
}

function sftSequenceChecks(
  report: TrainingMixtureSequenceReport,
  options: ResolvedReadinessOptions,
): ReadinessCheck[] {
  const maxOverLengthRate = options.maxSftOverLengthRate;
  const maxTokenBudgetUsage = options.maxSftTokenBudgetUsage;
  const minPackingEfficiency = options.minSftPackingEfficiency;
  return [
    report.train.overLengthRate <= maxOverLengthRate && report.validation.overLengthRate <= maxOverLengthRate
      ? pass(
          "sft-sequence-length",
          `Estimated over-length rate is ${report.train.overLengthRate} train / ${report.validation.overLengthRate} validation`,
          {
            sequenceLength: report.sequenceLength,
            trainP95Tokens: report.train.p95Tokens,
            trainMaxTokens: report.train.maxTokens,
            validationMaxTokens: report.validation.maxTokens,
          },
        )
      : fail("sft-sequence-length", "Estimated over-length rate exceeds the configured sequence budget", {
          sequenceLength: report.sequenceLength,
          maxOverLengthRate,
          trainOverLengthRate: report.train.overLengthRate,
          validationOverLengthRate: report.validation.overLengthRate,
          longestTrain: report.train.longest,
          longestValidation: report.validation.longest,
        }),
    report.train.maxTokenBudgetUsage <= maxTokenBudgetUsage &&
    report.validation.maxTokenBudgetUsage <= maxTokenBudgetUsage
      ? pass(
          "sft-token-headroom",
          `Estimated max token budget usage is ${report.train.maxTokenBudgetUsage} train / ${report.validation.maxTokenBudgetUsage} validation`,
          {
            maxTokenBudgetUsage,
            trainMaxTokens: report.train.maxTokens,
            validationMaxTokens: report.validation.maxTokens,
            sequenceLength: report.sequenceLength,
          },
        )
      : fail("sft-token-headroom", "Estimated longest rows leave too little tokenizer headroom", {
          maxTokenBudgetUsage,
          trainMaxTokenBudgetUsage: report.train.maxTokenBudgetUsage,
          validationMaxTokenBudgetUsage: report.validation.maxTokenBudgetUsage,
          longestTrain: report.train.longest,
          longestValidation: report.validation.longest,
        }),
    report.train.packingEfficiency >= minPackingEfficiency
      ? pass("sft-packing-efficiency", `Estimated train packing efficiency is ${report.train.packingEfficiency}`, {
          sequenceLength: report.sequenceLength,
          estimatedPackedSequences: report.train.estimatedPackedSequences,
          estimatedTokens: report.train.estimatedTokens,
        })
      : warn("sft-packing-efficiency", "Estimated train packing efficiency is low; review sequence length or packing", {
          minPackingEfficiency,
          packingEfficiency: report.train.packingEfficiency,
          estimatedPackedSequences: report.train.estimatedPackedSequences,
        }),
  ];
}

function sftConfigChecks(axolotl: string, unsloth: string): ReadinessCheck[] {
  return [
    includesAll("sft-axolotl-config", axolotl, [
      "base_model: Qwen/Qwen3-4B-Instruct-2507",
      "adapter: qlora",
      "load_in_4bit: true",
      "sample_packing: true",
      "gradient_checkpointing: true",
      "train_on_inputs: false",
      "roles_to_train:",
      "- assistant",
      "train_on_eos: turn",
    ]),
    includesAll("sft-unsloth-config", unsloth, [
      "unsloth/Qwen3-4B-Instruct-2507-bnb-4bit",
      "load_in_4bit=True",
      "assistant_only_loss=True",
      "packing=True",
      "optim=\"adamw_8bit\"",
    ]),
    noQwen35Qlora("sft-no-qwen35-qlora", `${axolotl}\n${unsloth}`),
  ];
}

function dpoChecks(
  report: PreferenceReport,
  options: ResolvedReadinessOptions,
  failOnNotReady: boolean,
): ReadinessCheck[] {
  const statusWhenNotReady: ReadinessCheckStatus = failOnNotReady ? "fail" : "warn";
  const checks: ReadinessCheck[] = [
    report.total >= options.minPreferenceRecords
      ? pass("dpo-preference-volume", `Preference mixture has ${report.total} prompt/chosen/rejected rows`)
      : check(
          "dpo-preference-volume",
          statusWhenNotReady,
          "Preference mixture is too small for production DPO",
          { total: report.total, minPreferenceRecords: options.minPreferenceRecords },
        ),
    !report.syntheticOnly || options.allowSyntheticOnlyPreferences
      ? pass("dpo-real-preferences", "Preference mixture has non-synthetic preference signal or synthetic-only mode is allowed")
      : check(
          "dpo-real-preferences",
          statusWhenNotReady,
          "Preference mixture is synthetic-only; do not use for final tone or answer-quality alignment",
          { syntheticOnly: report.syntheticOnly, syntheticShare: report.syntheticShare },
        ),
  ];
  checks.push(
    report.total > 0 ? pass("dpo-files-present", "Preference output files exist") : check("dpo-files-present", statusWhenNotReady, "Preference mixture is empty"),
  );
  return checks;
}

function dpoConfigChecks(axolotl: string, unsloth: string): ReadinessCheck[] {
  return [
    includesAll("dpo-axolotl-config", axolotl, [
      "base_model: Qwen/Qwen3-4B-Instruct-2507",
      "rl: dpo",
      "adapter: qlora",
      "load_in_4bit: true",
      "type: chatml.prompt_pairs",
      "dpo_beta: 0.1",
    ]),
    includesAll("dpo-unsloth-config", unsloth, [
      "unsloth/Qwen3-4B-Instruct-2507-bnb-4bit",
      "DPOTrainer",
      "DPOConfig",
      "load_in_4bit=True",
      "beta=0.1",
    ]),
    noQwen35Qlora("dpo-no-qwen35-qlora", `${axolotl}\n${unsloth}`),
  ];
}

function evalHarnessChecks(
  toolReport: ToolEvalReport,
  knowledgeReport: KnowledgeEvalReport,
  behaviorReport: BehaviorEvalReport,
): ReadinessCheck[] {
  return [
    toolReport.total >= 10 &&
    toolReport.validJsonRate >= 0.98 &&
    toolReport.actionTypeAccuracy >= 0.9 &&
    toolReport.hallucinatedToolRate <= 0.02 &&
    toolReport.missingPredictions === 0 &&
    toolReport.failures.length === 0
      ? pass("tool-eval-harness", `Tool eval harness is healthy with ${toolReport.total} oracle cases`)
      : fail("tool-eval-harness", "Tool eval oracle report does not satisfy promotion-gate expectations", toolReport),
    knowledgeReport.total >= 50 &&
    knowledgeReport.answerRate >= 0.95 &&
    knowledgeReport.averageTokenF1 >= 0.35 &&
    knowledgeReport.averageRougeL >= 0.35 &&
    knowledgeReport.missingPredictions === 0 &&
    knowledgeReport.failures.length === 0
      ? pass("knowledge-eval-harness", `Knowledge eval harness is healthy with ${knowledgeReport.total} oracle cases`)
      : fail("knowledge-eval-harness", "Knowledge eval oracle report does not satisfy promotion-gate expectations", {
          total: knowledgeReport.total,
          answerRate: knowledgeReport.answerRate,
          averageTokenF1: knowledgeReport.averageTokenF1,
          averageRougeL: knowledgeReport.averageRougeL,
          missingPredictions: knowledgeReport.missingPredictions,
          failures: knowledgeReport.failures.length,
        }),
    behaviorReport.total >= 10 &&
    behaviorReport.validJsonRate >= 0.98 &&
    behaviorReport.actionTypeAccuracy >= 0.95 &&
    behaviorReport.requirementPassRate >= 0.9 &&
    behaviorReport.personaConsistencyRate === 1 &&
    (behaviorReport.socialCueAccuracy ?? 0) >= 0.9 &&
    (behaviorReport.casualToneAccuracy ?? 0) >= 0.9 &&
    behaviorReport.toolAbstainAccuracy === 1 &&
    behaviorReport.boundaryAccuracy === 1 &&
    behaviorReport.missingPredictions === 0 &&
    behaviorReport.failures.length === 0
      ? pass("behavior-eval-harness", `Behavior eval harness is healthy with ${behaviorReport.total} oracle cases`)
      : fail("behavior-eval-harness", "Behavior eval oracle report does not satisfy promotion-gate expectations", {
          total: behaviorReport.total,
          validJsonRate: behaviorReport.validJsonRate,
          actionTypeAccuracy: behaviorReport.actionTypeAccuracy,
          requirementPassRate: behaviorReport.requirementPassRate,
          personaConsistencyRate: behaviorReport.personaConsistencyRate,
          socialCueAccuracy: behaviorReport.socialCueAccuracy,
          casualToneAccuracy: behaviorReport.casualToneAccuracy,
          toolAbstainAccuracy: behaviorReport.toolAbstainAccuracy,
          boundaryAccuracy: behaviorReport.boundaryAccuracy,
          missingPredictions: behaviorReport.missingPredictions,
          failures: behaviorReport.failures.length,
        }),
  ];
}

async function verifyOutputFiles(id: string, files: Array<z.infer<typeof outputFileSchema>>): Promise<ReadinessCheck> {
  const mismatches = [];
  for (const file of files) {
    const actual = await fileInfo(file.path);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
      mismatches.push({ path: file.path, expectedBytes: file.bytes, actualBytes: actual.bytes });
    }
  }
  return mismatches.length === 0
    ? pass(id, `Verified ${files.length} output file hashes`)
    : fail(id, "Output files do not match the recorded report hashes", { mismatches });
}

function findOutputPath(report: SftReport, split: "train" | "validation"): string {
  const marker = split === "train" ? ".train.jsonl" : ".validation.jsonl";
  const file = report.files.find((item) => item.path.endsWith(marker));
  if (!file) throw new Error(`SFT report is missing a ${split} output file ending with ${marker}`);
  return file.path;
}

function includesAll(id: string, body: string, needles: string[]): ReadinessCheck {
  const missing = needles.filter((needle) => !body.includes(needle));
  return missing.length === 0
    ? pass(id, "Config contains the required production training settings")
    : fail(id, "Config is missing required production training settings", { missing });
}

function noQwen35Qlora(id: string, body: string): ReadinessCheck {
  const hasQwen35 = /qwen3\.5/i.test(body);
  const hasFourBitTraining = /load_in_4bit\s*[:=]\s*true/i.test(body) || /adapter:\s*qlora/i.test(body);
  return hasQwen35 && hasFourBitTraining
    ? fail(id, "Qwen3.5 is configured with QLoRA/4-bit training, which is blocked for this readiness profile")
    : pass(id, "No blocked Qwen3.5 QLoRA configuration detected");
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function fileInfo(path: string): Promise<{ bytes: number; sha256: string }> {
  const body = await readFile(path);
  return {
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function pass(id: string, summary: string, details?: Record<string, unknown>): ReadinessCheck {
  return check(id, "pass", summary, details);
}

function warn(id: string, summary: string, details?: Record<string, unknown>): ReadinessCheck {
  return check(id, "warn", summary, details);
}

function fail(id: string, summary: string, details?: Record<string, unknown>): ReadinessCheck {
  return check(id, "fail", summary, details);
}

function check(
  id: string,
  status: ReadinessCheckStatus,
  summary: string,
  details?: Record<string, unknown>,
): ReadinessCheck {
  return { id, status, summary, ...(details ? { details } : {}) };
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
