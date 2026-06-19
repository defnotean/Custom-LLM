import { auditDataContamination } from "../src/training/quality/DataContaminationAudit";

interface Args {
  trainPaths: string[];
  evalPaths: string[];
  ngramSize: number;
  overlapThreshold: number;
  maxExactIdMatches: number;
  maxExactTextMatches: number;
  maxHighOverlapMatches: number;
  outPath?: string;
}

const defaultTrainPaths = [
  "training/data/processed/sft.train.jsonl",
  "training/data/mixtures/production-sft.train.jsonl",
  "training/data/router/sft.train.jsonl",
];

const defaultEvalPaths = [
  "training/evals/knowledge.eval.jsonl",
  "training/evals/tool-routing.eval.jsonl",
  "training/evals/behavior.eval.jsonl",
  "training/evals/voice.eval.jsonl",
  "training/evals/specialist-routing.eval.jsonl",
  "training/evals/tool-router.eval.jsonl",
  "training/evals/skill-retrieval.eval.json",
  "training/evals/memory-continuity.eval.json",
  "training/evals/long-context.eval.jsonl",
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await auditDataContamination({
    trainPaths: args.trainPaths,
    evalPaths: args.evalPaths,
    ngramSize: args.ngramSize,
    overlapThreshold: args.overlapThreshold,
    maxExactIdMatches: args.maxExactIdMatches,
    maxExactTextMatches: args.maxExactTextMatches,
    maxHighOverlapMatches: args.maxHighOverlapMatches,
    ...(args.outPath ? { outPath: args.outPath } : {}),
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "pass") throw new Error(`Data contamination audit failed: ${report.failures.join("; ")}`);
}

function parseArgs(argv: string[]): Args {
  const trainPaths: string[] = [];
  const evalPaths: string[] = [];
  let ngramSize = 13;
  let overlapThreshold = 0.8;
  let maxExactIdMatches = 0;
  let maxExactTextMatches = 0;
  let maxHighOverlapMatches = 0;
  let outPath: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--train") trainPaths.push(requireValue(argv[++index], arg));
    else if (arg === "--eval") evalPaths.push(requireValue(argv[++index], arg));
    else if (arg === "--ngram-size") ngramSize = numberArg(requireValue(argv[++index], arg), arg);
    else if (arg === "--overlap-threshold") overlapThreshold = numberArg(requireValue(argv[++index], arg), arg);
    else if (arg === "--max-exact-id-matches") maxExactIdMatches = numberArg(requireValue(argv[++index], arg), arg);
    else if (arg === "--max-exact-text-matches") maxExactTextMatches = numberArg(requireValue(argv[++index], arg), arg);
    else if (arg === "--max-high-overlap-matches") maxHighOverlapMatches = numberArg(requireValue(argv[++index], arg), arg);
    else if (arg === "--out") outPath = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(ngramSize) || ngramSize < 3) throw new Error("--ngram-size must be an integer >= 3");
  if (overlapThreshold <= 0 || overlapThreshold > 1) throw new Error("--overlap-threshold must be in (0, 1]");
  for (const [flag, value] of [
    ["--max-exact-id-matches", maxExactIdMatches],
    ["--max-exact-text-matches", maxExactTextMatches],
    ["--max-high-overlap-matches", maxHighOverlapMatches],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} must be a nonnegative integer`);
  }

  return {
    trainPaths: trainPaths.length > 0 ? trainPaths : defaultTrainPaths,
    evalPaths: evalPaths.length > 0 ? evalPaths : defaultEvalPaths,
    ngramSize,
    overlapThreshold,
    maxExactIdMatches,
    maxExactTextMatches,
    maxHighOverlapMatches,
    ...(outPath ? { outPath } : {}),
  };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function numberArg(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number`);
  return parsed;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
