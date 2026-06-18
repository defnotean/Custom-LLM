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

  constructor(options: ParameterHotloadControlServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxHistory = options.maxHistory ?? 200;
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

    const loadedAt = this.now();
    const loadedModuleIds: string[] = [];
    for (const hotloadRequest of manifest.requests) {
      loadedModuleIds.push(hotloadRequest.moduleId);
      this.loadedModules.set(hotloadRequest.moduleId, loadedModuleRecord(hotloadRequest, manifest, request.requestId, loadedAt));
    }
    this.pushEvent({ type: "load", requestId: request.requestId, manifestId: manifest.id, moduleIds: loadedModuleIds });
    return {
      status: "accepted",
      loadedModuleIds,
      message: `loaded ${loadedModuleIds.length} parameter module(s) into control state`,
      details: asJsonObject({ qualityReport }),
    };
  }

  rollback(input: ParameterHotloadRollbackInput = {}): ParameterHotloadRollbackResult {
    const requestedIds = this.resolveRollbackModuleIds(input);
    if (requestedIds.length === 0) {
      return { status: "rejected", rolledBackModuleIds: [], missingModuleIds: [], message: "no loaded modules matched rollback request" };
    }

    const rolledBackModuleIds: string[] = [];
    const missingModuleIds: string[] = [];
    for (const moduleId of requestedIds) {
      if (this.loadedModules.delete(moduleId)) rolledBackModuleIds.push(moduleId);
      else missingModuleIds.push(moduleId);
    }
    this.pushEvent({
      type: "rollback",
      requestId: input.requestId ?? "manual-rollback",
      moduleIds: rolledBackModuleIds,
      message: missingModuleIds.length > 0 ? `missing modules: ${missingModuleIds.join(", ")}` : undefined,
    });
    return {
      status: rolledBackModuleIds.length > 0 ? "accepted" : "rejected",
      rolledBackModuleIds,
      missingModuleIds,
      ...(rolledBackModuleIds.length === 0 ? { message: "no requested modules were loaded" } : {}),
    };
  }

  snapshot(): ParameterHotloadStateSnapshot {
    return {
      generatedAt: this.now(),
      loadedModules: [...this.loadedModules.values()].sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
      history: [...this.history],
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
    const result = service.rollback(parsed.data);
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
