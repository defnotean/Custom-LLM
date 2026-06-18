import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { JsonObject } from "../../types/common";
import { toJsonValue } from "../../types/common";
import {
  checkParameterGrowthDatasetQuality,
  type ParameterGrowthDatasetQualityReport,
} from "./ParameterGrowthDatasetQuality";

export type ParameterTrainerDispatchStatus = "dispatched" | "dry_run" | "blocked" | "failed";

export interface DispatchParameterTrainingInput {
  manifestPath: string;
  dryRun?: boolean;
  requestId?: string;
  trainerProfile?: string;
  outDir?: string;
}

export interface ParameterTrainerDispatchRequest {
  runtimeContract: "parameter-training-dispatch-v1";
  requestId: string;
  dryRun: boolean;
  trainerProfile: string;
  datasetManifestPath: string;
  datasetManifest: ParameterTrainerDatasetManifest;
  expectedOutput: {
    runDir: string;
    stagingManifestPath: string;
    nextGates: string[];
  };
}

export interface ParameterTrainerBackendResult {
  status: "accepted" | "rejected";
  trainingRunId?: string;
  stagingManifestPath?: string;
  message?: string;
  details?: JsonObject;
}

export interface ParameterTrainerDispatchReport {
  status: ParameterTrainerDispatchStatus;
  manifestPath: string;
  generatedAt: string;
  dryRun: boolean;
  requestId: string;
  trainerProfile: string;
  qualityReport: ParameterGrowthDatasetQualityReport;
  dispatchRequest?: ParameterTrainerDispatchRequest;
  backendResult?: ParameterTrainerBackendResult;
}

export interface ParameterTrainerBackend {
  dispatch(request: ParameterTrainerDispatchRequest): Promise<ParameterTrainerBackendResult>;
}

export interface ParameterTrainerDispatchOptions {
  defaultTrainerProfile?: string;
  defaultOutDir?: string;
  now?: () => string;
  backend?: ParameterTrainerBackend;
}

const datasetManifestSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  generatedAt: z.string().min(1),
  gate: z.object({ status: z.string().min(1) }).passthrough(),
  files: z.array(
    z.object({
      batchId: z.string().min(1),
      path: z.string().min(1),
      lines: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().length(64),
    }),
  ),
  batches: z.array(
    z.object({
      batchId: z.string().min(1),
      targetKind: z.enum(["adapter", "router", "specialist", "expert"]),
      route: z.string().optional(),
      records: z.number().int().nonnegative(),
      moduleName: z.string().min(1),
      datasetId: z.string().min(1),
    }).passthrough(),
  ),
});

export type ParameterTrainerDatasetManifest = z.infer<typeof datasetManifestSchema>;

export class ParameterTrainerDispatchService {
  private readonly defaultTrainerProfile: string;
  private readonly defaultOutDir: string;
  private readonly now: () => string;
  private readonly backend?: ParameterTrainerBackend;

  constructor(options: ParameterTrainerDispatchOptions = {}) {
    this.defaultTrainerProfile = options.defaultTrainerProfile ?? "parameter-growth-default";
    this.defaultOutDir = options.defaultOutDir ?? "training/runs/parameter-modules";
    this.now = options.now ?? (() => new Date().toISOString());
    this.backend = options.backend;
  }

  async dispatch(input: DispatchParameterTrainingInput): Promise<ParameterTrainerDispatchReport> {
    const requestId = input.requestId ?? `parameter-training-${randomUUID()}`;
    const dryRun = input.dryRun ?? false;
    const trainerProfile = input.trainerProfile ?? this.defaultTrainerProfile;
    const qualityReport = await checkParameterGrowthDatasetQuality(input.manifestPath);
    if (qualityReport.status !== "pass") {
      return {
        status: "blocked",
        manifestPath: input.manifestPath,
        generatedAt: this.now(),
        dryRun,
        requestId,
        trainerProfile,
        qualityReport,
      };
    }

    const manifest = await readParameterTrainerDatasetManifest(input.manifestPath);
    const dispatchRequest: ParameterTrainerDispatchRequest = {
      runtimeContract: "parameter-training-dispatch-v1",
      requestId,
      dryRun,
      trainerProfile,
      datasetManifestPath: input.manifestPath,
      datasetManifest: manifest,
      expectedOutput: {
        runDir: join(input.outDir ?? this.defaultOutDir, requestId),
        stagingManifestPath: join(input.outDir ?? this.defaultOutDir, requestId, "staging-manifest.json"),
        nextGates: [
          "check:parameter-module-staging",
          "stage-from-manifest",
          "promoteParameterModule",
          "build:parameter-hotload",
          "check:parameter-hotload",
          "apply:parameter-hotload",
        ],
      },
    };

    if (dryRun) {
      return this.report("dry_run", input.manifestPath, dryRun, requestId, trainerProfile, qualityReport, dispatchRequest);
    }

    if (!this.backend) {
      throw new Error("parameter trainer backend is not configured; set PARAMETER_TRAINER_ENDPOINT or use dryRun");
    }

    const backendResult = await this.backend.dispatch(dispatchRequest);
    return this.report(
      backendResult.status === "accepted" ? "dispatched" : "failed",
      input.manifestPath,
      dryRun,
      requestId,
      trainerProfile,
      qualityReport,
      dispatchRequest,
      backendResult,
    );
  }

  private report(
    status: ParameterTrainerDispatchStatus,
    manifestPath: string,
    dryRun: boolean,
    requestId: string,
    trainerProfile: string,
    qualityReport: ParameterGrowthDatasetQualityReport,
    dispatchRequest?: ParameterTrainerDispatchRequest,
    backendResult?: ParameterTrainerBackendResult,
  ): ParameterTrainerDispatchReport {
    return {
      status,
      manifestPath,
      generatedAt: this.now(),
      dryRun,
      requestId,
      trainerProfile,
      qualityReport,
      ...(dispatchRequest ? { dispatchRequest } : {}),
      ...(backendResult ? { backendResult } : {}),
    };
  }
}

export interface HttpParameterTrainerBackendOptions {
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

const trainerResponseSchema = z
  .object({
    status: z.enum(["accepted", "rejected"]).optional(),
    trainingRunId: z.string().min(1).optional(),
    stagingManifestPath: z.string().min(1).optional(),
    message: z.string().optional(),
    details: z.record(z.unknown()).optional(),
  })
  .passthrough();

export class HttpParameterTrainerBackend implements ParameterTrainerBackend {
  private readonly endpointUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: HttpParameterTrainerBackendOptions) {
    this.endpointUrl = options.endpointUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async dispatch(request: ParameterTrainerDispatchRequest): Promise<ParameterTrainerBackendResult> {
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
          message: `trainer endpoint returned HTTP ${response.status} ${response.statusText}`,
          details: asJsonObject({ response: body }),
        };
      }

      const parsed = trainerResponseSchema.safeParse(body);
      if (!parsed.success) {
        return { status: "accepted", trainingRunId: request.requestId, details: asJsonObject({ response: body }) };
      }
      return {
        status: parsed.data.status ?? "accepted",
        trainingRunId: parsed.data.trainingRunId ?? request.requestId,
        stagingManifestPath: parsed.data.stagingManifestPath ?? request.expectedOutput.stagingManifestPath,
        ...(parsed.data.message ? { message: parsed.data.message } : {}),
        ...(parsed.data.details ? { details: asJsonObject(parsed.data.details) } : {}),
      };
    } catch (err) {
      return {
        status: "rejected",
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function readParameterTrainerDatasetManifest(
  manifestPath: string,
): Promise<ParameterTrainerDatasetManifest> {
  return datasetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
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
