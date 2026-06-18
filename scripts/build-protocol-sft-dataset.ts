import { buildProtocolSftDataset } from "../src/training/mixture/ProtocolSftDatasetBuilder";

interface Args {
  syntheticPath: string;
  evalSuitePath: string;
  outDir: string;
  validationShare?: number;
  paraphrasesPerRecord?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildProtocolSftDataset({
    syntheticPath: args.syntheticPath,
    evalSuitePath: args.evalSuitePath,
    outDir: args.outDir,
    ...(args.validationShare !== undefined ? { validationShare: args.validationShare } : {}),
    ...(args.paraphrasesPerRecord !== undefined ? { paraphrasesPerRecord: args.paraphrasesPerRecord } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

function parseArgs(argv: string[]): Args {
  let syntheticPath = "exports/training/synthetic-tools.jsonl";
  let evalSuitePath = "training/evals/tool-routing.eval.jsonl";
  let outDir = "training/data/protocol";
  let validationShare: number | undefined;
  let paraphrasesPerRecord: number | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--synthetic") syntheticPath = requireValue(argv[++index], arg);
    else if (arg === "--eval-suite") evalSuitePath = requireValue(argv[++index], arg);
    else if (arg === "--out-dir") outDir = requireValue(argv[++index], arg);
    else if (arg === "--validation-share") validationShare = Number(requireValue(argv[++index], arg));
    else if (arg === "--paraphrases-per-record") paraphrasesPerRecord = Number(requireValue(argv[++index], arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (validationShare !== undefined && (!Number.isFinite(validationShare) || validationShare <= 0 || validationShare >= 1)) {
    throw new Error("--validation-share must be a number between 0 and 1");
  }
  if (
    paraphrasesPerRecord !== undefined &&
    (!Number.isInteger(paraphrasesPerRecord) || paraphrasesPerRecord < 0)
  ) {
    throw new Error("--paraphrases-per-record must be a non-negative integer");
  }

  return {
    syntheticPath,
    evalSuitePath,
    outDir,
    ...(validationShare !== undefined ? { validationShare } : {}),
    ...(paraphrasesPerRecord !== undefined ? { paraphrasesPerRecord } : {}),
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
