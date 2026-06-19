import { readFile } from "node:fs/promises";
import {
  ParameterGrowthDatasetBuilder,
  type ParameterGrowthDatasetManifest,
} from "./ParameterGrowthDatasetBuilder";
import {
  checkParameterGrowthDatasetQuality,
  type ParameterGrowthDatasetQualityReport,
} from "./ParameterGrowthDatasetQuality";
import {
  applyParameterGrowthPlanGate,
  type ParameterGrowthGateResult,
  type ParameterGrowthGateThresholds,
} from "./ParameterGrowthPlanGate";
import type { ParameterGrowthPlan } from "./ParameterGrowthPlanner";

export interface BuildParameterGrowthDatasetInput {
  planPath: string;
  outDir: string;
  execute?: boolean;
  gateThresholds?: Partial<ParameterGrowthGateThresholds>;
  now?: () => string;
}

export interface ParameterGrowthDatasetBuildReport {
  runtimeContract: "parameter-growth-dataset-build-v1";
  status: "dry_run" | "built" | "blocked" | "failed";
  generatedAt: string;
  dryRun: boolean;
  planPath: string;
  outDir: string;
  planId?: string;
  gateReport?: ParameterGrowthGateResult;
  manifestPath?: string;
  manifest?: ParameterGrowthDatasetManifest;
  qualityReport?: ParameterGrowthDatasetQualityReport;
  error?: string;
  nextActions: string[];
}

export class ParameterGrowthDatasetBuildRunner {
  constructor(
    private readonly builder: ParameterGrowthDatasetBuilder,
    private readonly qualityChecker: (manifestPath: string) => Promise<ParameterGrowthDatasetQualityReport> =
      checkParameterGrowthDatasetQuality,
  ) {}

  async run(input: BuildParameterGrowthDatasetInput): Promise<ParameterGrowthDatasetBuildReport> {
    const generatedAt = input.now?.() ?? new Date().toISOString();
    const dryRun = !(input.execute ?? false);
    let plan: ParameterGrowthPlan;
    try {
      plan = JSON.parse(await readFile(input.planPath, "utf8")) as ParameterGrowthPlan;
    } catch (err) {
      return {
        runtimeContract: "parameter-growth-dataset-build-v1",
        status: "failed",
        generatedAt,
        dryRun,
        planPath: input.planPath,
        outDir: input.outDir,
        error: err instanceof Error ? err.message : String(err),
        nextActions: ["write or select a valid parameter-growth plan before building training data"],
      };
    }

    const gateReport = applyParameterGrowthPlanGate({ plan, thresholds: input.gateThresholds });
    if (gateReport.status !== "pass") {
      return {
        runtimeContract: "parameter-growth-dataset-build-v1",
        status: "blocked",
        generatedAt,
        dryRun,
        planPath: input.planPath,
        outDir: input.outDir,
        planId: plan.id,
        gateReport,
        nextActions: [
          "fix parameter-growth plan gate failures before writing dataset files",
          "use batch review/queue or a new parameter-growth plan if more trainable learning is required",
        ],
      };
    }

    if (dryRun) {
      return {
        runtimeContract: "parameter-growth-dataset-build-v1",
        status: "dry_run",
        generatedAt,
        dryRun,
        planPath: input.planPath,
        outDir: input.outDir,
        planId: plan.id,
        gateReport,
        nextActions: [
          "rerun with execute:true to write parameter-growth dataset files",
          "then run the dataset quality gate before trainer dispatch",
        ],
      };
    }

    try {
      const built = await this.builder.build(plan, {
        outDir: input.outDir,
        gateThresholds: input.gateThresholds,
        now: input.now,
      });
      const qualityReport = await this.qualityChecker(built.manifestPath);
      return {
        runtimeContract: "parameter-growth-dataset-build-v1",
        status: qualityReport.status === "pass" ? "built" : "failed",
        generatedAt,
        dryRun,
        planPath: input.planPath,
        outDir: input.outDir,
        planId: plan.id,
        gateReport,
        manifestPath: built.manifestPath,
        manifest: built.manifest,
        qualityReport,
        nextActions:
          qualityReport.status === "pass"
            ? [
                "run dispatch:parameter-training in dry-run mode or POST the manifest to the trainer control endpoint",
                "do not promote a parameter module until staging, eval, promotion, and hotload gates pass",
              ]
            : ["fix dataset quality failures before dispatching trainer compute"],
      };
    } catch (err) {
      return {
        runtimeContract: "parameter-growth-dataset-build-v1",
        status: "failed",
        generatedAt,
        dryRun,
        planPath: input.planPath,
        outDir: input.outDir,
        planId: plan.id,
        gateReport,
        error: err instanceof Error ? err.message : String(err),
        nextActions: ["fix the dataset build failure and rerun before trainer dispatch"],
      };
    }
  }
}
