import { analyzeTrainingMixtureSequences } from "../src/training/quality/TrainingMixtureSequenceStats";

interface Args {
  trainPath: string;
  validationPath: string;
  sequenceLength: number;
  topLongest: number;
  outPath?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await analyzeTrainingMixtureSequences({
    trainPath: args.trainPath,
    validationPath: args.validationPath,
    sequenceLength: args.sequenceLength,
    topLongest: args.topLongest,
    ...(args.outPath ? { outPath: args.outPath } : {}),
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

function parseArgs(argv: string[]): Args {
  let trainPath = "training/data/mixtures/production-sft.train.jsonl";
  let validationPath = "training/data/mixtures/production-sft.validation.jsonl";
  let sequenceLength = 2048;
  let topLongest = 10;
  let outPath: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--train") trainPath = requireValue(argv[++index], arg);
    else if (arg === "--validation") validationPath = requireValue(argv[++index], arg);
    else if (arg === "--sequence-len") sequenceLength = parsePositiveInt(argv[++index], arg);
    else if (arg === "--top-longest") topLongest = parsePositiveInt(argv[++index], arg);
    else if (arg === "--out") outPath = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return { trainPath, validationPath, sequenceLength, topLongest, ...(outPath ? { outPath } : {}) };
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
