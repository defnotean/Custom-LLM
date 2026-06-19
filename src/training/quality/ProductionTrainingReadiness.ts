import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  analyzeTrainingMixtureSequences,
  type TrainingMixtureSequenceReport,
} from "./TrainingMixtureSequenceStats";
import {
  checkSubquadraticArchitectureReadiness,
  type SubquadraticArchitectureReadinessReport,
} from "./SubquadraticArchitectureReadiness";
import {
  checkDatasetGovernanceReadiness,
  type DatasetGovernanceReadinessReport,
} from "./DatasetGovernanceReadiness";
import {
  DEFAULT_CONTAMINATION_EVAL_PATHS,
  DEFAULT_CONTAMINATION_TRAIN_PATHS,
  auditDataContamination,
  type DataContaminationAuditReport,
} from "./DataContaminationAudit";
import {
  checkToolProtocolCoverageReadiness,
  type ToolProtocolCoverageReadinessReport,
} from "./ToolProtocolCoverageReadiness";
import {
  checkBehaviorCoverageReadiness,
  type BehaviorCoverageReadinessReport,
} from "./BehaviorCoverageReadiness";
import {
  checkSpecialistRoutingCoverageReadiness,
  type SpecialistRoutingCoverageReadinessReport,
} from "./SpecialistRoutingCoverageReadiness";

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

const voiceEvalReportSchema = z.object({
  total: z.number().int().nonnegative(),
  transcriptExactRate: z.number().min(0).max(1),
  averageTranscriptTokenF1: z.number().min(0).max(1),
  speakerAttributionAccuracy: z.number().min(0).max(1),
  responseDecisionAccuracy: z.number().min(0).max(1),
  latencyPassRate: z.number().min(0).max(1),
  socialTimingPassRate: z.number().min(0).max(1),
  retentionPolicyPassRate: z.number().min(0).max(1),
  missingPredictions: z.number().int().nonnegative(),
  failures: z.array(z.unknown()),
});

const routerEvalReportSchema = z.object({
  total: z.number().int().nonnegative(),
  routeAccuracy: z.number().min(0).max(1),
  expertAccuracy: z.number().min(0).max(1),
  toolVsNonToolAccuracy: z.number().min(0).max(1),
  missingPredictions: z.number().int().nonnegative(),
  invalidPredictions: z.number().int().nonnegative(),
  failures: z.array(z.unknown()),
});

const toolRouterEvalReportSchema = z.object({
  total: z.number().int().nonnegative(),
  expectedToolRecall: z.number().min(0).max(1),
  caseRecallAccuracy: z.number().min(0).max(1),
  top1Accuracy: z.number().min(0).max(1).nullable(),
  likelyNeedsToolAccuracy: z.number().min(0).max(1),
  noToolAccuracy: z.number().min(0).max(1).nullable(),
  forbiddenCandidateRate: z.number().min(0).max(1),
  missingExpectedTools: z.number().int().nonnegative(),
  forbiddenCandidateHits: z.number().int().nonnegative(),
  failures: z.array(z.unknown()),
});

const longContextEvalReportSchema = z.object({
  total: z.number().int().nonnegative(),
  answerRate: z.number().min(0).max(1),
  exactMatchRate: z.number().min(0).max(1),
  expectedContainRate: z.number().min(0).max(1),
  missingPredictions: z.number().int().nonnegative(),
  falsePositiveRate: z.number().min(0).max(1),
  failures: z.array(z.unknown()),
});

const memoryContinuityGateSchema = z.object({
  status: z.enum(["pass", "fail"]),
  candidate: z.object({
    suitePath: z.string().min(1),
    total: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1),
    storedExpectedRate: z.number().min(0).max(1),
    recallHitRate: z.number().min(0).max(1),
    isolationPassRate: z.number().min(0).max(1),
    forgetPassRate: z.number().min(0).max(1),
    policyRejectionPassRate: z.number().min(0).max(1),
    learnedItemPassRate: z.number().min(0).max(1),
    failures: z.number().int().nonnegative(),
    latencyP95Ms: z.number().nonnegative().nullable(),
  }),
  failures: z.array(z.unknown()),
  warnings: z.array(z.unknown()),
});

const skillRetrievalGateSchema = z.object({
  status: z.enum(["pass", "fail"]),
  candidate: z.object({
    suitePath: z.string().min(1),
    total: z.number().int().nonnegative(),
    recallAtK: z.number().min(0).max(1),
    precisionAtK: z.number().min(0).max(1),
    top1Accuracy: z.number().min(0).max(1),
    noHitAccuracy: z.number().min(0).max(1),
    forbiddenHits: z.number().int().nonnegative(),
    missingExpected: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    latencyP95Ms: z.number().nonnegative().nullable(),
  }),
  failures: z.array(z.unknown()),
  warnings: z.array(z.unknown()),
});

export type ProductionTrainingStage = "sft" | "dpo" | "all";
export type ReadinessStatus = "ready" | "not_ready";
export type ReadinessCheckStatus = "pass" | "warn" | "fail";

export interface ProductionTrainingReadinessOptions {
  stage?: ProductionTrainingStage;
  sftReportPath?: string;
  preferenceReportPath?: string;
  toolEvalSuitePath?: string;
  behaviorEvalSuitePath?: string;
  toolEvalReportPath?: string;
  knowledgeEvalReportPath?: string;
  behaviorEvalReportPath?: string;
  voiceEvalReportPath?: string;
  routerEvalSuitePath?: string;
  routerEvalReportPath?: string;
  toolRouterEvalReportPath?: string;
  longContextEvalReportPath?: string;
  memoryContinuityGatePath?: string;
  skillRetrievalGatePath?: string;
  rawDatasetManifestPath?: string;
  processedDatasetReportPath?: string;
  datasetPreparerSourcePath?: string;
  longContextSuitePath?: string;
  llmRouterSourcePath?: string;
  tinyTrainerPath?: string;
  tinyEvaluatorPath?: string;
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
  toolProtocolCoverageMinCases?: number;
  behaviorCoverageMinCases?: number;
  routerCoverageMinCases?: number;
  contaminationTrainPaths?: string[];
  contaminationEvalPaths?: string[];
  contaminationNgramSize?: number;
  contaminationOverlapThreshold?: number;
  maxContaminationExactIdMatches?: number;
  maxContaminationExactTextMatches?: number;
  maxContaminationHighOverlapMatches?: number;
  minSftTrainRecords?: number;
  minSftValidationRecords?: number;
  maxSyntheticTrainShare?: number;
  minDatasetAcceptedRecords?: number;
  minDatasetValidationRecords?: number;
  minDatasetEvalSeedRecords?: number;
  minDatasetEvalSeedSourceShare?: number;
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
type VoiceEvalReport = z.infer<typeof voiceEvalReportSchema>;
type RouterEvalReport = z.infer<typeof routerEvalReportSchema>;
type ToolRouterEvalReport = z.infer<typeof toolRouterEvalReportSchema>;
type LongContextEvalReport = z.infer<typeof longContextEvalReportSchema>;
type MemoryContinuityGateReport = z.infer<typeof memoryContinuityGateSchema>;
type SkillRetrievalGateReport = z.infer<typeof skillRetrievalGateSchema>;

const DEFAULTS = {
  stage: "sft" as ProductionTrainingStage,
  sftReportPath: "training/data/mixtures/production-sft.report.json",
  preferenceReportPath: "training/data/preferences/production-dpo.report.json",
  toolEvalSuitePath: "training/evals/tool-routing.eval.jsonl",
  behaviorEvalSuitePath: "training/evals/behavior.eval.jsonl",
  toolEvalReportPath: "training/evals/oracle.report.json",
  knowledgeEvalReportPath: "training/evals/knowledge-oracle.report.json",
  behaviorEvalReportPath: "training/evals/behavior-oracle.report.json",
  voiceEvalReportPath: "training/evals/voice-oracle.report.json",
  routerEvalSuitePath: "training/evals/specialist-routing.eval.jsonl",
  routerEvalReportPath: "training/evals/specialist-routing-oracle.report.json",
  toolRouterEvalReportPath: "training/evals/tool-router-keyword.report.json",
  longContextEvalReportPath: "training/evals/long-context-oracle.report.json",
  memoryContinuityGatePath: "training/evals/memory-continuity.gate.json",
  skillRetrievalGatePath: "training/evals/skill-retrieval.gate.json",
  rawDatasetManifestPath: "training/data/raw/dataset_manifest.json",
  processedDatasetReportPath: "training/data/processed/dataset_report.json",
  datasetPreparerSourcePath: "src/training/external/OpenDatasetPreparer.ts",
  longContextSuitePath: "training/evals/long-context.eval.jsonl",
  llmRouterSourcePath: "src/ai/llm/LLMRouter.ts",
  tinyTrainerPath: "training/train_tiny_transformer_lm.py",
  tinyEvaluatorPath: "training/evaluate_tiny_transformer_lm.py",
  axolotlSftConfigPath: "training/configs/axolotl/qwen3-qlora-sft.yaml",
  axolotlDpoConfigPath: "training/configs/axolotl/qwen3-qlora-dpo.yaml",
  unslothSftConfigPath: "training/configs/unsloth/qwen3_qlora_sft.py",
  unslothDpoConfigPath: "training/configs/unsloth/qwen3_dpo.py",
  sequenceLength: 2048,
  maxSftOverLengthRate: 0,
  maxSftTokenBudgetUsage: 0.95,
  minSftPackingEfficiency: 0.5,
  toolProtocolCoverageMinCases: 250,
  behaviorCoverageMinCases: 11,
  routerCoverageMinCases: 18,
  contaminationTrainPaths: DEFAULT_CONTAMINATION_TRAIN_PATHS,
  contaminationEvalPaths: DEFAULT_CONTAMINATION_EVAL_PATHS,
  contaminationNgramSize: 13,
  contaminationOverlapThreshold: 0.8,
  maxContaminationExactIdMatches: 0,
  maxContaminationExactTextMatches: 0,
  maxContaminationHighOverlapMatches: 0,
  minSftTrainRecords: 1000,
  minSftValidationRecords: 100,
  minDatasetAcceptedRecords: 1_000,
  minDatasetValidationRecords: 100,
  minDatasetEvalSeedRecords: 50,
  minDatasetEvalSeedSourceShare: 0.25,
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
  const [
    toolEvalReport,
    knowledgeEvalReport,
    behaviorEvalReport,
    voiceEvalReport,
    routerEvalReport,
    toolRouterEvalReport,
    longContextEvalReport,
    memoryContinuityGate,
    skillRetrievalGate,
    toolProtocolCoverageReport,
    behaviorCoverageReport,
    routerCoverageReport,
    subqArchitectureReport,
    datasetGovernanceReport,
    contaminationReport,
  ] =
    await Promise.all([
      readJson(config.toolEvalReportPath, toolEvalReportSchema),
      readJson(config.knowledgeEvalReportPath, knowledgeEvalReportSchema),
      readJson(config.behaviorEvalReportPath, behaviorEvalReportSchema),
      readJson(config.voiceEvalReportPath, voiceEvalReportSchema),
      readJson(config.routerEvalReportPath, routerEvalReportSchema),
      readJson(config.toolRouterEvalReportPath, toolRouterEvalReportSchema),
      readJson(config.longContextEvalReportPath, longContextEvalReportSchema),
      readJson(config.memoryContinuityGatePath, memoryContinuityGateSchema),
      readJson(config.skillRetrievalGatePath, skillRetrievalGateSchema),
      checkToolProtocolCoverageReadiness({
        suitePath: config.toolEvalSuitePath,
        minTotalCases: config.toolProtocolCoverageMinCases,
      }),
      checkBehaviorCoverageReadiness({
        suitePath: config.behaviorEvalSuitePath,
        minTotalCases: config.behaviorCoverageMinCases,
      }),
      checkSpecialistRoutingCoverageReadiness({
        suitePath: config.routerEvalSuitePath,
        minTotalCases: config.routerCoverageMinCases,
      }),
      checkSubquadraticArchitectureReadiness({
        suitePath: config.longContextSuitePath,
        routerSourcePath: config.llmRouterSourcePath,
        trainerPath: config.tinyTrainerPath,
        evaluatorPath: config.tinyEvaluatorPath,
      }),
      checkDatasetGovernanceReadiness({
        rawManifestPath: config.rawDatasetManifestPath,
        processedReportPath: config.processedDatasetReportPath,
        sftReportPath: config.sftReportPath,
        preferenceReportPath: config.preferenceReportPath,
        preparerSourcePath: config.datasetPreparerSourcePath,
        minAcceptedRecords: config.minDatasetAcceptedRecords,
        minValidationRecords: config.minDatasetValidationRecords,
        minEvalSeedRecords: config.minDatasetEvalSeedRecords,
        minEvalSeedSourceShare: config.minDatasetEvalSeedSourceShare,
        maxSyntheticTrainShare: config.maxSyntheticTrainShare,
      }),
      auditDataContamination({
        trainPaths: config.contaminationTrainPaths,
        evalPaths: config.contaminationEvalPaths,
        ngramSize: config.contaminationNgramSize,
        overlapThreshold: config.contaminationOverlapThreshold,
        maxExactIdMatches: config.maxContaminationExactIdMatches,
        maxExactTextMatches: config.maxContaminationExactTextMatches,
        maxHighOverlapMatches: config.maxContaminationHighOverlapMatches,
      }),
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
  checks.push(
    ...evalHarnessChecks(
      toolEvalReport,
      knowledgeEvalReport,
      behaviorEvalReport,
      voiceEvalReport,
      routerEvalReport,
      toolRouterEvalReport,
      longContextEvalReport,
      memoryContinuityGate,
      skillRetrievalGate,
      toolProtocolCoverageReport,
      behaviorCoverageReport,
      routerCoverageReport,
      subqArchitectureReport,
    ),
  );
  checks.push(datasetGovernanceReadinessCheck(datasetGovernanceReport));
  checks.push(contaminationReadinessCheck(contaminationReport));

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

function datasetGovernanceReadinessCheck(report: DatasetGovernanceReadinessReport): ReadinessCheck {
  const warnings = report.checks
    .filter((check) => check.status === "warn")
    .map((check) => ({ id: check.id, summary: check.summary, details: check.details }));
  return report.status === "pass"
    ? pass("dataset-governance", `Dataset governance is healthy with ${report.summary.processedAccepted} accepted rows`, {
        rawSources: report.summary.rawSources,
        evalSeed: report.summary.evalSeed,
        syntheticTrainShare: report.summary.syntheticTrainShare,
        warnings,
      })
    : fail("dataset-governance", "Dataset governance readiness failed", {
        failures: report.checks
          .filter((check) => check.status === "fail")
          .map((check) => ({ id: check.id, summary: check.summary, details: check.details })),
        warnings,
      });
}

function toolProtocolCoverageReadinessCheck(report: ToolProtocolCoverageReadinessReport): ReadinessCheck {
  const failingScenarios = report.scenarios
    .filter((scenario) => scenario.count < scenario.minCases)
    .map((scenario) => ({
      id: scenario.id,
      description: scenario.description,
      count: scenario.count,
      minCases: scenario.minCases,
      sampleIds: scenario.sampleIds,
    }));
  return report.status === "pass"
    ? pass("tool-protocol-coverage", `Tool protocol suite covers ${report.scenarios.length} required scenario families`, {
        total: report.summary.total,
        byKind: report.summary.byKind,
        promptInjectionSources: report.summary.promptInjectionSources,
        toolSurfaceTools: report.summary.toolSurfaceTools,
        multiTurnCases: report.summary.multiTurnCases,
      })
    : fail("tool-protocol-coverage", "Tool protocol suite is missing required BFCL-style scenario coverage", {
        total: report.summary.total,
        failingScenarios,
      });
}

function behaviorCoverageReadinessCheck(report: BehaviorCoverageReadinessReport): ReadinessCheck {
  const failingScenarios = report.scenarios
    .filter((scenario) => scenario.count < scenario.minCases)
    .map((scenario) => ({
      id: scenario.id,
      description: scenario.description,
      count: scenario.count,
      minCases: scenario.minCases,
      sampleIds: scenario.sampleIds,
    }));
  return report.status === "pass"
    ? pass("behavior-coverage", `Behavior suite covers ${report.scenarios.length} required persona/social families`, {
        total: report.summary.total,
        byKind: report.summary.byKind,
        byRoute: report.summary.byRoute,
        targets: report.summary.targets,
        noToolContracts: report.summary.noToolContracts,
        corporateVoiceGuardCases: report.summary.corporateVoiceGuardCases,
      })
    : fail("behavior-coverage", "Behavior suite is missing required persona/social coverage", {
        total: report.summary.total,
        byKind: report.summary.byKind,
        byRoute: report.summary.byRoute,
        failingScenarios,
      });
}

function routerCoverageReadinessCheck(report: SpecialistRoutingCoverageReadinessReport): ReadinessCheck {
  const failingScenarios = report.scenarios
    .filter((scenario) => scenario.count < scenario.minCases)
    .map((scenario) => ({
      id: scenario.id,
      description: scenario.description,
      count: scenario.count,
      minCases: scenario.minCases,
      sampleIds: scenario.sampleIds,
    }));
  return report.status === "pass"
    ? pass("router-coverage", `Specialist router suite covers ${report.scenarios.length} required MoE route families`, {
        total: report.summary.total,
        byRoute: report.summary.byRoute,
        byExpert: report.summary.byExpert,
        cues: report.summary.cues,
        nonToolCases: report.summary.nonToolCases,
      })
    : fail("router-coverage", "Specialist router suite is missing required MoE route coverage", {
        total: report.summary.total,
        byRoute: report.summary.byRoute,
        byExpert: report.summary.byExpert,
        failingScenarios,
      });
}

function contaminationReadinessCheck(report: DataContaminationAuditReport): ReadinessCheck {
  return report.status === "pass"
    ? pass("contamination-audit", `Contamination audit is clean across ${report.evalRecords} eval records`, {
        trainRecords: report.trainRecords,
        evalRecords: report.evalRecords,
        evalPaths: report.evalPaths,
        maxOverlapRatio: report.maxOverlapRatio,
      })
    : fail("contamination-audit", "Contamination audit found held-out eval leakage", {
        trainRecords: report.trainRecords,
        evalRecords: report.evalRecords,
        exactIdMatches: report.exactIdMatches,
        exactTextMatches: report.exactTextMatches,
        highOverlapMatches: report.highOverlapMatches,
        failures: report.failures,
      });
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
  voiceReport: VoiceEvalReport,
  routerReport: RouterEvalReport,
  toolRouterReport: ToolRouterEvalReport,
  longContextReport: LongContextEvalReport,
  memoryContinuityGate: MemoryContinuityGateReport,
  skillRetrievalGate: SkillRetrievalGateReport,
  toolProtocolCoverageReport: ToolProtocolCoverageReadinessReport,
  behaviorCoverageReport: BehaviorCoverageReadinessReport,
  routerCoverageReport: SpecialistRoutingCoverageReadinessReport,
  subqArchitectureReport: SubquadraticArchitectureReadinessReport,
): ReadinessCheck[] {
  return [
    toolReport.total >= 200 &&
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
    behaviorCoverageReadinessCheck(behaviorCoverageReport),
    voiceReport.total >= 12 &&
    voiceReport.transcriptExactRate >= 0.9 &&
    voiceReport.averageTranscriptTokenF1 >= 0.95 &&
    voiceReport.speakerAttributionAccuracy === 1 &&
    voiceReport.responseDecisionAccuracy === 1 &&
    voiceReport.latencyPassRate === 1 &&
    voiceReport.socialTimingPassRate === 1 &&
    voiceReport.retentionPolicyPassRate === 1 &&
    voiceReport.missingPredictions === 0 &&
    voiceReport.failures.length === 0
      ? pass("voice-eval-harness", `Voice eval harness is healthy with ${voiceReport.total} oracle cases`)
      : fail("voice-eval-harness", "Voice eval oracle report does not satisfy promotion-gate expectations", {
          total: voiceReport.total,
          transcriptExactRate: voiceReport.transcriptExactRate,
          averageTranscriptTokenF1: voiceReport.averageTranscriptTokenF1,
          speakerAttributionAccuracy: voiceReport.speakerAttributionAccuracy,
          responseDecisionAccuracy: voiceReport.responseDecisionAccuracy,
          latencyPassRate: voiceReport.latencyPassRate,
          socialTimingPassRate: voiceReport.socialTimingPassRate,
          retentionPolicyPassRate: voiceReport.retentionPolicyPassRate,
          missingPredictions: voiceReport.missingPredictions,
          failures: voiceReport.failures.length,
        }),
    routerReport.total >= 18 &&
    routerReport.routeAccuracy >= 0.95 &&
    routerReport.expertAccuracy >= 0.95 &&
    routerReport.toolVsNonToolAccuracy === 1 &&
    routerReport.missingPredictions === 0 &&
    routerReport.invalidPredictions === 0 &&
    routerReport.failures.length === 0
      ? pass("router-eval-harness", `Specialist router eval harness is healthy with ${routerReport.total} oracle cases`)
      : fail("router-eval-harness", "Specialist router eval oracle report does not satisfy promotion-gate expectations", {
          total: routerReport.total,
          routeAccuracy: routerReport.routeAccuracy,
          expertAccuracy: routerReport.expertAccuracy,
          toolVsNonToolAccuracy: routerReport.toolVsNonToolAccuracy,
          missingPredictions: routerReport.missingPredictions,
          invalidPredictions: routerReport.invalidPredictions,
          failures: routerReport.failures.length,
        }),
    routerCoverageReadinessCheck(routerCoverageReport),
    toolRouterReport.total >= 75 &&
    toolRouterReport.expectedToolRecall === 1 &&
    toolRouterReport.caseRecallAccuracy === 1 &&
    (toolRouterReport.top1Accuracy ?? 0) >= 0.85 &&
    toolRouterReport.likelyNeedsToolAccuracy >= 0.95 &&
    toolRouterReport.noToolAccuracy === 1 &&
    toolRouterReport.forbiddenCandidateRate === 0 &&
    toolRouterReport.missingExpectedTools === 0 &&
    toolRouterReport.forbiddenCandidateHits === 0 &&
    toolRouterReport.failures.length === 0
      ? pass("tool-router-eval-harness", `Tool-router retrieval eval is healthy with ${toolRouterReport.total} cases`)
      : fail("tool-router-eval-harness", "Tool-router retrieval report does not satisfy promotion-gate expectations", {
          total: toolRouterReport.total,
          expectedToolRecall: toolRouterReport.expectedToolRecall,
          caseRecallAccuracy: toolRouterReport.caseRecallAccuracy,
          top1Accuracy: toolRouterReport.top1Accuracy,
          likelyNeedsToolAccuracy: toolRouterReport.likelyNeedsToolAccuracy,
          noToolAccuracy: toolRouterReport.noToolAccuracy,
          forbiddenCandidateRate: toolRouterReport.forbiddenCandidateRate,
          missingExpectedTools: toolRouterReport.missingExpectedTools,
          forbiddenCandidateHits: toolRouterReport.forbiddenCandidateHits,
          failures: toolRouterReport.failures.length,
        }),
    longContextReport.total >= 28 &&
    longContextReport.answerRate >= 0.95 &&
    longContextReport.exactMatchRate >= 0.9 &&
    longContextReport.expectedContainRate >= 0.95 &&
    longContextReport.missingPredictions === 0 &&
    longContextReport.falsePositiveRate === 0 &&
    longContextReport.failures.length === 0
      ? pass("long-context-eval-harness", `Long-context eval harness is healthy with ${longContextReport.total} oracle cases`)
      : fail("long-context-eval-harness", "Long-context eval oracle report does not satisfy promotion-gate expectations", {
          total: longContextReport.total,
          answerRate: longContextReport.answerRate,
          exactMatchRate: longContextReport.exactMatchRate,
          expectedContainRate: longContextReport.expectedContainRate,
          missingPredictions: longContextReport.missingPredictions,
          falsePositiveRate: longContextReport.falsePositiveRate,
          failures: longContextReport.failures.length,
        }),
    memoryContinuityGate.status === "pass" &&
    memoryContinuityGate.candidate.total >= 12 &&
    memoryContinuityGate.candidate.passRate === 1 &&
    memoryContinuityGate.candidate.storedExpectedRate === 1 &&
    memoryContinuityGate.candidate.recallHitRate === 1 &&
    memoryContinuityGate.candidate.isolationPassRate === 1 &&
    memoryContinuityGate.candidate.forgetPassRate === 1 &&
    memoryContinuityGate.candidate.policyRejectionPassRate === 1 &&
    memoryContinuityGate.candidate.learnedItemPassRate === 1 &&
    memoryContinuityGate.candidate.failures === 0 &&
    memoryContinuityGate.failures.length === 0
      ? pass(
          "memory-continuity-gate",
          `Memory continuity gate is healthy with ${memoryContinuityGate.candidate.total} cases`,
          {
            suitePath: memoryContinuityGate.candidate.suitePath,
            latencyP95Ms: memoryContinuityGate.candidate.latencyP95Ms,
            warnings: memoryContinuityGate.warnings,
          },
        )
      : fail("memory-continuity-gate", "Memory continuity gate does not satisfy promotion expectations", {
          status: memoryContinuityGate.status,
          total: memoryContinuityGate.candidate.total,
          passRate: memoryContinuityGate.candidate.passRate,
          storedExpectedRate: memoryContinuityGate.candidate.storedExpectedRate,
          recallHitRate: memoryContinuityGate.candidate.recallHitRate,
          isolationPassRate: memoryContinuityGate.candidate.isolationPassRate,
          forgetPassRate: memoryContinuityGate.candidate.forgetPassRate,
          policyRejectionPassRate: memoryContinuityGate.candidate.policyRejectionPassRate,
          learnedItemPassRate: memoryContinuityGate.candidate.learnedItemPassRate,
          failures: memoryContinuityGate.candidate.failures,
          gateFailures: memoryContinuityGate.failures.length,
        }),
    skillRetrievalGate.status === "pass" &&
    skillRetrievalGate.candidate.total >= 10 &&
    skillRetrievalGate.candidate.recallAtK === 1 &&
    skillRetrievalGate.candidate.precisionAtK === 1 &&
    skillRetrievalGate.candidate.top1Accuracy === 1 &&
    skillRetrievalGate.candidate.noHitAccuracy === 1 &&
    skillRetrievalGate.candidate.forbiddenHits === 0 &&
    skillRetrievalGate.candidate.missingExpected === 0 &&
    skillRetrievalGate.candidate.failures === 0 &&
    skillRetrievalGate.failures.length === 0
      ? pass(
          "skill-retrieval-gate",
          `Skill retrieval gate is healthy with ${skillRetrievalGate.candidate.total} cases`,
          {
            suitePath: skillRetrievalGate.candidate.suitePath,
            latencyP95Ms: skillRetrievalGate.candidate.latencyP95Ms,
            warnings: skillRetrievalGate.warnings,
          },
        )
      : fail("skill-retrieval-gate", "Skill retrieval gate does not satisfy promotion expectations", {
          status: skillRetrievalGate.status,
          total: skillRetrievalGate.candidate.total,
          recallAtK: skillRetrievalGate.candidate.recallAtK,
          precisionAtK: skillRetrievalGate.candidate.precisionAtK,
          top1Accuracy: skillRetrievalGate.candidate.top1Accuracy,
          noHitAccuracy: skillRetrievalGate.candidate.noHitAccuracy,
          forbiddenHits: skillRetrievalGate.candidate.forbiddenHits,
          missingExpected: skillRetrievalGate.candidate.missingExpected,
          failures: skillRetrievalGate.candidate.failures,
          gateFailures: skillRetrievalGate.failures.length,
        }),
    toolProtocolCoverageReadinessCheck(toolProtocolCoverageReport),
    subqArchitectureReport.status === "pass"
      ? pass(
          "subq-architecture-contract",
          `SubQ/SSA architecture contract is healthy with ${subqArchitectureReport.summary.cases} long-context cases`,
          {
            maxTargetContextChars: subqArchitectureReport.summary.maxTargetContextChars,
            sources: subqArchitectureReport.summary.sources,
            taskTypes: subqArchitectureReport.summary.taskTypes,
            sparseAttentionBudget: subqArchitectureReport.summary.sparseAttentionBudget,
          },
        )
      : fail("subq-architecture-contract", "SubQ/SSA architecture contract is incomplete", {
          failures: subqArchitectureReport.checks
            .filter((check) => check.status === "fail")
            .map((check) => ({ id: check.id, summary: check.summary, details: check.details })),
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
