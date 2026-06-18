import { writeLongContextEvalSuite, type LongContextNeedlePosition } from "../src/training/eval/LongContextEvalSuite";

interface Args {
  out: string;
  contextChars?: number[];
  positions?: LongContextNeedlePosition[];
  includeRepoArtifacts: boolean;
  includeRepoSnapshots: boolean;
  maxCases?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await writeLongContextEvalSuite({
    outPath: args.out,
    ...(args.contextChars ? { contextCharTargets: args.contextChars } : {}),
    ...(args.positions ? { needlePositions: args.positions } : {}),
    includeRepoArtifacts: args.includeRepoArtifacts,
    includeRepoSnapshots: args.includeRepoSnapshots,
    ...(args.maxCases !== undefined ? { maxCases: args.maxCases } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

function parseArgs(argv: string[]): Args {
  let out = "training/evals/long-context.eval.jsonl";
  let contextChars: number[] | undefined;
  let positions: LongContextNeedlePosition[] | undefined;
  let includeRepoArtifacts = true;
  let includeRepoSnapshots = true;
  let maxCases: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--context-chars") contextChars = parseIntegerList(requireValue(argv[++index], arg), arg);
    else if (arg === "--positions") positions = parsePositions(requireValue(argv[++index], arg));
    else if (arg === "--no-repo-artifacts") includeRepoArtifacts = false;
    else if (arg === "--no-repo-snapshots") includeRepoSnapshots = false;
    else if (arg === "--max-cases") maxCases = parseInteger(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    out,
    ...(contextChars ? { contextChars } : {}),
    ...(positions ? { positions } : {}),
    includeRepoArtifacts,
    includeRepoSnapshots,
    ...(maxCases !== undefined ? { maxCases } : {}),
  };
}

function parsePositions(value: string): LongContextNeedlePosition[] {
  const positions = value.split(",").map((item) => item.trim()).filter(Boolean);
  for (const position of positions) {
    if (position !== "early" && position !== "middle" && position !== "late") {
      throw new Error(`--positions values must be early,middle,late; got ${position}`);
    }
  }
  return positions as LongContextNeedlePosition[];
}

function parseIntegerList(value: string, flag: string): number[] {
  const values = value.split(",").map((item) => parseInteger(item, flag));
  if (values.length === 0) throw new Error(`${flag} requires at least one integer`);
  return values;
}

function parseInteger(value: string | undefined, flag: string): number {
  const raw = requireValue(value, flag);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer`);
  return parsed;
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
