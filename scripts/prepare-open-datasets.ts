import {
  buildExternalSftDataset,
  describeExternalDatasetInputs,
  type ExternalDatasetSourceId,
} from "../src/training/external/OpenDatasetPreparer";

interface Args {
  rawDir: string;
  outDir: string;
  sources: ExternalDatasetSourceId[];
  maxPerSource: number;
  validationRatio: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await buildExternalSftDataset(args);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        inputs: describeExternalDatasetInputs(args.rawDir).filter((item) => args.sources.includes(item.source)),
        accepted: summary.accepted,
        train: summary.train,
        validation: summary.validation,
        skipped: summary.skipped,
        files: summary.files,
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv: string[]): Args {
  let rawDir = "training/data/raw";
  let outDir = "training/data/processed";
  let maxPerSource = 2_000;
  let validationRatio = 0.08;
  const sources: ExternalDatasetSourceId[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--raw-dir") {
      rawDir = requireValue(argv[++index], "--raw-dir");
    } else if (arg === "--out-dir") {
      outDir = requireValue(argv[++index], "--out-dir");
    } else if (arg === "--source") {
      const source = requireValue(argv[++index], "--source");
      if (source !== "dolly" && source !== "oasst1_ready") throw new Error(`Unsupported source: ${source}`);
      sources.push(source);
    } else if (arg === "--max-per-source") {
      maxPerSource = Number.parseInt(requireValue(argv[++index], "--max-per-source"), 10);
    } else if (arg === "--validation-ratio") {
      validationRatio = Number.parseFloat(requireValue(argv[++index], "--validation-ratio"));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    rawDir,
    outDir,
    sources: sources.length > 0 ? sources : ["dolly", "oasst1_ready"],
    maxPerSource,
    validationRatio,
  };
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
