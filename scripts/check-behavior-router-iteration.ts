import {
  checkBehaviorRouterIterationReadiness,
  type BehaviorRouterIterationReadinessOptions,
} from "../src/training/quality/BehaviorRouterIterationReadiness";

async function main(): Promise<void> {
  const report = await checkBehaviorRouterIterationReadiness(parseArgs(process.argv.slice(2)));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "pass") {
    const failures = report.checks.filter((check) => check.status === "fail").map((check) => check.id).join(", ");
    throw new Error(`Behavior/router iteration readiness failed: ${failures}`);
  }
}

function parseArgs(argv: string[]): BehaviorRouterIterationReadinessOptions {
  const options: BehaviorRouterIterationReadinessOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--behavior-dataset") options.behaviorDatasetPath = requireValue(argv[++index], arg);
    else if (arg === "--behavior-eval") options.behaviorEvalSuitePath = requireValue(argv[++index], arg);
    else if (arg === "--behavior-gate") options.behaviorGatePath = requireValue(argv[++index], arg);
    else if (arg === "--router-dataset") options.routerDatasetPath = requireValue(argv[++index], arg);
    else if (arg === "--router-eval") options.routerEvalSuitePath = requireValue(argv[++index], arg);
    else if (arg === "--router-gate") options.routerGatePath = requireValue(argv[++index], arg);
    else if (arg === "--min-behavior-records") options.minBehaviorRecords = parseInteger(argv[++index], arg);
    else if (arg === "--min-router-records") options.minRouterRecords = parseInteger(argv[++index], arg);
    else if (arg === "--min-behavior-route-records") options.minRecordsPerBehaviorRoute = parseInteger(argv[++index], arg);
    else if (arg === "--min-router-route-records") options.minRecordsPerRouterRoute = parseInteger(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseInteger(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
