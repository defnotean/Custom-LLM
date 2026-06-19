import {
  checkProductionTrainingReadiness,
  type ProductionTrainingReadinessOptions,
  type ProductionTrainingStage,
} from "../src/training/quality/ProductionTrainingReadiness";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await checkProductionTrainingReadiness(options);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));

  if (report.status !== "ready") {
    const failures = report.checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.id}: ${check.summary}`)
      .join("; ");
    throw new Error(`Production training is not ready: ${failures}`);
  }
}

function parseArgs(argv: string[]): ProductionTrainingReadinessOptions {
  const options: ProductionTrainingReadinessOptions = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--stage") options.stage = parseStage(requireValue(argv[++index], arg));
    else if (arg === "--sft-report") options.sftReportPath = requireValue(argv[++index], arg);
    else if (arg === "--preference-report") options.preferenceReportPath = requireValue(argv[++index], arg);
    else if (arg === "--tool-eval-suite") options.toolEvalSuitePath = requireValue(argv[++index], arg);
    else if (arg === "--behavior-eval-suite") options.behaviorEvalSuitePath = requireValue(argv[++index], arg);
    else if (arg === "--tool-eval-report") options.toolEvalReportPath = requireValue(argv[++index], arg);
    else if (arg === "--knowledge-eval-report") options.knowledgeEvalReportPath = requireValue(argv[++index], arg);
    else if (arg === "--behavior-eval-report") options.behaviorEvalReportPath = requireValue(argv[++index], arg);
    else if (arg === "--router-eval-suite") options.routerEvalSuitePath = requireValue(argv[++index], arg);
    else if (arg === "--router-eval-report") options.routerEvalReportPath = requireValue(argv[++index], arg);
    else if (arg === "--memory-continuity-gate") options.memoryContinuityGatePath = requireValue(argv[++index], arg);
    else if (arg === "--skill-retrieval-gate") options.skillRetrievalGatePath = requireValue(argv[++index], arg);
    else if (arg === "--long-context-eval-report") options.longContextEvalReportPath = requireValue(argv[++index], arg);
    else if (arg === "--raw-dataset-manifest") options.rawDatasetManifestPath = requireValue(argv[++index], arg);
    else if (arg === "--processed-dataset-report") options.processedDatasetReportPath = requireValue(argv[++index], arg);
    else if (arg === "--dataset-preparer-source") options.datasetPreparerSourcePath = requireValue(argv[++index], arg);
    else if (arg === "--long-context-suite") options.longContextSuitePath = requireValue(argv[++index], arg);
    else if (arg === "--llm-router-source") options.llmRouterSourcePath = requireValue(argv[++index], arg);
    else if (arg === "--tiny-trainer") options.tinyTrainerPath = requireValue(argv[++index], arg);
    else if (arg === "--tiny-evaluator") options.tinyEvaluatorPath = requireValue(argv[++index], arg);
    else if (arg === "--sft-train") options.sftTrainPath = requireValue(argv[++index], arg);
    else if (arg === "--sft-validation") options.sftValidationPath = requireValue(argv[++index], arg);
    else if (arg === "--contamination-train") {
      options.contaminationTrainPaths = [...(options.contaminationTrainPaths ?? []), requireValue(argv[++index], arg)];
    } else if (arg === "--contamination-eval") {
      options.contaminationEvalPaths = [...(options.contaminationEvalPaths ?? []), requireValue(argv[++index], arg)];
    } else if (arg === "--contamination-ngram-size") {
      options.contaminationNgramSize = parsePositiveInt(argv[++index], arg);
    } else if (arg === "--contamination-overlap-threshold") {
      options.contaminationOverlapThreshold = parseRatio(argv[++index], arg);
    } else if (arg === "--max-contamination-exact-id-matches") {
      options.maxContaminationExactIdMatches = parseNonnegativeInt(argv[++index], arg);
    } else if (arg === "--max-contamination-exact-text-matches") {
      options.maxContaminationExactTextMatches = parseNonnegativeInt(argv[++index], arg);
    } else if (arg === "--max-contamination-high-overlap-matches") {
      options.maxContaminationHighOverlapMatches = parseNonnegativeInt(argv[++index], arg);
    } else if (arg === "--sequence-len") options.sequenceLength = parsePositiveInt(argv[++index], arg);
    else if (arg === "--max-sft-over-length-rate") options.maxSftOverLengthRate = parseRatio(argv[++index], arg);
    else if (arg === "--max-sft-token-budget-usage") options.maxSftTokenBudgetUsage = parseRatio(argv[++index], arg);
    else if (arg === "--min-sft-packing-efficiency") options.minSftPackingEfficiency = parseRatio(argv[++index], arg);
    else if (arg === "--min-tool-protocol-coverage-cases")
      options.toolProtocolCoverageMinCases = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--min-behavior-coverage-cases")
      options.behaviorCoverageMinCases = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--min-router-coverage-cases")
      options.routerCoverageMinCases = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--min-sft-train-records") options.minSftTrainRecords = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--min-sft-validation-records")
      options.minSftValidationRecords = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--max-synthetic-train-share")
      options.maxSyntheticTrainShare = parseRatio(argv[++index], arg);
    else if (arg === "--min-dataset-accepted")
      options.minDatasetAcceptedRecords = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--min-dataset-validation")
      options.minDatasetValidationRecords = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--min-dataset-eval-seed")
      options.minDatasetEvalSeedRecords = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--min-dataset-eval-seed-source-share")
      options.minDatasetEvalSeedSourceShare = parseRatio(argv[++index], arg);
    else if (arg === "--min-preference-records") options.minPreferenceRecords = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--allow-synthetic-only-preferences") options.allowSyntheticOnlyPreferences = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseStage(value: string): ProductionTrainingStage {
  if (value === "sft" || value === "dpo" || value === "all") return value;
  throw new Error(`--stage must be one of: sft, dpo, all`);
}

function parseNonnegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a nonnegative integer`);
  return parsed;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseRatio(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${flag} must be between 0 and 1`);
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
