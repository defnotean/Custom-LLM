import { writeFile } from "node:fs/promises";
import { evaluateBehaviorPredictions } from "../src/training/eval/BehaviorEvalSuite";

async function main(): Promise<void> {
  let suite = "training/evals/behavior.eval.jsonl";
  let predictions = "training/evals/behavior-oracle.predictions.jsonl";
  let out = "training/evals/behavior-oracle.report.json";
  for (let index = 0; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--suite") suite = process.argv[index + 1] ?? suite;
    else if (arg === "--predictions") predictions = process.argv[index + 1] ?? predictions;
    else if (arg === "--out") out = process.argv[index + 1] ?? out;
  }
  const report = await evaluateBehaviorPredictions(suite, predictions);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
