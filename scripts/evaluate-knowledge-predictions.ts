import { writeFile } from "node:fs/promises";
import { evaluateKnowledgePredictions } from "../src/training/eval/KnowledgeEvalSuite";

interface Args {
  suite: string;
  predictions: string;
  out?: string;
  lowScoreThreshold?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await evaluateKnowledgePredictions({
    suitePath: args.suite,
    predictionsPath: args.predictions,
    ...(args.lowScoreThreshold !== undefined ? { lowScoreThreshold: args.lowScoreThreshold } : {}),
  });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
}

function parseArgs(argv: string[]): Args {
  let suite = "training/evals/knowledge.eval.jsonl";
  let predictions = "";
  let out: string | undefined;
  let lowScoreThreshold: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--suite") suite = requireValue(argv[++index], arg);
    else if (arg === "--predictions") predictions = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--low-score-threshold") lowScoreThreshold = Number.parseFloat(requireValue(argv[++index], arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!predictions) throw new Error("--predictions is required");
  return { suite, predictions, ...(out ? { out } : {}), ...(lowScoreThreshold !== undefined ? { lowScoreThreshold } : {}) };
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
