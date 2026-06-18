import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildTrainingRunReport,
  type TrainingRunReportOptions,
} from "../src/training/quality/TrainingRunLeaderboard";

interface Args {
  runRoot: string;
  model?: string;
  candidateMetrics?: string;
  baselineMetrics?: string;
  minImprovement: number;
  maxUnknownTokenRate: number;
  requirePromotion: boolean;
  toolReport?: string;
  toolBaselineReport?: string;
  requireToolPromotion: boolean;
  knowledgeReport?: string;
  knowledgeBaselineReport?: string;
  requireKnowledgePromotion: boolean;
  behaviorReport?: string;
  behaviorBaselineReport?: string;
  requireBehaviorPromotion: boolean;
  routerReport?: string;
  routerBaselineReport?: string;
  requireRouterPromotion: boolean;
  out?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reportOptions: TrainingRunReportOptions = {
    runRoot: args.runRoot,
    ...(args.model ? { model: args.model } : {}),
    ...(args.candidateMetrics ? { candidateMetricsPath: args.candidateMetrics } : {}),
    ...(args.baselineMetrics ? { baselineMetricsPath: args.baselineMetrics } : {}),
    minAbsoluteLossImprovement: args.minImprovement,
    maxUnknownTokenRate: args.maxUnknownTokenRate,
    ...(args.toolReport ? { toolReportPath: args.toolReport } : {}),
    ...(args.toolBaselineReport ? { toolBaselineReportPath: args.toolBaselineReport } : {}),
    ...(args.knowledgeReport ? { knowledgeReportPath: args.knowledgeReport } : {}),
    ...(args.knowledgeBaselineReport ? { knowledgeBaselineReportPath: args.knowledgeBaselineReport } : {}),
    ...(args.behaviorReport ? { behaviorReportPath: args.behaviorReport } : {}),
    ...(args.behaviorBaselineReport ? { behaviorBaselineReportPath: args.behaviorBaselineReport } : {}),
    ...(args.routerReport ? { routerReportPath: args.routerReport } : {}),
    ...(args.routerBaselineReport ? { routerBaselineReportPath: args.routerBaselineReport } : {}),
  };

  const report = await buildTrainingRunReport(reportOptions);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, body, "utf8");
  }
  // eslint-disable-next-line no-console
  console.log(body);

  if (args.requirePromotion && report.promotion?.status !== "accepted") {
    const reasons = report.promotion?.reasons.join("; ") || "No candidate promotion report was produced.";
    throw new Error(`Training run promotion failed: ${reasons}`);
  }
  if (args.requireToolPromotion) {
    if (report.tool?.gate.status !== "pass") {
      const reasons =
        report.tool?.gate.failures.map((failure) => `${failure.metric}: ${failure.message}`).join("; ") ||
        "No protocol promotion report was produced.";
      throw new Error(`Training run protocol promotion failed: ${reasons}`);
    }
    if (report.tool.warnings.length > 0) {
      throw new Error(`Training run protocol evidence warnings: ${report.tool.warnings.join("; ")}`);
    }
  }
  if (args.requireKnowledgePromotion) {
    if (report.knowledge?.gate.status !== "pass") {
      const reasons =
        report.knowledge?.gate.failures.map((failure) => `${failure.metric}: ${failure.message}`).join("; ") ||
        "No knowledge promotion report was produced.";
      throw new Error(`Training run knowledge promotion failed: ${reasons}`);
    }
    if (report.knowledge.warnings.length > 0) {
      throw new Error(`Training run knowledge evidence warnings: ${report.knowledge.warnings.join("; ")}`);
    }
  }
  if (args.requireBehaviorPromotion) {
    if (report.behavior?.gate.status !== "pass") {
      const reasons =
        report.behavior?.gate.failures.map((failure) => `${failure.metric}: ${failure.message}`).join("; ") ||
        "No behavior promotion report was produced.";
      throw new Error(`Training run behavior promotion failed: ${reasons}`);
    }
    if (report.behavior.warnings.length > 0) {
      throw new Error(`Training run behavior evidence warnings: ${report.behavior.warnings.join("; ")}`);
    }
  }
  if (args.requireRouterPromotion) {
    if (report.router?.gate.status !== "pass") {
      const reasons =
        report.router?.gate.failures.map((failure) => `${failure.metric}: ${failure.message}`).join("; ") ||
        "No router promotion report was produced.";
      throw new Error(`Training run router promotion failed: ${reasons}`);
    }
    if (report.router.warnings.length > 0) {
      throw new Error(`Training run router evidence warnings: ${report.router.warnings.join("; ")}`);
    }
  }
}

function parseArgs(argv: string[]): Args {
  let runRoot = "training/runs";
  let model: string | undefined;
  let candidateMetrics: string | undefined;
  let baselineMetrics: string | undefined;
  let minImprovement = 0;
  let maxUnknownTokenRate = 0.12;
  let requirePromotion = false;
  let toolReport: string | undefined;
  let toolBaselineReport: string | undefined;
  let requireToolPromotion = false;
  let knowledgeReport: string | undefined;
  let knowledgeBaselineReport: string | undefined;
  let requireKnowledgePromotion = false;
  let behaviorReport: string | undefined;
  let behaviorBaselineReport: string | undefined;
  let requireBehaviorPromotion = false;
  let routerReport: string | undefined;
  let routerBaselineReport: string | undefined;
  let requireRouterPromotion = false;
  let out: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--run-root") runRoot = requireValue(argv[++index], arg);
    else if (arg === "--model") model = requireValue(argv[++index], arg);
    else if (arg === "--candidate-metrics") candidateMetrics = requireValue(argv[++index], arg);
    else if (arg === "--baseline-metrics") baselineMetrics = requireValue(argv[++index], arg);
    else if (arg === "--min-improvement") minImprovement = Number(requireValue(argv[++index], arg));
    else if (arg === "--max-unknown-token-rate") maxUnknownTokenRate = Number(requireValue(argv[++index], arg));
    else if (arg === "--require-promotion") requirePromotion = true;
    else if (arg === "--tool-report") toolReport = requireValue(argv[++index], arg);
    else if (arg === "--tool-baseline-report") toolBaselineReport = requireValue(argv[++index], arg);
    else if (arg === "--require-tool-promotion") requireToolPromotion = true;
    else if (arg === "--knowledge-report") knowledgeReport = requireValue(argv[++index], arg);
    else if (arg === "--knowledge-baseline-report") knowledgeBaselineReport = requireValue(argv[++index], arg);
    else if (arg === "--require-knowledge-promotion") requireKnowledgePromotion = true;
    else if (arg === "--behavior-report") behaviorReport = requireValue(argv[++index], arg);
    else if (arg === "--behavior-baseline-report") behaviorBaselineReport = requireValue(argv[++index], arg);
    else if (arg === "--require-behavior-promotion") requireBehaviorPromotion = true;
    else if (arg === "--router-report") routerReport = requireValue(argv[++index], arg);
    else if (arg === "--router-baseline-report") routerBaselineReport = requireValue(argv[++index], arg);
    else if (arg === "--require-router-promotion") requireRouterPromotion = true;
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(minImprovement) || minImprovement < 0) {
    throw new Error("--min-improvement must be a nonnegative number");
  }
  if (!Number.isFinite(maxUnknownTokenRate) || maxUnknownTokenRate < 0 || maxUnknownTokenRate > 1) {
    throw new Error("--max-unknown-token-rate must be a number between 0 and 1");
  }

  return {
    runRoot,
    ...(model ? { model } : {}),
    ...(candidateMetrics ? { candidateMetrics } : {}),
    ...(baselineMetrics ? { baselineMetrics } : {}),
    minImprovement,
    maxUnknownTokenRate,
    requirePromotion,
    ...(toolReport ? { toolReport } : {}),
    ...(toolBaselineReport ? { toolBaselineReport } : {}),
    requireToolPromotion,
    ...(knowledgeReport ? { knowledgeReport } : {}),
    ...(knowledgeBaselineReport ? { knowledgeBaselineReport } : {}),
    requireKnowledgePromotion,
    ...(behaviorReport ? { behaviorReport } : {}),
    ...(behaviorBaselineReport ? { behaviorBaselineReport } : {}),
    requireBehaviorPromotion,
    ...(routerReport ? { routerReport } : {}),
    ...(routerBaselineReport ? { routerBaselineReport } : {}),
    requireRouterPromotion,
    ...(out ? { out } : {}),
  };
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
