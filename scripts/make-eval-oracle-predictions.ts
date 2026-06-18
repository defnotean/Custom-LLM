import { readFile, writeFile } from "node:fs/promises";
import type { ToolEvalCase } from "../src/training/eval/ToolEvalSuite";

interface Args {
  suite: string;
  out: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = (await readFile(args.suite, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ToolEvalCase);
  const predictions = cases.map((item) => ({
    id: item.id,
    output: JSON.stringify(item.expected),
    model: "oracle",
  }));
  await writeFile(args.out, `${predictions.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: "ok", predictions: predictions.length, out: args.out }, null, 2));
}

function parseArgs(argv: string[]): Args {
  let suite = "training/evals/tool-routing.eval.jsonl";
  let out = "training/evals/oracle.predictions.jsonl";
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
