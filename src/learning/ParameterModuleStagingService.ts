import type {
  ParameterEvalReport,
  ParameterModule,
  ParameterModuleKind,
  ParameterModuleStatus,
} from "./LiveLearningRegistry";
import { toJsonValue, type JsonObject } from "../types/common";
import {
  checkParameterModuleStagingManifest,
  readParameterModuleStagingManifest,
  type ParameterModuleStagingEvalKind,
  type ParameterModuleStagingGateOptions,
  type ParameterModuleStagingGateReport,
  type ParameterModuleStagingManifest,
} from "../training/parameter/ParameterModuleStagingGate";

export interface ParameterModuleStagingSink {
  createParameterModule(input: ParameterModuleCreateInput): Promise<ParameterModule>;
}

export interface ParameterModuleCreateInput {
  id?: string;
  name: string;
  kind: ParameterModuleKind;
  parameters: number;
  activeParameters?: number;
  trainableParameters?: number;
  status?: ParameterModuleStatus;
  baseModuleId?: string;
  route?: string;
  datasetHashes?: string[];
  evalReports?: ParameterEvalReport[];
  sourceLearningItemIds?: string[];
  rollbackTargetId?: string;
  metadata?: JsonObject;
}

export interface StageParameterModuleFromManifestInput {
  manifestPath: string;
  id?: string;
  gateOptions?: ParameterModuleStagingGateOptions;
  metadata?: JsonObject;
}

export interface StageParameterModuleFromManifestResult {
  module: ParameterModule;
  gateReport: ParameterModuleStagingGateReport;
}

const RUNTIME_EVAL_KINDS = new Set<ParameterEvalReport["kind"]>([
  "protocol",
  "knowledge",
  "behavior",
  "router",
  "memory",
  "skill",
  "voice",
  "composite",
]);

export class ParameterModuleStagingService {
  constructor(private readonly sink: ParameterModuleStagingSink) {}

  async stageFromManifest(input: StageParameterModuleFromManifestInput): Promise<StageParameterModuleFromManifestResult> {
    const gateReport = await checkParameterModuleStagingManifest(input.manifestPath, input.gateOptions);
    if (gateReport.status !== "pass") {
      const failedChecks = gateReport.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.id)
        .join(", ");
      throw new Error(`parameter module staging gate failed: ${failedChecks || "unknown failure"}`);
    }

    const manifest = await readParameterModuleStagingManifest(input.manifestPath);
    const module = await this.sink.createParameterModule(
      buildParameterModuleCreateInputFromStagingManifest({
        manifest,
        manifestPath: input.manifestPath,
        gateReport,
        id: input.id,
        metadata: input.metadata,
      }),
    );
    return { module, gateReport };
  }
}

export function buildParameterModuleCreateInputFromStagingManifest(input: {
  manifest: ParameterModuleStagingManifest;
  manifestPath: string;
  gateReport: ParameterModuleStagingGateReport;
  id?: string;
  metadata?: JsonObject;
}): ParameterModuleCreateInput {
  const runtimeReports = input.manifest.evalReports
    .filter((report): report is typeof report & { kind: ParameterEvalReport["kind"] } =>
      RUNTIME_EVAL_KINDS.has(report.kind as ParameterEvalReport["kind"]),
    )
    .map((report) => ({
      kind: report.kind,
      path: report.path,
      status: report.status,
      ...(report.summary ? { summary: report.summary } : {}),
    }));

  return {
    ...(input.id ? { id: input.id } : {}),
    name: input.manifest.moduleName,
    kind: input.manifest.kind,
    parameters: input.manifest.parameters,
    activeParameters: input.manifest.activeParameters,
    trainableParameters: input.manifest.trainableParameters,
    status: "staged",
    ...(input.manifest.baseModuleId ? { baseModuleId: input.manifest.baseModuleId } : {}),
    ...(input.manifest.route ? { route: input.manifest.route } : {}),
    datasetHashes: input.manifest.datasetHashes,
    evalReports: [
      ...runtimeReports,
      {
        kind: "composite",
        path: input.manifestPath,
        status: "pass",
        summary: "Parameter module staging gate passed",
      },
    ],
    sourceLearningItemIds: input.manifest.sourceLearningItemIds,
    ...(input.manifest.rollbackTargetId ? { rollbackTargetId: input.manifest.rollbackTargetId } : {}),
    metadata: asJsonObject({
      ...(input.metadata ?? {}),
      ...(input.manifest.metadata ?? {}),
      staging: {
        manifestPath: input.manifestPath,
        trainedAt: input.manifest.trainedAt,
        trainer: input.manifest.trainer,
        datasetManifestPath: input.manifest.datasetManifestPath,
        datasetManifestSha256: input.manifest.datasetManifestSha256,
        artifacts: input.manifest.artifacts,
        evalReports: input.manifest.evalReports,
        gateReport: input.gateReport,
      },
    }),
  };
}

export type StageParameterModuleEvalKind = ParameterModuleStagingEvalKind;

function asJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (json && typeof json === "object" && !Array.isArray(json)) return json as JsonObject;
  return {};
}
