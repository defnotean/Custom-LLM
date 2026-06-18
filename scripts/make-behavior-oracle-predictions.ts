import { readFile, writeFile } from "node:fs/promises";
import type { BehaviorEvalCase } from "../src/training/eval/BehaviorEvalSuite";

async function main(): Promise<void> {
  let suite = "training/evals/behavior.eval.jsonl";
  let out = "training/evals/behavior-oracle.predictions.jsonl";
  for (let index = 0; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--suite") suite = process.argv[index + 1] ?? suite;
    else if (arg === "--out") out = process.argv[index + 1] ?? out;
  }
  const cases = (await readJsonl(suite)) as BehaviorEvalCase[];
  const predictions = cases.map((item, index) => ({
    id: item.id,
    output: JSON.stringify(item.expected.oracle),
    model: "behavior-oracle",
    latencyMs: 10 + index,
  }));
  await writeFile(out, `${predictions.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ suite, out, predictions: predictions.length }, null, 2));
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
