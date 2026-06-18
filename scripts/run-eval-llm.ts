import { logger } from "../src/config/logger";
import { env } from "../src/config/env";
import { buildLLMRouterFromEnv } from "../src/ai/llm/LLMRouter";
import { buildToolRegistry } from "../src/tools";
import { runEvalPredictions } from "../src/training/eval/EvalPredictionRunner";

interface Args {
  suite: string;
  out: string;
  maxCases?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runEvalPredictions({
    suitePath: args.suite,
    outPath: args.out,
    registry: buildToolRegistry(),
    llm: buildLLMRouterFromEnv(env, logger),
    ...(args.maxCases !== undefined ? { maxCases: args.maxCases } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

function parseArgs(argv: string[]): Args {
  let suite = "training/evals/tool-routing.eval.jsonl";
  let out = "training/evals/llm.predictions.jsonl";
  let maxCases: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--suite") suite = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--max-cases") maxCases = Number.parseInt(requireValue(argv[++index], arg), 10);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { suite, out, ...(maxCases !== undefined ? { maxCases } : {}) };
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
