import { writeFile } from "node:fs/promises";
import { evaluateLongContextPredictions } from "../src/training/eval/LongContextEvalSuite";

interface Args {
  suite: string;
  predictions: string;
  out?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await evaluateLongContextPredictions({
    suitePath: args.suite,
    predictionsPath: args.predictions,
  });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
}

function parseArgs(argv: string[]): Args {
  let suite = "training/evals/long-context.eval.jsonl";
  let predictions = "";
  let out: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--suite") suite = requireValue(argv[++index], arg);
    else if (arg === "--predictions") predictions = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!predictions) throw new Error("--predictions is required");
  return { suite, predictions, ...(out ? { out } : {}) };
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
