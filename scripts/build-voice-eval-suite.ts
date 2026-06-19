import { writeVoiceEvalSuite } from "../src/training/eval/VoiceEvalSuite";

async function main(): Promise<void> {
  let path = "training/evals/voice.eval.jsonl";
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === "--out") path = process.argv[index + 1] ?? path;
  }
  const summary = await writeVoiceEvalSuite(path);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
