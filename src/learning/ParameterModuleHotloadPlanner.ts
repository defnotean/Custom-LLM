import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "../types/common";
import type { ParameterEvalReport, ParameterModule, ParameterModuleKind } from "./LiveLearningRegistry";

export interface ParameterModuleHotloadSource {
  listParameterModules(filter?: { status?: "active"; limit?: number }): Promise<ParameterModule[]>;
}

export interface ParameterModuleHotloadPlannerOptions {
  now?: () => string;
  limit?: number;
  includeModuleIds?: string[];
}

export interface ParameterModuleHotloadArtifact {
  kind: string;
  path: string;
  sha256: string;
  bytes?: number;
}

export interface ParameterModuleHotloadRequest {
  action: "load";
  moduleId: string;
  name: string;
  kind: Exclude<ParameterModuleKind, "base_model">;
  parameters: number;
  activeParameters: number;
  trainableParameters: number;
  route?: string;
  baseModuleId?: string;
  rollbackTargetId: string;
  stagingManifestPath?: string;
  trainedAt?: string;
  trainer?: string;
  artifacts: ParameterModuleHotloadArtifact[];
  datasetHashes: string[];
  sourceLearningItemIds: string[];
  evalReports: ParameterEvalReport[];
}

export interface ParameterModuleHotloadSkipped {
  moduleId: string;
  name: string;
  kind: ParameterModuleKind;
  reasons: string[];
}

export interface ParameterModuleHotloadManifest {
  id: string;
  generatedAt: string;
  status: "ready" | "blocked" | "empty";
  runtimeContract: "parameter-module-hotload-v1";
  summary: {
    activeModulesScanned: number;
    loadRequests: number;
    skippedModules: number;
    totalLoadedParameters: number;
    activeParametersPerRequest: number;
  };
  requests: ParameterModuleHotloadRequest[];
  skipped: ParameterModuleHotloadSkipped[];
}

export interface WrittenParameterModuleHotloadManifest {
  path: string;
  latestPath: string;
  manifest: ParameterModuleHotloadManifest;
}

export class ParameterModuleHotloadPlanner {
  constructor(
    private readonly source: ParameterModuleHotloadSource,
    private readonly options: ParameterModuleHotloadPlannerOptions = {},
  ) {}

  async buildManifest(options: ParameterModuleHotloadPlannerOptions = {}): Promise<ParameterModuleHotloadManifest> {
    const merged = mergeOptions(this.options, options);
    const modules = await this.source.listParameterModules({
      status: "active",
      ...(merged.limit ? { limit: merged.limit } : {}),
    });
    return buildParameterModuleHotloadManifest(modules, merged);
  }

  async writeManifest(
    outDir: string,
    options: ParameterModuleHotloadPlannerOptions = {},
  ): Promise<WrittenParameterModuleHotloadManifest> {
    const manifest = await this.buildManifest(options);
    await mkdir(outDir, { recursive: true });
    const path = join(outDir, `${dateSlug(manifest.generatedAt)}-${manifest.id.slice(-8)}.json`);
    const latestPath = join(outDir, "latest.json");
    const body = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(path, body, "utf8");
    await writeFile(latestPath, body, "utf8");
    return { path, latestPath, manifest };
  }
}

export function buildParameterModuleHotloadManifest(
  modules: ParameterModule[],
  options: ParameterModuleHotloadPlannerOptions = {},
): ParameterModuleHotloadManifest {
  const generatedAt = options.now?.() ?? new Date().toISOString();
  const includeIds = new Set(options.includeModuleIds ?? []);
  const activeModules = modules
    .filter((module) => module.status === "active")
    .filter((module) => module.kind !== "base_model")
    .filter((module) => (includeIds.size > 0 ? includeIds.has(module.id) : true));

  const requests: ParameterModuleHotloadRequest[] = [];
  const skipped: ParameterModuleHotloadSkipped[] = [];
  for (const module of activeModules) {
    const parsed = toHotloadRequest(module);
    if (parsed.request) requests.push(parsed.request);
    if (parsed.reasons.length > 0) {
      skipped.push({
        moduleId: module.id,
        name: module.name,
        kind: module.kind,
        reasons: parsed.reasons,
      });
    }
  }

  const status = skipped.length > 0 ? "blocked" : requests.length > 0 ? "ready" : "empty";
  const id = `parameter-hotload-${dateSlug(generatedAt)}-${hashText(
    requests.map((request) => request.moduleId).join("|"),
  ).slice(0, 8)}`;
  return {
    id,
    generatedAt,
    status,
    runtimeContract: "parameter-module-hotload-v1",
    summary: {
      activeModulesScanned: activeModules.length,
      loadRequests: requests.length,
      skippedModules: skipped.length,
      totalLoadedParameters: requests.reduce((sum, request) => sum + request.parameters, 0),
      activeParametersPerRequest: requests.reduce((sum, request) => sum + request.activeParameters, 0),
    },
    requests,
    skipped,
  };
}

function toHotloadRequest(module: ParameterModule): {
  request?: ParameterModuleHotloadRequest;
  reasons: string[];
} {
  const staging = asRecord(module.metadata.staging);
  const artifacts = parseArtifacts(staging?.artifacts);
  const reasons: string[] = [];
  if (!module.rollbackTargetId) reasons.push("missing rollback target");
  if (!staging) reasons.push("missing staging metadata");
  if (artifacts.length === 0) reasons.push("missing staging artifacts");
  if (artifacts.some((artifact) => !/^[a-f0-9]{64}$/i.test(artifact.sha256))) {
    reasons.push("artifact sha256 evidence is missing or invalid");
  }
  if (module.evalReports.some((report) => report.status === "fail")) reasons.push("module has failed eval reports");

  if (reasons.length > 0) return { reasons };

  return {
    reasons,
    request: {
      action: "load",
      moduleId: module.id,
      name: module.name,
      kind: module.kind as Exclude<ParameterModuleKind, "base_model">,
      parameters: module.parameters,
      activeParameters: module.activeParameters,
      trainableParameters: module.trainableParameters,
      ...(module.route ? { route: module.route } : {}),
      ...(module.baseModuleId ? { baseModuleId: module.baseModuleId } : {}),
      rollbackTargetId: module.rollbackTargetId!,
      ...stringField(staging, "manifestPath", "stagingManifestPath"),
      ...stringField(staging, "trainedAt", "trainedAt"),
      ...stringField(staging, "trainer", "trainer"),
      artifacts,
      datasetHashes: [...module.datasetHashes],
      sourceLearningItemIds: [...module.sourceLearningItemIds],
      evalReports: [...module.evalReports],
    },
  };
}

function parseArtifacts(value: unknown): ParameterModuleHotloadArtifact[] {
  if (!Array.isArray(value)) return [];
  const artifacts: ParameterModuleHotloadArtifact[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const kind = stringValue(record.kind);
    const path = stringValue(record.path);
    const sha256 = stringValue(record.sha256);
    const bytes = numberValue(record.bytes);
    if (!kind || !path || !sha256) continue;
    artifacts.push({ kind, path, sha256, ...(bytes !== undefined ? { bytes } : {}) });
  }
  return artifacts;
}

function stringField<T extends string>(record: Record<string, unknown> | undefined, source: string, target: T): Record<T, string> | {} {
  const value = record ? stringValue(record[source]) : undefined;
  return value ? { [target]: value } as Record<T, string> : {};
}

function mergeOptions(
  base: ParameterModuleHotloadPlannerOptions,
  override: ParameterModuleHotloadPlannerOptions,
): ParameterModuleHotloadPlannerOptions {
  return {
    ...base,
    ...override,
    includeModuleIds: override.includeModuleIds ?? base.includeModuleIds,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dateSlug(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, 14) || "undated";
}
