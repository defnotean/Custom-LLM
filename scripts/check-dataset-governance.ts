import {
  checkDatasetGovernanceReadiness,
  type DatasetGovernanceReadinessOptions,
} from "../src/training/quality/DatasetGovernanceReadiness";

async function main(): Promise<void> {
  const report = await checkDatasetGovernanceReadiness(parseArgs(process.argv.slice(2)));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));

  if (report.status !== "pass") {
    const failures = report.checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.id}: ${check.summary}`)
      .join("; ");
    throw new Error(`Dataset governance readiness failed: ${failures}`);
  }
}

function parseArgs(argv: string[]): DatasetGovernanceReadinessOptions {
  const options: DatasetGovernanceReadinessOptions = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--raw-manifest") options.rawManifestPath = requireValue(argv[++index], arg);
    else if (arg === "--processed-report") options.processedReportPath = requireValue(argv[++index], arg);
    else if (arg === "--sft-report") options.sftReportPath = requireValue(argv[++index], arg);
    else if (arg === "--preference-report") options.preferenceReportPath = requireValue(argv[++index], arg);
    else if (arg === "--preparer-source") options.preparerSourcePath = requireValue(argv[++index], arg);
    else if (arg === "--min-accepted") options.minAcceptedRecords = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--min-validation") options.minValidationRecords = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--min-eval-seed") options.minEvalSeedRecords = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--min-eval-seed-source-share") options.minEvalSeedSourceShare = parseRatio(argv[++index], arg);
    else if (arg === "--max-synthetic-train-share") options.maxSyntheticTrainShare = parseRatio(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseNonnegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a nonnegative integer`);
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
