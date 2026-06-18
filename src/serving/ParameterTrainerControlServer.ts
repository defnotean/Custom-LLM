import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  checkParameterGrowthDatasetQuality,
  type ParameterGrowthDatasetQualityReport,
} from "../training/parameter/ParameterGrowthDatasetQuality";
import {
  parameterTrainerDispatchRequestSchema,
  readParameterTrainerDatasetManifest,
  type ParameterTrainerBackendResult,
  type ParameterTrainerDatasetManifest,
  type ParameterTrainerDispatchRequest,
} from "../training/parameter/ParameterTrainerDispatchService";
import type { JsonObject } from "../types/common";
import { toJsonValue } from "../types/common";

export type ParameterTrainerJobStatus = "accepted" | "dry_run" | "rejected";
export type ParameterTrainerEventType = "accepted" | "dry_run" | "rejected";

export interface ParameterTrainerJob {
  requestId: string;
  status: ParameterTrainerJobStatus;
  dryRun: boolean;
  trainerProfile: string;
  datasetManifestId: string;
  planId: string;
  datasetManifestPath: string;
  runDir: string;
  stagingManifestPath: string;
  receivedAt: string;
  backend: string;
  trainingRunId?: string;
  message?: string;
}

export interface ParameterTrainerBackendDispatchInput {
  request: ParameterTrainerDispatchRequest;
  qualityReport: ParameterGrowthDatasetQualityReport;
}

export interface ParameterTrainerControlBackend {
  name: string;
  dispatch(input: ParameterTrainerBackendDispatchInput): Promise<ParameterTrainerBackendResult>;
}

export interface ParameterTrainerControlEvent {
  id: string;
  type: ParameterTrainerEventType;
  requestId: string;
  createdAt: string;
  datasetManifestId?: string;
  planId?: string;
  trainingRunId?: string;
  message?: string;
}

export interface ParameterTrainerControlStateSnapshot {
  generatedAt: string;
  backend: string;
  jobs: ParameterTrainerJob[];
  history: ParameterTrainerControlEvent[];
}

export interface ParameterTrainerControlServiceOptions {
  now?: () => string;
  maxHistory?: number;
  backend?: ParameterTrainerControlBackend;
}

export class InMemoryParameterTrainerControlService {
  private readonly jobs = new Map<string, ParameterTrainerJob>();
  private readonly history: ParameterTrainerControlEvent[] = [];
  private readonly now: () => string;
  private readonly maxHistory: number;
  private readonly backend: ParameterTrainerControlBackend;

  constructor(options: ParameterTrainerControlServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxHistory = options.maxHistory ?? 200;
    this.backend = options.backend ?? new StateOnlyParameterTrainerBackend();
  }

  async dispatch(value: unknown): Promise<ParameterTrainerBackendResult> {
    const parsed = parameterTrainerDispatchRequestSchema.safeParse(value);
    if (!parsed.success) {
      return this.reject("invalid parameter training dispatch request", "invalid-request", {
        issues: parsed.error.flatten(),
      });
    }

    const request = parsed.data;
    const qualityReport = await this.safeQualityReport(request.datasetManifestPath);
    if (qualityReport.status !== "pass") {
      return this.reject("parameter training dataset quality gate failed", request.requestId, {
        qualityReport,
      }, request);
    }

    const manifestMatch = await this.datasetManifestMatchesDisk(request.datasetManifestPath, request.datasetManifest);
    if (!manifestMatch.ok) {
      return this.reject("parameter training dispatch manifest does not match manifest path", request.requestId, {
        reason: manifestMatch.reason,
        qualityReport,
      }, request);
    }

    if (request.dryRun) {
      const result: ParameterTrainerBackendResult = {
        status: "accepted",
        trainingRunId: request.requestId,
        stagingManifestPath: request.expectedOutput.stagingManifestPath,
        message: "dry run accepted; no trainer backend called",
        details: asJsonObject({ backend: this.backend.name, qualityReport }),
      };
      this.recordJob("dry_run", request, result);
      this.pushEvent({ type: "dry_run", request, result });
      return result;
    }

    const backendResult = await this.backend.dispatch({ request, qualityReport });
    const result: ParameterTrainerBackendResult =
      backendResult.status === "accepted"
        ? {
            ...backendResult,
            trainingRunId: backendResult.trainingRunId ?? request.requestId,
            stagingManifestPath: backendResult.stagingManifestPath ?? request.expectedOutput.stagingManifestPath,
            details: asJsonObject({
              backend: this.backend.name,
              qualityReport,
              ...(backendResult.details ? { backendDetails: backendResult.details } : {}),
            }),
          }
        : {
            ...backendResult,
            details: asJsonObject({
              backend: this.backend.name,
              qualityReport,
              ...(backendResult.details ? { backendDetails: backendResult.details } : {}),
            }),
          };
    this.recordJob(result.status === "accepted" ? "accepted" : "rejected", request, result);
    this.pushEvent({ type: result.status === "accepted" ? "accepted" : "rejected", request, result });
    return result;
  }

  snapshot(): ParameterTrainerControlStateSnapshot {
    return {
      generatedAt: this.now(),
      backend: this.backend.name,
      jobs: [...this.jobs.values()].sort((a, b) => a.requestId.localeCompare(b.requestId)),
      history: [...this.history],
    };
  }

  private async safeQualityReport(manifestPath: string): Promise<ParameterGrowthDatasetQualityReport> {
    try {
      return await checkParameterGrowthDatasetQuality(manifestPath);
    } catch (err) {
      return {
        status: "fail",
        manifestPath,
        generatedAt: this.now(),
        summary: { files: 0, records: 0, batches: 0, gateStatus: "invalid" },
        checks: [
          {
            id: "dataset-quality-exception",
            status: "fail",
            summary: "Parameter training dataset quality check could not run",
            details: { error: err instanceof Error ? err.message : String(err) },
          },
        ],
      };
    }
  }

  private async datasetManifestMatchesDisk(
    manifestPath: string,
    embeddedManifest: ParameterTrainerDatasetManifest,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const diskManifest = await readParameterTrainerDatasetManifest(manifestPath);
      if (stableJson(diskManifest) === stableJson(embeddedManifest)) return { ok: true };
      return { ok: false, reason: "embedded dataset manifest differs from the manifest file on disk" };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private reject(
    message: string,
    requestId: string,
    details: unknown,
    request?: ParameterTrainerDispatchRequest,
  ): ParameterTrainerBackendResult {
    const result: ParameterTrainerBackendResult = {
      status: "rejected",
      message,
      details: asJsonObject(details),
    };
    if (request) this.recordJob("rejected", request, result);
    this.pushEvent({ type: "rejected", requestId, request, result, message });
    return result;
  }

  private recordJob(
    status: ParameterTrainerJobStatus,
    request: ParameterTrainerDispatchRequest,
    result: ParameterTrainerBackendResult,
  ): void {
    this.jobs.set(request.requestId, {
      requestId: request.requestId,
      status,
      dryRun: request.dryRun,
      trainerProfile: request.trainerProfile,
      datasetManifestId: request.datasetManifest.id,
      planId: request.datasetManifest.planId,
      datasetManifestPath: request.datasetManifestPath,
      runDir: request.expectedOutput.runDir,
      stagingManifestPath: result.stagingManifestPath ?? request.expectedOutput.stagingManifestPath,
      receivedAt: this.now(),
      backend: this.backend.name,
      ...(result.trainingRunId ? { trainingRunId: result.trainingRunId } : {}),
      ...(result.message ? { message: result.message } : {}),
    });
  }

  private pushEvent(input: {
    type: ParameterTrainerEventType;
    requestId?: string;
    request?: ParameterTrainerDispatchRequest;
    result?: ParameterTrainerBackendResult;
    message?: string;
  }): void {
    const event: ParameterTrainerControlEvent = {
      id: `trainer-event-${this.history.length + 1}`,
      type: input.type,
      requestId: input.request?.requestId ?? input.requestId ?? "invalid-request",
      createdAt: this.now(),
      ...(input.request ? { datasetManifestId: input.request.datasetManifest.id, planId: input.request.datasetManifest.planId } : {}),
      ...(input.result?.trainingRunId ? { trainingRunId: input.result.trainingRunId } : {}),
      ...(input.message ?? input.result?.message ? { message: input.message ?? input.result?.message } : {}),
    };
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
  }
}

export class StateOnlyParameterTrainerBackend implements ParameterTrainerControlBackend {
  readonly name = "state-only";

  async dispatch(input: ParameterTrainerBackendDispatchInput): Promise<ParameterTrainerBackendResult> {
    return {
      status: "accepted",
      trainingRunId: input.request.requestId,
      stagingManifestPath: input.request.expectedOutput.stagingManifestPath,
      message: "state-only backend accepted trainer dispatch; no weights were trained",
    };
  }
}

export interface ParameterTrainerControlServerOptions {
  apiKey?: string;
  service?: InMemoryParameterTrainerControlService;
}

export function buildParameterTrainerControlServer(
  options: ParameterTrainerControlServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const service = options.service ?? new InMemoryParameterTrainerControlService();

  app.addHook("preHandler", async (request, reply) => {
    if (!options.apiKey) return;
    if (request.url === "/health") return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${options.apiKey}`) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/parameter-training/dispatch", async (request, reply) => {
    const result = await service.dispatch(request.body);
    return reply.status(result.status === "accepted" ? 200 : 409).send(result);
  });

  app.get("/parameter-training/status", async () => service.snapshot());

  app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(500).send({ error: "internal error", message: error.message });
  });

  return app;
}

function asJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (json && typeof json === "object" && !Array.isArray(json)) return json as JsonObject;
  return { value: json };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
