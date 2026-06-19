import { writeFile } from "node:fs/promises";
import { evaluateVoicePredictions } from "../src/training/eval/VoiceEvalSuite";

async function main(): Promise<void> {
  let suite = "training/evals/voice.eval.jsonl";
  let predictions = "training/evals/voice-oracle.predictions.jsonl";
  let out = "training/evals/voice-oracle.report.json";
  for (let index = 0; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--suite") suite = process.argv[index + 1] ?? suite;
    else if (arg === "--predictions") predictions = process.argv[index + 1] ?? predictions;
    else if (arg === "--out") out = process.argv[index + 1] ?? out;
  }
  const report = await evaluateVoicePredictions(suite, predictions);
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
