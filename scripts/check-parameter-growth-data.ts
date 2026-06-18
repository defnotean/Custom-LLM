import { writeFile } from "node:fs/promises";
import { checkParameterGrowthDatasetQuality } from "../src/training/parameter/ParameterGrowthDatasetQuality";

interface Args {
  manifest: string;
  out?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await checkParameterGrowthDatasetQuality(args.manifest);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
  if (report.status !== "pass") process.exitCode = 1;
}

function parseArgs(argv: string[]): Args {
  let manifest = "training/data/parameter-growth/latest/manifest.json";
  let out: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--manifest") manifest = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { manifest, ...(out ? { out } : {}) };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
