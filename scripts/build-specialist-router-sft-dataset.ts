import { buildSpecialistRouterDataset } from "../src/training/router/SpecialistRouterDatasetBuilder";

async function main(): Promise<void> {
  let evalSuitePath = "training/evals/specialist-routing.eval.jsonl";
  let outDir = "training/data/router";
  let validationShare: number | undefined;
  let variantsPerSeed: number | undefined;
  for (let index = 0; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--eval-suite") evalSuitePath = process.argv[index + 1] ?? evalSuitePath;
    else if (arg === "--out-dir") outDir = process.argv[index + 1] ?? outDir;
    else if (arg === "--validation-share") validationShare = Number.parseFloat(process.argv[index + 1] ?? "");
    else if (arg === "--variants-per-seed") variantsPerSeed = Number.parseInt(process.argv[index + 1] ?? "", 10);
  }
  const report = await buildSpecialistRouterDataset({
    evalSuitePath,
    outDir,
    ...(validationShare !== undefined ? { validationShare } : {}),
    ...(variantsPerSeed !== undefined ? { variantsPerSeed } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
