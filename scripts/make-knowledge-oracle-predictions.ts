import { makeKnowledgeOraclePredictions } from "../src/training/eval/KnowledgeEvalSuite";

interface Args {
  suite: string;
  out: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await makeKnowledgeOraclePredictions(args.suite, args.out);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: "ok", ...summary }, null, 2));
}

function parseArgs(argv: string[]): Args {
  let suite = "training/evals/knowledge.eval.jsonl";
  let out = "training/evals/knowledge-oracle.predictions.jsonl";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--suite") suite = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { suite, out };
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
