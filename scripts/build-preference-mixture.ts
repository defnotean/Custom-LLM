import {
  buildPreferenceMixture,
  defaultPreferenceMixtureOptions,
} from "../src/training/mixture/PreferenceMixtureBuilder";

async function main(): Promise<void> {
  const outDir = parseOutDir(process.argv.slice(2));
  const report = await buildPreferenceMixture(defaultPreferenceMixtureOptions(outDir));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

function parseOutDir(argv: string[]): string {
  let outDir = "training/data/preferences";
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
