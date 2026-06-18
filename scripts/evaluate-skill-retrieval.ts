import { writeFile } from "node:fs/promises";
import { evaluateSkillRetrievalSuite } from "../src/training/eval/SkillRetrievalEvalSuite";

async function main(): Promise<void> {
  let suite = "training/evals/skill-retrieval.eval.json";
  let out = "training/evals/skill-retrieval.report.json";
  for (let index = 0; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--suite") suite = process.argv[index + 1] ?? suite;
    else if (arg === "--out") out = process.argv[index + 1] ?? out;
  }
  const report = await evaluateSkillRetrievalSuite(suite);
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
