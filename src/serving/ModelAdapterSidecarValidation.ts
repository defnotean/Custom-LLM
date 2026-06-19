import { randomUUID } from "node:crypto";
import {
  checkParameterModuleHotloadManifestQuality,
  readParameterModuleHotloadManifest,
  type ParameterModuleHotloadQualityReport,
} from "../learning/ParameterModuleHotloadManifestQuality";
import type { ParameterModuleHotloadManifest, ParameterModuleHotloadRequest } from "../learning/ParameterModuleHotloadPlanner";
import type { JsonValue } from "../types/common";
import { toJsonValue } from "../types/common";
import type { ModelAdapterSidecarModule, ModelAdapterSidecarRequest } from "./ModelAdapterSidecarServer";

export const DEFAULT_MODEL_ADAPTER_SIDECAR_URL = "http://127.0.0.1:9099";

export type ModelAdapterSidecarValidationStatus = "ready" | "validated" | "empty" | "blocked" | "failed";

export type ModelAdapterSidecarValidationFetch = (
  input: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

export interface ValidateModelAdapterSidecarInput {
  manifestPath: string;
  endpointUrl?: string;
  apiKey?: string;
  execute?: boolean;
  rollback?: boolean;
  requestId?: string;
  timeoutMs?: number;
  fetchImpl?: ModelAdapterSidecarValidationFetch;
  now?: () => string;
}

export interface ModelAdapterSidecarValidationHttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: JsonValue;
  message?: string;
}

export interface ModelAdapterSidecarValidationReport {
  runtimeContract: "model-adapter-sidecar-validation-v1";
  status: ModelAdapterSidecarValidationStatus;
  manifestPath: string;
  manifestId?: string;
  generatedAt: string;
  dryRun: boolean;
  endpointUrl: string;
  requestId: string;
  rollback: boolean;
  summary: ParameterModuleHotloadQualityReport["summary"];
  qualityReport: ParameterModuleHotloadQualityReport;
  loadRequest?: ModelAdapterSidecarRequest;
  rollbackRequest?: ModelAdapterSidecarRequest;
  health?: ModelAdapterSidecarValidationHttpResult;
  loadResult?: ModelAdapterSidecarValidationHttpResult;
  statusAfterLoad?: ModelAdapterSidecarValidationHttpResult;
  rollbackResult?: ModelAdapterSidecarValidationHttpResult;
  statusAfterRollback?: ModelAdapterSidecarValidationHttpResult;
  rollbackSkipped?: { reason: string };
}

export async function validateModelAdapterSidecar(
  input: ValidateModelAdapterSidecarInput,
): Promise<ModelAdapterSidecarValidationReport> {
  const requestId = input.requestId ?? randomUUID();
  const generatedAt = input.now?.() ?? new Date().toISOString();
  const endpointUrl = normalizeEndpointUrl(input.endpointUrl ?? DEFAULT_MODEL_ADAPTER_SIDECAR_URL);
  const dryRun = !(input.execute ?? false);
  const rollback = input.rollback ?? true;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const qualityReport = await checkParameterModuleHotloadManifestQuality(input.manifestPath);

  if (qualityReport.status !== "pass") {
    return {
      runtimeContract: "model-adapter-sidecar-validation-v1",
      status: "blocked",
      manifestPath: input.manifestPath,
      generatedAt,
      dryRun,
      endpointUrl,
      requestId,
      rollback,
      summary: qualityReport.summary,
      qualityReport,
    };
  }

  const manifest = await readParameterModuleHotloadManifest(input.manifestPath);
  const loadRequest = buildSidecarRequest("load", requestId, manifest);
  const rollbackRequest = buildSidecarRequest("rollback", `${requestId}:rollback`, manifest);

  if (manifest.status === "empty" || manifest.requests.length === 0) {
    return baseReport("empty", input.manifestPath, manifest, generatedAt, dryRun, endpointUrl, requestId, rollback, qualityReport);
  }

  const report = baseReport(
    dryRun ? "ready" : "failed",
    input.manifestPath,
    manifest,
    generatedAt,
    dryRun,
    endpointUrl,
    requestId,
    rollback,
    qualityReport,
    loadRequest,
    rollbackRequest,
  );
  if (dryRun) return report;

  const fetchImpl = input.fetchImpl ?? ((request, init) => fetch(request, init));
  report.health = await requestSidecarJson({
    endpointUrl,
    path: "/health",
    method: "GET",
    apiKey: input.apiKey,
    timeoutMs,
    fetchImpl,
  });
  if (!report.health.ok) return report;

  report.loadResult = await requestSidecarJson({
    endpointUrl,
    path: "/parameter-modules",
    method: "POST",
    body: loadRequest,
    apiKey: input.apiKey,
    timeoutMs,
    fetchImpl,
  });
  if (!sidecarAccepted(report.loadResult)) return report;

  report.statusAfterLoad = await requestSidecarJson({
    endpointUrl,
    path: "/parameter-modules/status",
    method: "GET",
    apiKey: input.apiKey,
    timeoutMs,
    fetchImpl,
  });

  if (!rollback) {
    report.rollbackSkipped = { reason: "rollback disabled by caller" };
    report.status = report.statusAfterLoad.ok ? "validated" : "failed";
    return report;
  }

  report.rollbackResult = await requestSidecarJson({
    endpointUrl,
    path: "/parameter-modules",
    method: "POST",
    body: rollbackRequest,
    apiKey: input.apiKey,
    timeoutMs,
    fetchImpl,
  });
  report.statusAfterRollback = await requestSidecarJson({
    endpointUrl,
    path: "/parameter-modules/status",
    method: "GET",
    apiKey: input.apiKey,
    timeoutMs,
    fetchImpl,
  });
  report.status = sidecarAccepted(report.rollbackResult) && report.statusAfterRollback.ok ? "validated" : "failed";
  return report;
}

function baseReport(
  status: ModelAdapterSidecarValidationStatus,
  manifestPath: string,
  manifest: ParameterModuleHotloadManifest,
  generatedAt: string,
  dryRun: boolean,
  endpointUrl: string,
  requestId: string,
  rollback: boolean,
  qualityReport: ParameterModuleHotloadQualityReport,
  loadRequest?: ModelAdapterSidecarRequest,
  rollbackRequest?: ModelAdapterSidecarRequest,
): ModelAdapterSidecarValidationReport {
  return {
    runtimeContract: "model-adapter-sidecar-validation-v1",
    status,
    manifestPath,
    manifestId: manifest.id,
    generatedAt,
    dryRun,
    endpointUrl,
    requestId,
    rollback,
    summary: qualityReport.summary,
    qualityReport,
    ...(loadRequest ? { loadRequest } : {}),
    ...(rollbackRequest ? { rollbackRequest } : {}),
  };
}

function buildSidecarRequest(
  action: "load" | "rollback",
  requestId: string,
  manifest: ParameterModuleHotloadManifest,
): ModelAdapterSidecarRequest {
  return {
    runtimeContract: "parameter-hotload-backend-v1",
    action,
    requestId,
    ...(action === "load" ? { manifest } : {}),
    modules: manifest.requests.map(sidecarModuleFromHotloadRequest),
  };
}

function sidecarModuleFromHotloadRequest(request: ParameterModuleHotloadRequest): ModelAdapterSidecarModule {
  return {
    moduleId: request.moduleId,
    name: request.name,
    kind: request.kind,
    ...(request.route ? { route: request.route } : {}),
    ...(request.baseModuleId ? { baseModuleId: request.baseModuleId } : {}),
    rollbackTargetId: request.rollbackTargetId,
    ...(request.stagingManifestPath ? { stagingManifestPath: request.stagingManifestPath } : {}),
    artifacts: request.artifacts,
  };
}

async function requestSidecarJson(options: {
  endpointUrl: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  apiKey?: string;
  timeoutMs: number;
  fetchImpl: ModelAdapterSidecarValidationFetch;
}): Promise<ModelAdapterSidecarValidationHttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    if (options.method === "POST") headers["content-type"] = "application/json";
    const response = await options.fetchImpl(`${options.endpointUrl}${options.path}`, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: `${JSON.stringify(options.body)}\n` }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const body = toJsonValue(parseBody(bodyText));
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body,
      ...(response.ok ? {} : { message: `model adapter sidecar returned HTTP ${response.status} ${response.statusText}` }),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      statusText: "REQUEST_FAILED",
      body: {},
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sidecarAccepted(result: ModelAdapterSidecarValidationHttpResult): boolean {
  return result.ok && isRecord(result.body) && result.body.status === "accepted";
}

function normalizeEndpointUrl(value: string): string {
  let normalized = value.replace(/\/+$/g, "");
  normalized = normalized.replace(/\/parameter-modules\/status$/g, "");
  normalized = normalized.replace(/\/parameter-modules$/g, "");
  return normalized || DEFAULT_MODEL_ADAPTER_SIDECAR_URL;
}

function parseBody(body: string): unknown {
  if (body.trim().length === 0) return {};
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
