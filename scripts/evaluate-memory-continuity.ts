import { writeFile } from "node:fs/promises";
import { evaluateMemoryContinuitySuite } from "../src/training/eval/MemoryContinuityEvalSuite";

async function main(): Promise<void> {
  let suite = "training/evals/memory-continuity.eval.json";
  let out = "training/evals/memory-continuity.report.json";
  for (let index = 0; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--suite") suite = process.argv[index + 1] ?? suite;
    else if (arg === "--out") out = process.argv[index + 1] ?? out;
  }
  const report = await evaluateMemoryContinuitySuite(suite);
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
