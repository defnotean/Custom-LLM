import { writeHeuristicSpecialistRoutingPredictions } from "../src/training/router/HeuristicSpecialistRouter";

async function main(): Promise<void> {
  let suite = "training/evals/specialist-routing.eval.jsonl";
  let out = "training/evals/specialist-routing-heuristic.predictions.jsonl";
  for (let index = 0; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--suite") suite = process.argv[index + 1] ?? suite;
    else if (arg === "--out") out = process.argv[index + 1] ?? out;
  }
  const summary = await writeHeuristicSpecialistRoutingPredictions(suite, out);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
