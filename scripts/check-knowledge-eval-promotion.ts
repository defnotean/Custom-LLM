import { readFile, writeFile } from "node:fs/promises";
import {
  applyKnowledgePromotionGate,
  type KnowledgePromotionThresholds,
} from "../src/training/eval/KnowledgePromotionGate";
import type { KnowledgeEvalReport } from "../src/training/eval/KnowledgeEvalSuite";

interface Args {
  candidate: string;
  baseline?: string;
  out?: string;
  thresholds: Partial<KnowledgePromotionThresholds>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidate = await readReport(args.candidate);
  const baseline = args.baseline ? await readReport(args.baseline) : undefined;
  const result = applyKnowledgePromotionGate({ candidate, ...(baseline ? { baseline } : {}), thresholds: args.thresholds });
  const body = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
  if (result.status !== "pass") process.exitCode = 1;
}

function parseArgs(argv: string[]): Args {
  let candidate = "training/evals/knowledge-llm.report.json";
  let baseline: string | undefined;
  let out: string | undefined;
  const thresholds: Partial<KnowledgePromotionThresholds> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--candidate") candidate = requireValue(argv[++index], arg);
    else if (arg === "--baseline") baseline = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--min-total-cases") thresholds.minTotalCases = parseInteger(argv[++index], arg);
    else if (arg === "--min-answer-rate") thresholds.minAnswerRate = parseNumber(argv[++index], arg);
    else if (arg === "--min-average-token-f1") thresholds.minAverageTokenF1 = parseNumber(argv[++index], arg);
    else if (arg === "--min-average-rouge-l") thresholds.minAverageRougeL = parseNumber(argv[++index], arg);
    else if (arg === "--max-missing-predictions") thresholds.maxMissingPredictions = parseInteger(argv[++index], arg);
    else if (arg === "--max-low-score-rate") thresholds.maxLowScoreRate = parseNumber(argv[++index], arg);
    else if (arg === "--max-p95-latency-ms") thresholds.maxP95LatencyMs = parseNumber(argv[++index], arg);
    else if (arg === "--max-score-regression") thresholds.maxScoreRegression = parseNumber(argv[++index], arg);
    else if (arg === "--max-low-score-rate-increase") thresholds.maxLowScoreRateIncrease = parseNumber(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { candidate, ...(baseline ? { baseline } : {}), ...(out ? { out } : {}), thresholds };
}

async function readReport(path: string): Promise<KnowledgeEvalReport> {
  return JSON.parse(await readFile(path, "utf8")) as KnowledgeEvalReport;
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
