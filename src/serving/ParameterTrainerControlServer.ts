import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export interface CommandParameterTrainerBackendOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  requireStagingManifest?: boolean;
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

export class CommandParameterTrainerBackend implements ParameterTrainerControlBackend {
  readonly name = "command";
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly requireStagingManifest: boolean;

  constructor(options: CommandParameterTrainerBackendOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env ?? {};
    this.timeoutMs = options.timeoutMs ?? 3_600_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 65_536;
    this.requireStagingManifest = options.requireStagingManifest ?? true;
  }

  async dispatch(input: ParameterTrainerBackendDispatchInput): Promise<ParameterTrainerBackendResult> {
    const request = input.request;
    await mkdir(request.expectedOutput.runDir, { recursive: true });
    const requestPath = join(request.expectedOutput.runDir, "trainer-dispatch-request.json");
    const qualityReportPath = join(request.expectedOutput.runDir, "trainer-quality-report.json");
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    await writeFile(qualityReportPath, `${JSON.stringify(input.qualityReport, null, 2)}\n`, "utf8");

    const context = {
      requestId: request.requestId,
      trainerProfile: request.trainerProfile,
      datasetManifestPath: request.datasetManifestPath,
      runDir: request.expectedOutput.runDir,
      stagingManifestPath: request.expectedOutput.stagingManifestPath,
      requestPath,
      qualityReportPath,
    };
    const args = this.args.map((arg) => templateArg(arg, context));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.env,
      PARAMETER_TRAINER_REQUEST_ID: request.requestId,
      PARAMETER_TRAINER_PROFILE: request.trainerProfile,
      PARAMETER_TRAINER_DATASET_MANIFEST_PATH: request.datasetManifestPath,
      PARAMETER_TRAINER_RUN_DIR: request.expectedOutput.runDir,
      PARAMETER_TRAINER_STAGING_MANIFEST_PATH: request.expectedOutput.stagingManifestPath,
      PARAMETER_TRAINER_REQUEST_PATH: requestPath,
      PARAMETER_TRAINER_QUALITY_REPORT_PATH: qualityReportPath,
    };
    const result = await runCommand({
      command: this.command,
      args,
      cwd: this.cwd,
      env,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });

    const details = {
      command: this.command,
      args,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      requestPath,
      qualityReportPath,
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    };

    if (result.timedOut) {
      return { status: "rejected", message: `trainer command timed out after ${this.timeoutMs}ms`, details: asJsonObject(details) };
    }
    if (result.error) {
      return { status: "rejected", message: result.error, details: asJsonObject(details) };
    }
    if (result.exitCode !== 0) {
      return { status: "rejected", message: `trainer command exited with code ${result.exitCode}`, details: asJsonObject(details) };
    }
    if (this.requireStagingManifest) {
      try {
        await access(request.expectedOutput.stagingManifestPath);
      } catch {
        return {
          status: "rejected",
          message: "trainer command did not write expected staging manifest",
          details: asJsonObject({ ...details, stagingManifestPath: request.expectedOutput.stagingManifestPath }),
        };
      }
    }

    return {
      status: "accepted",
      trainingRunId: request.requestId,
      stagingManifestPath: request.expectedOutput.stagingManifestPath,
      message: "trainer command completed and staging manifest is present",
      details: asJsonObject(details),
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

interface CommandTemplateContext {
  requestId: string;
  trainerProfile: string;
  datasetManifestPath: string;
  runDir: string;
  stagingManifestPath: string;
  requestPath: string;
  qualityReportPath: string;
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function templateArg(arg: string, context: CommandTemplateContext): string {
  return arg
    .replaceAll("{requestId}", context.requestId)
    .replaceAll("{trainerProfile}", context.trainerProfile)
    .replaceAll("{datasetManifestPath}", context.datasetManifestPath)
    .replaceAll("{runDir}", context.runDir)
    .replaceAll("{stagingManifestPath}", context.stagingManifestPath)
    .replaceAll("{requestPath}", context.requestPath)
    .replaceAll("{qualityReportPath}", context.qualityReportPath);
}

function runCommand(options: {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(options.command, options.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"), options.maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"), options.maxOutputBytes);
    });
    child.on("error", (err) => {
      settle({ exitCode: null, signal: null, timedOut, stdout, stderr, error: err.message });
    });
    child.on("close", (exitCode, signal) => {
      settle({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

function appendLimited(existing: string, next: string, maxBytes: number): string {
  const combined = `${existing}${next}`;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return combined.slice(Math.max(0, combined.length - maxBytes));
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
