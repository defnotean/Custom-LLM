import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JsonObject } from "../types/common";
import { toJsonValue } from "../types/common";
import type { ParameterModuleHotloadManifest } from "./ParameterModuleHotloadPlanner";
import {
  checkParameterModuleHotloadManifestQuality,
  readParameterModuleHotloadManifest,
  type ParameterModuleHotloadQualityReport,
} from "./ParameterModuleHotloadManifestQuality";

export type ParameterModuleHotloadApplyStatus = "applied" | "dry_run" | "empty" | "blocked" | "failed";

export interface ApplyParameterModuleHotloadInput {
  manifestPath: string;
  dryRun?: boolean;
  requestId?: string;
}

export interface ParameterModuleHotloadLoaderRequest {
  runtimeContract: "parameter-module-hotload-apply-v1";
  requestId: string;
  dryRun: boolean;
  manifest: ParameterModuleHotloadManifest;
}

export interface ParameterModuleHotloadLoaderResult {
  status: "accepted" | "rejected";
  loadedModuleIds: string[];
  message?: string;
  details?: JsonObject;
}

export interface ParameterModuleHotloadApplyReport {
  status: ParameterModuleHotloadApplyStatus;
  manifestPath: string;
  manifestId?: string;
  generatedAt: string;
  dryRun: boolean;
  requestId: string;
  summary: {
    manifestStatus: string;
    loadRequests: number;
    skippedModules: number;
    artifacts: number;
    totalLoadedParameters: number;
    activeParametersPerRequest: number;
  };
  qualityReport: ParameterModuleHotloadQualityReport;
  loaderRequest?: ParameterModuleHotloadLoaderRequest;
  loaderResult?: ParameterModuleHotloadLoaderResult;
}

export interface ParameterModuleHotloadLoader {
  apply(request: ParameterModuleHotloadLoaderRequest): Promise<ParameterModuleHotloadLoaderResult>;
}

export class ParameterModuleHotloadService {
  constructor(private readonly loader?: ParameterModuleHotloadLoader) {}

  async apply(input: ApplyParameterModuleHotloadInput): Promise<ParameterModuleHotloadApplyReport> {
    const requestId = input.requestId ?? randomUUID();
    const dryRun = input.dryRun ?? false;
    const qualityReport = await checkParameterModuleHotloadManifestQuality(input.manifestPath);

    if (qualityReport.status !== "pass") {
      return {
        status: "blocked",
        manifestPath: input.manifestPath,
        generatedAt: new Date().toISOString(),
        dryRun,
        requestId,
        summary: qualityReport.summary,
        qualityReport,
      };
    }

    const manifest = await readParameterModuleHotloadManifest(input.manifestPath);
    const loaderRequest: ParameterModuleHotloadLoaderRequest = {
      runtimeContract: "parameter-module-hotload-apply-v1",
      requestId,
      dryRun,
      manifest,
    };

    if (manifest.status === "empty" || manifest.requests.length === 0) {
      return this.report("empty", input.manifestPath, manifest, dryRun, requestId, qualityReport, loaderRequest);
    }

    if (dryRun) {
      return this.report("dry_run", input.manifestPath, manifest, dryRun, requestId, qualityReport, loaderRequest);
    }

    if (!this.loader) {
      throw new Error("parameter hotload loader is not configured; set PARAMETER_HOTLOAD_ENDPOINT or use dryRun");
    }

    const loaderResult = await this.loader.apply(loaderRequest);
    return this.report(
      loaderResult.status === "accepted" ? "applied" : "failed",
      input.manifestPath,
      manifest,
      dryRun,
      requestId,
      qualityReport,
      loaderRequest,
      loaderResult,
    );
  }

  private report(
    status: ParameterModuleHotloadApplyStatus,
    manifestPath: string,
    manifest: ParameterModuleHotloadManifest,
    dryRun: boolean,
    requestId: string,
    qualityReport: ParameterModuleHotloadQualityReport,
    loaderRequest: ParameterModuleHotloadLoaderRequest,
    loaderResult?: ParameterModuleHotloadLoaderResult,
  ): ParameterModuleHotloadApplyReport {
    return {
      status,
      manifestPath,
      manifestId: manifest.id,
      generatedAt: new Date().toISOString(),
      dryRun,
      requestId,
      summary: qualityReport.summary,
      qualityReport,
      loaderRequest,
      ...(loaderResult ? { loaderResult } : {}),
    };
  }
}

export interface HttpParameterModuleHotloadLoaderOptions {
  endpointUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export type FetchLike = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

const loaderResponseSchema = z
  .object({
    status: z.enum(["accepted", "rejected"]).optional(),
    loadedModuleIds: z.array(z.string().min(1)).optional(),
    message: z.string().optional(),
    details: z.record(z.unknown()).optional(),
  })
  .passthrough();

export class HttpParameterModuleHotloadLoader implements ParameterModuleHotloadLoader {
  private readonly endpointUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: HttpParameterModuleHotloadLoaderOptions) {
    this.endpointUrl = options.endpointUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async apply(request: ParameterModuleHotloadLoaderRequest): Promise<ParameterModuleHotloadLoaderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const response = await this.fetchImpl(this.endpointUrl, {
        method: "POST",
        headers,
        body: `${JSON.stringify(request)}\n`,
        signal: controller.signal,
      });
      const bodyText = await response.text();
      const body = parseBody(bodyText);
      if (!response.ok) {
        return {
          status: "rejected",
          loadedModuleIds: [],
          message: `model-server hotload endpoint returned HTTP ${response.status} ${response.statusText}`,
          details: asJsonObject({ response: body }),
        };
      }

      const parsed = loaderResponseSchema.safeParse(body);
      if (!parsed.success) {
        return {
          status: "accepted",
          loadedModuleIds: request.manifest.requests.map((item) => item.moduleId),
          details: asJsonObject({ response: body }),
        };
      }

      return {
        status: parsed.data.status ?? "accepted",
        loadedModuleIds: parsed.data.loadedModuleIds ?? request.manifest.requests.map((item) => item.moduleId),
        ...(parsed.data.message ? { message: parsed.data.message } : {}),
        ...(parsed.data.details ? { details: asJsonObject(parsed.data.details) } : {}),
      };
    } catch (err) {
      return {
        status: "rejected",
        loadedModuleIds: [],
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseBody(body: string): unknown {
  if (body.trim().length === 0) return {};
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

function asJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (json && typeof json === "object" && !Array.isArray(json)) return json as JsonObject;
  return { value: json };
}
