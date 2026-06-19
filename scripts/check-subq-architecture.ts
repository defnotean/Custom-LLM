import {
  checkSubquadraticArchitectureReadiness,
  type SubquadraticArchitectureReadinessOptions,
} from "../src/training/quality/SubquadraticArchitectureReadiness";

async function main(): Promise<void> {
  const report = await checkSubquadraticArchitectureReadiness(parseArgs(process.argv.slice(2)));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));

  if (report.status !== "pass") {
    const failures = report.checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.id}: ${check.summary}`)
      .join("; ");
    throw new Error(`SubQ/SSA architecture readiness failed: ${failures}`);
  }
}

function parseArgs(argv: string[]): SubquadraticArchitectureReadinessOptions {
  const options: SubquadraticArchitectureReadinessOptions = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--suite") options.suitePath = requireValue(argv[++index], arg);
    else if (arg === "--router") options.routerSourcePath = requireValue(argv[++index], arg);
    else if (arg === "--trainer") options.trainerPath = requireValue(argv[++index], arg);
    else if (arg === "--evaluator") options.evaluatorPath = requireValue(argv[++index], arg);
    else if (arg === "--min-cases") options.minCases = parsePositiveInt(argv[++index], arg);
    else if (arg === "--sparse-sequence-lengths")
      options.sparseSequenceLengths = parsePositiveIntList(argv[++index], arg);
    else if (arg === "--sparse-local-window") options.sparseLocalWindow = parsePositiveInt(argv[++index], arg);
    else if (arg === "--sparse-log-base") options.sparseLogBase = parsePositiveInt(argv[++index], arg);
    else if (arg === "--max-sparse-growth-exponent")
      options.maxSparseGrowthExponent = parsePositiveNumber(argv[++index], arg);
    else if (arg === "--max-sparse-dense-edge-ratio")
      options.maxSparseLargestDenseEdgeRatio = parsePositiveNumber(argv[++index], arg);
    else if (arg === "--max-sparse-average-keys")
      options.maxSparseAverageKeysPerToken = parsePositiveNumber(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveIntList(value: string | undefined, flag: string): number[] {
  return requireValue(value, flag)
    .split(",")
    .map((item) => parsePositiveInt(item.trim(), flag));
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parsePositiveNumber(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
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
