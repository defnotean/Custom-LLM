import { readFile, writeFile } from "node:fs/promises";
import {
  applyParameterGrowthPlanGate,
  type ParameterGrowthGateThresholds,
} from "../src/training/parameter/ParameterGrowthPlanGate";
import type { ParameterGrowthPlan } from "../src/training/parameter/ParameterGrowthPlanner";

interface Args {
  plan: string;
  out?: string;
  thresholds: Partial<ParameterGrowthGateThresholds>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(await readFile(args.plan, "utf8")) as ParameterGrowthPlan;
  const result = applyParameterGrowthPlanGate({ plan, thresholds: args.thresholds });
  const body = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
  if (result.status !== "pass") process.exitCode = 1;
}

function parseArgs(argv: string[]): Args {
  let plan = "training/plans/parameter-growth/latest.json";
  let out: string | undefined;
  const thresholds: Partial<ParameterGrowthGateThresholds> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--plan") plan = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--min-ready-batches") thresholds.minReadyBatches = parseInteger(argv[++index], arg);
    else if (arg === "--min-records-per-ready-batch") thresholds.minRecordsPerReadyBatch = parseInteger(argv[++index], arg);
    else if (arg === "--max-estimated-new-parameters") thresholds.maxEstimatedNewParameters = parseInteger(argv[++index], arg);
    else if (arg === "--allow-risk-review") thresholds.requireRiskReview = false;
    else if (arg === "--required-gates") thresholds.requiredGateRequirements = parseList(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { plan, ...(out ? { out } : {}), thresholds };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseInteger(value: string | undefined, flag: string): number {
  const raw = requireValue(value, flag);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function parseList(value: string | undefined, flag: string): string[] {
  return requireValue(value, flag)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
