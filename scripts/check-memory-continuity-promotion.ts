import { readFile, writeFile } from "node:fs/promises";
import {
  applyMemoryContinuityPromotionGate,
  type MemoryContinuityPromotionThresholds,
} from "../src/training/eval/MemoryContinuityPromotionGate";
import type { MemoryContinuityReport } from "../src/training/eval/MemoryContinuityEvalSuite";

interface Args {
  candidate: string;
  baseline?: string;
  out?: string;
  thresholds: Partial<MemoryContinuityPromotionThresholds>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidate = await readReport(args.candidate);
  const baseline = args.baseline ? await readReport(args.baseline) : undefined;
  const result = applyMemoryContinuityPromotionGate({
    candidate,
    ...(baseline ? { baseline } : {}),
    thresholds: args.thresholds,
  });
  const body = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
  if (result.status !== "pass") process.exitCode = 1;
}

function parseArgs(argv: string[]): Args {
  let candidate = "training/evals/memory-continuity.report.json";
  let baseline: string | undefined;
  let out: string | undefined;
  const thresholds: Partial<MemoryContinuityPromotionThresholds> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--candidate") candidate = requireValue(argv[++index], arg);
    else if (arg === "--baseline") baseline = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--min-total-cases") thresholds.minTotalCases = parseInteger(argv[++index], arg);
    else if (arg === "--min-pass-rate") thresholds.minPassRate = parseNumber(argv[++index], arg);
    else if (arg === "--min-stored-expected-rate") thresholds.minStoredExpectedRate = parseNumber(argv[++index], arg);
    else if (arg === "--min-recall-hit-rate") thresholds.minRecallHitRate = parseNumber(argv[++index], arg);
    else if (arg === "--min-isolation-pass-rate") thresholds.minIsolationPassRate = parseNumber(argv[++index], arg);
    else if (arg === "--min-forget-pass-rate") thresholds.minForgetPassRate = parseNumber(argv[++index], arg);
    else if (arg === "--min-policy-rejection-pass-rate") {
      thresholds.minPolicyRejectionPassRate = parseNumber(argv[++index], arg);
    } else if (arg === "--min-learned-item-pass-rate") {
      thresholds.minLearnedItemPassRate = parseNumber(argv[++index], arg);
    } else if (arg === "--max-failures") thresholds.maxFailures = parseInteger(argv[++index], arg);
    else if (arg === "--max-p95-latency-ms") thresholds.maxP95LatencyMs = parseNumber(argv[++index], arg);
    else if (arg === "--max-pass-rate-regression") thresholds.maxPassRateRegression = parseNumber(argv[++index], arg);
    else if (arg === "--max-recall-regression") thresholds.maxRecallRegression = parseNumber(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { candidate, ...(baseline ? { baseline } : {}), ...(out ? { out } : {}), thresholds };
}

async function readReport(path: string): Promise<MemoryContinuityReport> {
  return JSON.parse(await readFile(path, "utf8")) as MemoryContinuityReport;
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
