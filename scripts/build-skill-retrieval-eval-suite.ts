import { writeSkillRetrievalEvalSuite } from "../src/training/eval/SkillRetrievalEvalSuite";

async function main(): Promise<void> {
  let out = "training/evals/skill-retrieval.eval.json";
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === "--out") out = process.argv[index + 1] ?? out;
  }
  const summary = await writeSkillRetrievalEvalSuite(out);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
