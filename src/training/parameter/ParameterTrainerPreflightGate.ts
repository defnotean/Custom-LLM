import {
  checkProductionTrainingReadiness,
  type ProductionTrainingReadinessOptions,
} from "../quality/ProductionTrainingReadiness";
import {
  checkSubquadraticArchitectureReadiness,
  type SubquadraticArchitectureReadinessOptions,
} from "../quality/SubquadraticArchitectureReadiness";
import {
  checkParameterGrowthDatasetQuality,
  type ParameterGrowthDatasetQualityReport,
} from "./ParameterGrowthDatasetQuality";

export type ParameterTrainerPreflightStatus = "pass" | "fail";

export interface ParameterTrainerPreflightOptions {
  datasetManifestPath: string;
  requireSubqArchitecture?: boolean;
  requireProductionReadiness?: boolean;
  subqArchitectureOptions?: SubquadraticArchitectureReadinessOptions;
  productionReadinessOptions?: ProductionTrainingReadinessOptions;
  now?: () => string;
}

export interface ParameterTrainerPreflightCheck {
  id: string;
  status: ParameterTrainerPreflightStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ParameterTrainerPreflightReport {
  runtimeContract: "parameter-trainer-preflight-v1";
  status: ParameterTrainerPreflightStatus;
  generatedAt: string;
  datasetManifestPath: string;
  summary: {
    datasetQuality: "pass" | "fail";
    subqArchitecture: "pass" | "fail" | "skipped";
    productionReadiness: "ready" | "not_ready" | "skipped";
    productionWarnings: number;
  };
  checks: ParameterTrainerPreflightCheck[];
}

export async function checkParameterTrainerPreflight(
  options: ParameterTrainerPreflightOptions,
): Promise<ParameterTrainerPreflightReport> {
  const requireSubqArchitecture = options.requireSubqArchitecture ?? true;
  const requireProductionReadiness = options.requireProductionReadiness ?? true;
  const checks: ParameterTrainerPreflightCheck[] = [];
  const datasetQuality = await checkParameterGrowthDatasetQuality(options.datasetManifestPath);
  checks.push(datasetQualityCheck(datasetQuality));

  let subqStatus: "pass" | "fail" | "skipped" = "skipped";
  if (requireSubqArchitecture) {
    const subq = await checkSubquadraticArchitectureReadiness(options.subqArchitectureOptions);
    subqStatus = subq.status;
    checks.push(
      subq.status === "pass"
        ? pass("subq-architecture", `SubQ/SSA architecture contract passed with ${subq.summary.cases} long-context cases`, {
            maxTargetContextChars: subq.summary.maxTargetContextChars,
          })
        : fail("subq-architecture", "SubQ/SSA architecture contract failed", {
            failures: subq.checks
              .filter((check) => check.status === "fail")
              .map((check) => ({ id: check.id, summary: check.summary, details: check.details })),
          }),
    );
  } else {
    checks.push(pass("subq-architecture-skipped", "SubQ/SSA architecture preflight was explicitly skipped"));
  }

  let productionStatus: "ready" | "not_ready" | "skipped" = "skipped";
  let productionWarnings = 0;
  if (requireProductionReadiness) {
    const production = await checkProductionTrainingReadiness(options.productionReadinessOptions);
    productionStatus = production.status;
    productionWarnings = production.checks.filter((check) => check.status === "warn").length;
    checks.push(
      production.status === "ready"
        ? pass("production-readiness", `Production ${production.stage} readiness is ready`, {
            warnings: productionWarnings,
            sftTrain: production.summary.sftTrain,
            sftValidation: production.summary.sftValidation,
            syntheticTrainShare: production.summary.syntheticTrainShare,
          })
        : fail("production-readiness", `Production ${production.stage} readiness is not ready`, {
            failures: production.checks
              .filter((check) => check.status === "fail")
              .map((check) => ({ id: check.id, summary: check.summary, details: check.details })),
            warnings: productionWarnings,
          }),
    );
  } else {
    checks.push(pass("production-readiness-skipped", "Production readiness preflight was explicitly skipped"));
  }

  return {
    runtimeContract: "parameter-trainer-preflight-v1",
    status: checks.some((check) => check.status === "fail") ? "fail" : "pass",
    generatedAt: options.now?.() ?? new Date().toISOString(),
    datasetManifestPath: options.datasetManifestPath,
    summary: {
      datasetQuality: datasetQuality.status,
      subqArchitecture: subqStatus,
      productionReadiness: productionStatus,
      productionWarnings,
    },
    checks,
  };
}

function datasetQualityCheck(report: ParameterGrowthDatasetQualityReport): ParameterTrainerPreflightCheck {
  return report.status === "pass"
    ? pass("dataset-quality", `Parameter-growth dataset quality passed with ${report.summary.records} records`, {
        batches: report.summary.batches,
        files: report.summary.files,
        gateStatus: report.summary.gateStatus,
      })
    : fail("dataset-quality", "Parameter-growth dataset quality failed", {
        failures: report.checks
          .filter((check) => check.status === "fail")
          .map((check) => ({ id: check.id, summary: check.summary, details: check.details })),
      });
}

function pass(id: string, summary: string, details?: Record<string, unknown>): ParameterTrainerPreflightCheck {
  return { id, status: "pass", summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): ParameterTrainerPreflightCheck {
  return { id, status: "fail", summary, ...(details ? { details } : {}) };
}
