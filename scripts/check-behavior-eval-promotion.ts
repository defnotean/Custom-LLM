import { readFile, writeFile } from "node:fs/promises";
import {
  applyBehaviorPromotionGate,
  type BehaviorPromotionThresholds,
} from "../src/training/eval/BehaviorPromotionGate";
import type { BehaviorEvalReport } from "../src/training/eval/BehaviorEvalSuite";

interface Args {
  candidate: string;
  baseline?: string;
  out?: string;
  thresholds: Partial<BehaviorPromotionThresholds>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidate = await readReport(args.candidate);
  const baseline = args.baseline ? await readReport(args.baseline) : undefined;
  const result = applyBehaviorPromotionGate({ candidate, ...(baseline ? { baseline } : {}), thresholds: args.thresholds });
  const body = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
  if (result.status !== "pass") process.exitCode = 1;
}

function parseArgs(argv: string[]): Args {
  let candidate = "training/evals/behavior-oracle.report.json";
  let baseline: string | undefined;
  let out: string | undefined;
  const thresholds: Partial<BehaviorPromotionThresholds> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--candidate") candidate = requireValue(argv[++index], arg);
    else if (arg === "--baseline") baseline = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--min-total-cases") thresholds.minTotalCases = parseInteger(argv[++index], arg);
    else if (arg === "--min-valid-json-rate") thresholds.minValidJsonRate = parseNumber(argv[++index], arg);
    else if (arg === "--min-action-type-accuracy") thresholds.minActionTypeAccuracy = parseNumber(argv[++index], arg);
    else if (arg === "--min-requirement-pass-rate") thresholds.minRequirementPassRate = parseNumber(argv[++index], arg);
    else if (arg === "--min-persona-consistency-rate") thresholds.minPersonaConsistencyRate = parseNumber(argv[++index], arg);
    else if (arg === "--min-social-cue-accuracy") thresholds.minSocialCueAccuracy = parseNumber(argv[++index], arg);
    else if (arg === "--min-casual-tone-accuracy") thresholds.minCasualToneAccuracy = parseNumber(argv[++index], arg);
    else if (arg === "--min-tool-abstain-accuracy") thresholds.minToolAbstainAccuracy = parseNumber(argv[++index], arg);
    else if (arg === "--min-boundary-accuracy") thresholds.minBoundaryAccuracy = parseNumber(argv[++index], arg);
    else if (arg === "--max-missing-predictions") thresholds.maxMissingPredictions = parseInteger(argv[++index], arg);
    else if (arg === "--max-p95-latency-ms") thresholds.maxP95LatencyMs = parseNumber(argv[++index], arg);
    else if (arg === "--max-score-regression") thresholds.maxScoreRegression = parseNumber(argv[++index], arg);
    else if (arg === "--max-missing-prediction-increase") thresholds.maxMissingPredictionIncrease = parseInteger(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { candidate, ...(baseline ? { baseline } : {}), ...(out ? { out } : {}), thresholds };
}

async function readReport(path: string): Promise<BehaviorEvalReport> {
  return JSON.parse(await readFile(path, "utf8")) as BehaviorEvalReport;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseNumber(value: string | undefined, flag: string): number {
  const raw = requireValue(value, flag);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number`);
  return parsed;
}

function parseInteger(value: string | undefined, flag: string): number {
  const parsed = parseNumber(value, flag);
  if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer`);
  return parsed;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
