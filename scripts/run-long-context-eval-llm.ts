import { logger } from "../src/config/logger";
import { env } from "../src/config/env";
import { buildLLMRouterFromEnv } from "../src/ai/llm/LLMRouter";
import { runLongContextEvalPredictions } from "../src/training/eval/LongContextEvalPredictionRunner";

interface Args {
  suite: string;
  out: string;
  maxCases?: number;
  preferredProvider?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runLongContextEvalPredictions({
    suitePath: args.suite,
    outPath: args.out,
    llm: buildLLMRouterFromEnv(env, logger),
    ...(args.maxCases !== undefined ? { maxCases: args.maxCases } : {}),
    ...(args.preferredProvider ? { preferredProvider: args.preferredProvider } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

function parseArgs(argv: string[]): Args {
  let suite = "training/evals/long-context.eval.jsonl";
  let out = "training/evals/long-context-llm.predictions.jsonl";
  let maxCases: number | undefined;
  let preferredProvider: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--suite") suite = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--max-cases") maxCases = parseInteger(argv[++index], arg);
    else if (arg === "--preferred-provider") preferredProvider = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { suite, out, ...(maxCases !== undefined ? { maxCases } : {}), ...(preferredProvider ? { preferredProvider } : {}) };
}

function parseInteger(value: string | undefined, flag: string): number {
  const raw = requireValue(value, flag);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer`);
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
