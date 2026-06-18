import { readFile, writeFile } from "node:fs/promises";
import {
  applySpecialistRoutingPromotionGate,
  type SpecialistRoutingPromotionThresholds,
} from "../src/training/eval/SpecialistRoutingPromotionGate";
import type { SpecialistRoutingReport } from "../src/training/eval/SpecialistRoutingEvalSuite";

interface Args {
  candidate: string;
  baseline?: string;
  out?: string;
  thresholds: Partial<SpecialistRoutingPromotionThresholds>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidate = await readReport(args.candidate);
  const baseline = args.baseline ? await readReport(args.baseline) : undefined;
  const result = applySpecialistRoutingPromotionGate({
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
  let candidate = "training/evals/specialist-routing-oracle.report.json";
  let baseline: string | undefined;
  let out: string | undefined;
  const thresholds: Partial<SpecialistRoutingPromotionThresholds> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--candidate") candidate = requireValue(argv[++index], arg);
    else if (arg === "--baseline") baseline = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--min-total-cases") thresholds.minTotalCases = parseInteger(argv[++index], arg);
    else if (arg === "--min-route-accuracy") thresholds.minRouteAccuracy = parseNumber(argv[++index], arg);
    else if (arg === "--min-expert-accuracy") thresholds.minExpertAccuracy = parseNumber(argv[++index], arg);
    else if (arg === "--min-tool-vs-non-tool-accuracy") {
      thresholds.minToolVsNonToolAccuracy = parseNumber(argv[++index], arg);
    } else if (arg === "--max-missing-predictions") thresholds.maxMissingPredictions = parseInteger(argv[++index], arg);
    else if (arg === "--max-invalid-predictions") thresholds.maxInvalidPredictions = parseInteger(argv[++index], arg);
    else if (arg === "--max-p95-latency-ms") thresholds.maxP95LatencyMs = parseNumber(argv[++index], arg);
    else if (arg === "--max-route-accuracy-regression") thresholds.maxRouteAccuracyRegression = parseNumber(argv[++index], arg);
    else if (arg === "--max-expert-accuracy-regression") thresholds.maxExpertAccuracyRegression = parseNumber(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { candidate, ...(baseline ? { baseline } : {}), ...(out ? { out } : {}), thresholds };
}

async function readReport(path: string): Promise<SpecialistRoutingReport> {
  return JSON.parse(await readFile(path, "utf8")) as SpecialistRoutingReport;
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
