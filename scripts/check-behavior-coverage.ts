import {
  checkBehaviorCoverageReadiness,
  type BehaviorCoverageReadinessOptions,
} from "../src/training/quality/BehaviorCoverageReadiness";

async function main(): Promise<void> {
  const report = await checkBehaviorCoverageReadiness(parseArgs(process.argv.slice(2)));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));

  if (report.status !== "pass") {
    const failures = report.checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.id}: ${check.summary}`)
      .join("; ");
    throw new Error(`Behavior coverage readiness failed: ${failures}`);
  }
}

function parseArgs(argv: string[]): BehaviorCoverageReadinessOptions {
  const options: BehaviorCoverageReadinessOptions = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--suite") options.suitePath = requireValue(argv[++index], arg);
    else if (arg === "--min-total-cases") options.minTotalCases = parseNonnegativeInt(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseNonnegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a nonnegative integer`);
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
