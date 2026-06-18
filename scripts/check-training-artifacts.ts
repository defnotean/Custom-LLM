import { checkTrainingArtifacts } from "../src/training/quality/TrainingArtifactQuality";

interface Args {
  datasetReport: string;
  metrics: string;
  baselineMetrics?: string;
  requireBaselineImprovement: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await checkTrainingArtifacts({
    datasetReportPath: args.datasetReport,
    metricsPath: args.metrics,
    ...(args.baselineMetrics ? { baselineMetricsPath: args.baselineMetrics } : {}),
  });
  if (args.requireBaselineImprovement && report.comparison && !report.comparison.improved) {
    throw new Error(
      `Candidate run did not improve best validation loss: baseline=${report.comparison.baselineBestValLoss}, candidate=${report.comparison.candidateBestValLoss}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

function parseArgs(argv: string[]): Args {
  let datasetReport = "training/data/processed/dataset_report.json";
  let metrics = "training/runs/tiny-transformer-iter4-byte/metrics.json";
  let baselineMetrics: string | undefined;
  let requireBaselineImprovement = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dataset-report") datasetReport = requireValue(argv[++index], arg);
    else if (arg === "--metrics") metrics = requireValue(argv[++index], arg);
    else if (arg === "--baseline-metrics") baselineMetrics = requireValue(argv[++index], arg);
    else if (arg === "--require-baseline-improvement") requireBaselineImprovement = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return { datasetReport, metrics, ...(baselineMetrics ? { baselineMetrics } : {}), requireBaselineImprovement };
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
