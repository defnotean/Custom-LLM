import { writeKnowledgeEvalSuite } from "../src/training/eval/KnowledgeEvalSuite";

interface Args {
  input: string;
  out: string;
  maxCases?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await writeKnowledgeEvalSuite({
    inputPath: args.input,
    outPath: args.out,
    ...(args.maxCases !== undefined ? { maxCases: args.maxCases } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

function parseArgs(argv: string[]): Args {
  let input = "training/data/processed/eval.seed.jsonl";
  let out = "training/evals/knowledge.eval.jsonl";
  let maxCases: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--input") input = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--max-cases") maxCases = Number.parseInt(requireValue(argv[++index], arg), 10);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { input, out, ...(maxCases !== undefined ? { maxCases } : {}) };
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
