import { checkTrainingIterationReport, type TrainingIterationReportMode } from "../src/training/quality/TrainingIterationReportQuality";

interface Args {
  report: string;
  mode: TrainingIterationReportMode;
  requirePromotion: boolean;
  requireTool: boolean;
  requireKnowledge: boolean;
  requireBehavior: boolean;
  requireRouter: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await checkTrainingIterationReport({
    reportPath: args.report,
    mode: args.mode,
    requirePromotion: args.requirePromotion,
    requireTool: args.requireTool,
    requireKnowledge: args.requireKnowledge,
    requireBehavior: args.requireBehavior,
    requireRouter: args.requireRouter,
  });
  // eslint-disable-next-line no-console
  console.log(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "ready") process.exitCode = 1;
}

function parseArgs(argv: string[]): Args {
  let report = "training/reports/tiny-transformer-best-smoke.report.json";
  let mode: TrainingIterationReportMode = "review";
  let requirePromotion = true;
  let requireTool = true;
  let requireKnowledge = true;
  let requireBehavior = false;
  let requireRouter = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--report") report = requireValue(argv[++index], arg);
    else if (arg === "--mode") mode = parseMode(requireValue(argv[++index], arg));
    else if (arg === "--no-require-promotion") requirePromotion = false;
    else if (arg === "--no-require-tool") requireTool = false;
    else if (arg === "--no-require-knowledge") requireKnowledge = false;
    else if (arg === "--require-behavior") requireBehavior = true;
    else if (arg === "--require-router") requireRouter = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return { report, mode, requirePromotion, requireTool, requireKnowledge, requireBehavior, requireRouter };
}

function parseMode(value: string): TrainingIterationReportMode {
  if (value === "review" || value === "promotion") return value;
  throw new Error("--mode must be review or promotion");
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
