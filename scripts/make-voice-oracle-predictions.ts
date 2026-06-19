import { readFile, writeFile } from "node:fs/promises";
import {
  buildVoiceOraclePredictions,
  type VoiceEvalCase,
} from "../src/training/eval/VoiceEvalSuite";

async function main(): Promise<void> {
  let suite = "training/evals/voice.eval.jsonl";
  let out = "training/evals/voice-oracle.predictions.jsonl";
  for (let index = 0; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--suite") suite = process.argv[index + 1] ?? suite;
    else if (arg === "--out") out = process.argv[index + 1] ?? out;
  }
  const cases = (await readJsonl(suite)) as VoiceEvalCase[];
  const predictions = buildVoiceOraclePredictions(cases);
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
