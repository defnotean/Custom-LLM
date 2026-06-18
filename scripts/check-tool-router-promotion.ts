import { readFile, writeFile } from "node:fs/promises";
import {
  applyToolRouterPromotionGate,
  type ToolRouterEvalReport,
  type ToolRouterPromotionThresholds,
} from "../src/training/eval/ToolRouterEvalSuite";

interface Args {
  candidate: string;
  out?: string;
  thresholds: Partial<ToolRouterPromotionThresholds>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = JSON.parse(await readFile(args.candidate, "utf8")) as ToolRouterEvalReport;
  const result = applyToolRouterPromotionGate(report, args.thresholds);
  const body = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
  if (result.status !== "pass") process.exitCode = 1;
}

function parseArgs(argv: string[]): Args {
  let candidate = "training/evals/tool-router-keyword.report.json";
  let out: string | undefined;
  const thresholds: Partial<ToolRouterPromotionThresholds> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--candidate") candidate = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--min-total-cases") thresholds.minTotalCases = parseInteger(argv[++index], arg);
    else if (arg === "--min-expected-tool-recall") thresholds.minExpectedToolRecall = parseNumber(argv[++index], arg);
    else if (arg === "--min-case-recall-accuracy") thresholds.minCaseRecallAccuracy = parseNumber(argv[++index], arg);
    else if (arg === "--min-top1-accuracy") thresholds.minTop1Accuracy = parseNumber(argv[++index], arg);
    else if (arg === "--min-likely-needs-tool-accuracy") {
      thresholds.minLikelyNeedsToolAccuracy = parseNumber(argv[++index], arg);
    } else if (arg === "--min-no-tool-accuracy") thresholds.minNoToolAccuracy = parseNumber(argv[++index], arg);
    else if (arg === "--max-forbidden-candidate-rate") thresholds.maxForbiddenCandidateRate = parseNumber(argv[++index], arg);
    else if (arg === "--max-missing-expected-tools") thresholds.maxMissingExpectedTools = parseInteger(argv[++index], arg);
    else if (arg === "--max-forbidden-candidate-hits") thresholds.maxForbiddenCandidateHits = parseInteger(argv[++index], arg);
    else if (arg === "--max-p95-latency-ms") thresholds.maxP95LatencyMs = parseNumber(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { candidate, ...(out ? { out } : {}), thresholds };
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
