import { buildBehaviorSftDataset } from "../src/training/mixture/BehaviorSftDatasetBuilder";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildBehaviorSftDataset({
    evalSuitePath: args.evalSuitePath,
    outDir: args.outDir,
    variantsPerSeed: args.variantsPerSeed,
    validationShare: args.validationShare,
    botName: args.botName,
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

interface Args {
  evalSuitePath: string;
  outDir: string;
  variantsPerSeed?: number;
  validationShare?: number;
  botName?: string;
}

function parseArgs(argv: string[]): Args {
  let evalSuitePath = "training/evals/behavior.eval.jsonl";
  let outDir = "training/data/behavior";
  let variantsPerSeed: number | undefined;
  let validationShare: number | undefined;
  let botName: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--eval-suite") evalSuitePath = requireValue(argv[++index], arg);
    else if (arg === "--out-dir") outDir = requireValue(argv[++index], arg);
    else if (arg === "--variants-per-seed") variantsPerSeed = parseInteger(argv[++index], arg);
    else if (arg === "--validation-share") validationShare = parseNumber(argv[++index], arg);
    else if (arg === "--bot-name") botName = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    evalSuitePath,
    outDir,
    ...(variantsPerSeed !== undefined ? { variantsPerSeed } : {}),
    ...(validationShare !== undefined ? { validationShare } : {}),
    ...(botName ? { botName } : {}),
  };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseInteger(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer`);
  return parsed;
}

function parseNumber(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number`);
  return parsed;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
