import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  checkParameterModuleHotloadManifestPayloadQuality,
  parseParameterModuleHotloadManifest,
  type ParameterModuleHotloadQualityReport,
} from "../learning/ParameterModuleHotloadManifestQuality";
import type {
  ParameterModuleHotloadLoaderRequest,
  ParameterModuleHotloadLoaderResult,
} from "../learning/ParameterModuleHotloadService";
import type { ParameterModuleHotloadManifest, ParameterModuleHotloadRequest } from "../learning/ParameterModuleHotloadPlanner";
import type { JsonObject } from "../types/common";
import { toJsonValue } from "../types/common";

export interface ParameterHotloadLoadedModule {
  moduleId: string;
  name: string;
  kind: ParameterModuleHotloadRequest["kind"];
  route?: string;
  baseModuleId?: string;
  rollbackTargetId: string;
  manifestId: string;
  requestId: string;
  loadedAt: string;
  parameters: number;
  activeParameters: number;
  trainableParameters: number;
  artifacts: ParameterModuleHotloadRequest["artifacts"];
}

export interface ParameterHotloadBackendLoadInput {
  requestId: string;
  manifest: ParameterModuleHotloadManifest;
  modules: ParameterModuleHotloadRequest[];
}

export interface ParameterHotloadBackendLoadResult {
  status: "accepted" | "rejected";
  loadedModuleIds?: string[];
  message?: string;
  details?: JsonObject;
}

export interface ParameterHotloadBackendRollbackInput {
  requestId: string;
  modules: ParameterHotloadLoadedModule[];
}

export interface ParameterHotloadBackendRollbackResult {
  status: "accepted" | "rejected";
  rolledBackModuleIds?: string[];
  message?: string;
  details?: JsonObject;
}

export interface ParameterHotloadBackend {
  name: string;
  load(input: ParameterHotloadBackendLoadInput): Promise<ParameterHotloadBackendLoadResult>;
  rollback(input: ParameterHotloadBackendRollbackInput): Promise<ParameterHotloadBackendRollbackResult>;
}

export interface ParameterHotloadEvent {
  id: string;
  type: "load" | "dry_run" | "empty" | "rejected" | "rollback";
  requestId: string;
  manifestId?: string;
  moduleIds: string[];
  createdAt: string;
  message?: string;
}

export interface ParameterHotloadStateSnapshot {
  generatedAt: string;
  backend: string;
  loadedModules: ParameterHotloadLoadedModule[];
  history: ParameterHotloadEvent[];
}

export interface ParameterHotloadRollbackInput {
  moduleIds?: string[];
  requestId?: string;
}

export interface ParameterHotloadRollbackResult {
  status: "accepted" | "rejected";
  rolledBackModuleIds: string[];
  missingModuleIds: string[];
  message?: string;
}

export interface ParameterHotloadControlServiceOptions {
  now?: () => string;
  maxHistory?: number;
  backend?: ParameterHotloadBackend;
}

const applyRequestSchema = z
  .object({
    runtimeContract: z.literal("parameter-module-hotload-apply-v1"),
    requestId: z.string().min(1),
    dryRun: z.boolean(),
    manifest: z.unknown(),
  })
  .strict();

const rollbackBodySchema = z
  .object({
    moduleIds: z.array(z.string().min(1)).min(1).max(200).optional(),
    requestId: z.string().min(1).optional(),
  })
  .strict();

export class InMemoryParameterHotloadControlService {
  private readonly loadedModules = new Map<string, ParameterHotloadLoadedModule>();
  private readonly history: ParameterHotloadEvent[] = [];
  private readonly now: () => string;
  private readonly maxHistory: number;
  private readonly backend: ParameterHotloadBackend;

  constructor(options: ParameterHotloadControlServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxHistory = options.maxHistory ?? 200;
    this.backend = options.backend ?? new StateOnlyParameterHotloadBackend();
  }

  async apply(value: unknown): Promise<ParameterModuleHotloadLoaderResult> {
    const parsed = applyRequestSchema.safeParse(value);
    if (!parsed.success) {
      return this.rejected("invalid hotload apply request", { issues: parsed.error.flatten() });
    }

    const qualityReport = await this.safeQualityReport(parsed.data.manifest);
    if (qualityReport.status !== "pass") {
      this.pushEvent({
        type: "rejected",
        requestId: parsed.data.requestId,
        manifestId: this.tryManifestId(parsed.data.manifest),
        moduleIds: [],
        message: "hotload quality gate failed",
      });
      return {
        status: "rejected",
        loadedModuleIds: [],
        message: "hotload quality gate failed",
        details: asJsonObject({ qualityReport }),
      };
    }

    const request = parsed.data as ParameterModuleHotloadLoaderRequest;
    const manifest = parseParameterModuleHotloadManifest(request.manifest);
    if (manifest.status === "empty" || manifest.requests.length === 0) {
      this.pushEvent({ type: "empty", requestId: request.requestId, manifestId: manifest.id, moduleIds: [] });
      return { status: "accepted", loadedModuleIds: [], message: "hotload manifest is empty" };
    }

    if (request.dryRun) {
      this.pushEvent({
        type: "dry_run",
        requestId: request.requestId,
        manifestId: manifest.id,
        moduleIds: manifest.requests.map((item) => item.moduleId),
      });
      return {
        status: "accepted",
        loadedModuleIds: [],
        message: "dry run accepted; no modules loaded",
        details: asJsonObject({ qualityReport }),
      };
    }

    const backendResult = await this.backend.load({
      requestId: request.requestId,
      manifest,
      modules: manifest.requests,
    });
    if (backendResult.status !== "accepted") {
      this.pushEvent({
        type: "rejected",
        requestId: request.requestId,
        manifestId: manifest.id,
        moduleIds: [],
        message: backendResult.message ?? "hotload backend rejected load request",
      });
      return {
        status: "rejected",
        loadedModuleIds: [],
        message: backendResult.message ?? "hotload backend rejected load request",
        details: asJsonObject({
          backend: this.backend.name,
          qualityReport,
          ...(backendResult.details ? { backendDetails: backendResult.details } : {}),
        }),
      };
    }

    const loadedAt = this.now();
    const backendLoadedIds = backendResult.loadedModuleIds?.length
      ? new Set(backendResult.loadedModuleIds)
      : new Set(manifest.requests.map((item) => item.moduleId));
    const loadedModuleIds: string[] = [];
    for (const hotloadRequest of manifest.requests) {
      if (!backendLoadedIds.has(hotloadRequest.moduleId)) continue;
      loadedModuleIds.push(hotloadRequest.moduleId);
      this.loadedModules.set(hotloadRequest.moduleId, loadedModuleRecord(hotloadRequest, manifest, request.requestId, loadedAt));
    }
    this.pushEvent({ type: "load", requestId: request.requestId, manifestId: manifest.id, moduleIds: loadedModuleIds });
    return {
      status: "accepted",
      loadedModuleIds,
      message: backendResult.message ?? `loaded ${loadedModuleIds.length} parameter module(s) through ${this.backend.name}`,
      details: asJsonObject({
        backend: this.backend.name,
        qualityReport,
        ...(backendResult.details ? { backendDetails: backendResult.details } : {}),
      }),
    };
  }

  async rollback(input: ParameterHotloadRollbackInput = {}): Promise<ParameterHotloadRollbackResult> {
    const requestedIds = this.resolveRollbackModuleIds(input);
    if (requestedIds.length === 0) {
      return { status: "rejected", rolledBackModuleIds: [], missingModuleIds: [], message: "no loaded modules matched rollback request" };
    }

    const existingModules = requestedIds
      .map((moduleId) => this.loadedModules.get(moduleId))
      .filter((module): module is ParameterHotloadLoadedModule => Boolean(module));
    const missingModuleIds = requestedIds.filter((moduleId) => !this.loadedModules.has(moduleId));
    if (existingModules.length === 0) {
      return { status: "rejected", rolledBackModuleIds: [], missingModuleIds, message: "no requested modules were loaded" };
    }

    const rollbackRequestId = input.requestId ?? "manual-rollback";
    const backendResult = this.backend.rollback({
      requestId: rollbackRequestId,
      modules: existingModules,
    });
    return this.finishRollback(rollbackRequestId, requestedIds, existingModules, missingModuleIds, backendResult);
  }

  snapshot(): ParameterHotloadStateSnapshot {
    return {
      generatedAt: this.now(),
      backend: this.backend.name,
      loadedModules: [...this.loadedModules.values()].sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
      history: [...this.history],
    };
  }

  private async finishRollback(
    requestId: string,
    requestedIds: string[],
    existingModules: ParameterHotloadLoadedModule[],
    missingModuleIds: string[],
    backendResultPromise: Promise<ParameterHotloadBackendRollbackResult>,
  ): Promise<ParameterHotloadRollbackResult> {
    const backendResult = await backendResultPromise;
    if (backendResult.status !== "accepted") {
      this.pushEvent({
        type: "rejected",
        requestId,
        moduleIds: existingModules.map((module) => module.moduleId),
        message: backendResult.message ?? "hotload backend rejected rollback request",
      });
      return {
        status: "rejected",
        rolledBackModuleIds: [],
        missingModuleIds,
        message: backendResult.message ?? "hotload backend rejected rollback request",
      };
    }

    const backendRolledBackIds = backendResult.rolledBackModuleIds?.length
      ? new Set(backendResult.rolledBackModuleIds)
      : new Set(existingModules.map((module) => module.moduleId));
    const rolledBackModuleIds: string[] = [];
    for (const moduleId of requestedIds) {
      if (!backendRolledBackIds.has(moduleId)) continue;
      if (this.loadedModules.delete(moduleId)) rolledBackModuleIds.push(moduleId);
    }
    this.pushEvent({
      type: "rollback",
      requestId,
      moduleIds: rolledBackModuleIds,
      message: missingModuleIds.length > 0 ? `missing modules: ${missingModuleIds.join(", ")}` : undefined,
    });
    return {
      status: rolledBackModuleIds.length > 0 ? "accepted" : "rejected",
      rolledBackModuleIds,
      missingModuleIds,
      ...(rolledBackModuleIds.length === 0
        ? { message: backendResult.message ?? "no requested modules were rolled back" }
        : backendResult.message
          ? { message: backendResult.message }
          : {}),
    };
  }

  private async safeQualityReport(manifest: unknown): Promise<ParameterModuleHotloadQualityReport> {
    try {
      return await checkParameterModuleHotloadManifestPayloadQuality(manifest, { now: this.now });
    } catch (err) {
      return {
        status: "fail",
        manifestPath: "(payload)",
        generatedAt: this.now(),
        summary: {
          manifestStatus: "invalid",
          loadRequests: 0,
          skippedModules: 0,
          artifacts: 0,
          totalLoadedParameters: 0,
          activeParametersPerRequest: 0,
        },
        checks: [
          {
            id: "manifest-schema",
            status: "fail",
            summary: "Hotload manifest payload does not match the expected schema",
            details: { error: err instanceof Error ? err.message : String(err) },
          },
        ],
      };
    }
  }

  private rejected(message: string, details: unknown): ParameterModuleHotloadLoaderResult {
    this.pushEvent({ type: "rejected", requestId: "invalid-request", moduleIds: [], message });
    return { status: "rejected", loadedModuleIds: [], message, details: asJsonObject(details) };
  }

  private resolveRollbackModuleIds(input: ParameterHotloadRollbackInput): string[] {
    if (input.moduleIds?.length) return unique(input.moduleIds);
    if (input.requestId) {
      const event = [...this.history]
        .reverse()
        .find((item) => item.type === "load" && item.requestId === input.requestId);
      return event ? unique(event.moduleIds) : [];
    }
    return [...this.loadedModules.keys()];
  }

  private tryManifestId(value: unknown): string | undefined {
    try {
      return parseParameterModuleHotloadManifest(value).id;
    } catch {
      return undefined;
    }
  }

  private pushEvent(input: Omit<ParameterHotloadEvent, "id" | "createdAt">): void {
    const event: ParameterHotloadEvent = {
      id: `hotload-event-${this.history.length + 1}`,
      createdAt: this.now(),
      ...input,
    };
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
  }
}

export class StateOnlyParameterHotloadBackend implements ParameterHotloadBackend {
  readonly name = "state-only";

  async load(input: ParameterHotloadBackendLoadInput): Promise<ParameterHotloadBackendLoadResult> {
    return {
      status: "accepted",
      loadedModuleIds: input.modules.map((module) => module.moduleId),
      message: "state-only backend accepted module load",
    };
  }

  async rollback(input: ParameterHotloadBackendRollbackInput): Promise<ParameterHotloadBackendRollbackResult> {
    return {
      status: "accepted",
      rolledBackModuleIds: input.modules.map((module) => module.moduleId),
      message: "state-only backend accepted rollback",
    };
  }
}

export interface ParameterHotloadControlServerOptions {
  apiKey?: string;
  service?: InMemoryParameterHotloadControlService;
}

export function buildParameterHotloadControlServer(
  options: ParameterHotloadControlServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const service = options.service ?? new InMemoryParameterHotloadControlService();

  app.addHook("preHandler", async (request, reply) => {
    if (!options.apiKey) return;
    if (request.url === "/health") return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${options.apiKey}`) {
      await reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/parameter-hotload", async (request, reply) => {
    const result = await service.apply(request.body);
    return reply.status(result.status === "accepted" ? 200 : 409).send(result);
  });

  app.get("/parameter-hotload/status", async () => service.snapshot());

  app.post("/parameter-hotload/rollback", async (request, reply) => {
    const parsed = rollbackBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid rollback payload", details: parsed.error.flatten() });
    }
    const result = await service.rollback(parsed.data);
    return reply.status(result.status === "accepted" ? 200 : 409).send(result);
  });

  app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(500).send({ error: "internal error", message: error.message });
  });

  return app;
}

function loadedModuleRecord(
  request: ParameterModuleHotloadRequest,
  manifest: ParameterModuleHotloadManifest,
  requestId: string,
  loadedAt: string,
): ParameterHotloadLoadedModule {
  return {
    moduleId: request.moduleId,
    name: request.name,
    kind: request.kind,
    ...(request.route ? { route: request.route } : {}),
    ...(request.baseModuleId ? { baseModuleId: request.baseModuleId } : {}),
    rollbackTargetId: request.rollbackTargetId,
    manifestId: manifest.id,
    requestId,
    loadedAt,
    parameters: request.parameters,
    activeParameters: request.activeParameters,
    trainableParameters: request.trainableParameters,
    artifacts: request.artifacts,
  };
}

function asJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (json && typeof json === "object" && !Array.isArray(json)) return json as JsonObject;
  return { value: json };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
