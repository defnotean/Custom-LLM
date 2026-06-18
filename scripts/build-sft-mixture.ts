import { buildSftMixture, defaultSftMixtureOptions } from "../src/training/mixture/SftMixtureBuilder";

async function main(): Promise<void> {
  const outDir = parseOutDir(process.argv.slice(2));
  const report = await buildSftMixture(defaultSftMixtureOptions(outDir));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

function parseOutDir(argv: string[]): string {
  let outDir = "training/data/mixtures";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      const value = argv[++index];
      if (!value) throw new Error("--out-dir requires a value");
      outDir = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return outDir;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
