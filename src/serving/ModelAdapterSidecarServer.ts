import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { JsonObject } from "../types/common";
import { toJsonValue } from "../types/common";

export type ModelAdapterSidecarAction = "load" | "rollback";
export type ModelAdapterProviderKind = "vllm" | "ollama";

export type ModelAdapterSidecarFetch = (
  input: string,
  init: {
    method: "POST" | "DELETE";
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

export interface ModelAdapterSidecarArtifact {
  kind: string;
  path: string;
  sha256?: string;
  bytes?: number;
}

export interface ModelAdapterSidecarModule {
  moduleId: string;
  name?: string;
  kind?: string;
  route?: string;
  baseModuleId?: string;
  rollbackTargetId?: string;
  stagingManifestPath?: string;
  artifacts?: ModelAdapterSidecarArtifact[];
}

export interface ModelAdapterSidecarRequest {
  runtimeContract: "parameter-hotload-backend-v1";
  action: ModelAdapterSidecarAction;
  requestId: string;
  manifest?: unknown;
  modules: ModelAdapterSidecarModule[];
}

export interface ModelAdapterSidecarProviderLoadInput {
  requestId: string;
  module: ModelAdapterSidecarModule;
  adapterName: string;
  adapterPath: string;
}

export interface ModelAdapterSidecarProviderRollbackInput {
  requestId: string;
  module: ModelAdapterSidecarModule;
  adapterName: string;
  providerModuleId?: string;
}

export interface ModelAdapterSidecarProviderResult {
  status: "accepted" | "rejected";
  providerModuleId?: string;
  message?: string;
  details?: JsonObject;
}

export interface ModelAdapterSidecarProvider {
  name: string;
  load(input: ModelAdapterSidecarProviderLoadInput): Promise<ModelAdapterSidecarProviderResult>;
  rollback(input: ModelAdapterSidecarProviderRollbackInput): Promise<ModelAdapterSidecarProviderResult>;
}

export interface ModelAdapterSidecarLoadedAdapter {
  moduleId: string;
  adapterName: string;
  providerModuleId?: string;
  requestId: string;
  provider: string;
  loadedAt: string;
  adapterPath: string;
}

export interface ModelAdapterSidecarEvent {
  id: string;
  type: "load" | "rollback" | "rejected";
  requestId: string;
  moduleIds: string[];
  createdAt: string;
  message?: string;
}

export interface ModelAdapterSidecarSnapshot {
  generatedAt: string;
  provider: string;
  loadedAdapters: ModelAdapterSidecarLoadedAdapter[];
  history: ModelAdapterSidecarEvent[];
}

export interface ModelAdapterSidecarServiceOptions {
  provider: ModelAdapterSidecarProvider;
  now?: () => string;
  maxHistory?: number;
  adapterNamePrefix?: string;
}

export interface VllmModelAdapterProviderOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: ModelAdapterSidecarFetch;
  loadInPlace?: boolean;
}

export interface OllamaModelAdapterProviderOptions {
  baseUrl: string;
  baseModel: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: ModelAdapterSidecarFetch;
  modelNamePrefix?: string;
  deleteOnRollback?: boolean;
}

export interface ModelAdapterSidecarServerOptions {
  apiKey?: string;
  service: ModelAdapterSidecarService;
}

const artifactSchema = z.object({
  kind: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
});

const moduleSchema = z
  .object({
    moduleId: z.string().min(1),
    name: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    route: z.string().min(1).optional(),
    baseModuleId: z.string().min(1).optional(),
    rollbackTargetId: z.string().min(1).optional(),
    stagingManifestPath: z.string().min(1).optional(),
    artifacts: z.array(artifactSchema).optional(),
  })
  .passthrough();

const sidecarRequestSchema = z
  .object({
    runtimeContract: z.literal("parameter-hotload-backend-v1"),
    action: z.enum(["load", "rollback"]),
    requestId: z.string().min(1),
    manifest: z.unknown().optional(),
    modules: z.array(moduleSchema).min(1).max(200),
  })
  .strict();

export class ModelAdapterSidecarService {
  private readonly loadedAdapters = new Map<string, ModelAdapterSidecarLoadedAdapter>();
  private readonly history: ModelAdapterSidecarEvent[] = [];
  private readonly provider: ModelAdapterSidecarProvider;
  private readonly now: () => string;
  private readonly maxHistory: number;
  private readonly adapterNamePrefix: string;

  constructor(options: ModelAdapterSidecarServiceOptions) {
    this.provider = options.provider;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxHistory = options.maxHistory ?? 200;
    this.adapterNamePrefix = options.adapterNamePrefix ?? "";
  }

  async handle(value: unknown): Promise<{
    status: "accepted" | "rejected";
    loadedModuleIds?: string[];
    rolledBackModuleIds?: string[];
    message?: string;
    details?: JsonObject;
  }> {
    const parsed = sidecarRequestSchema.safeParse(value);
    if (!parsed.success) {
      return this.rejected("invalid model-adapter sidecar request", "invalid-request", [], {
        issues: parsed.error.flatten(),
      });
    }
    return parsed.data.action === "load" ? this.load(parsed.data) : this.rollback(parsed.data);
  }

  snapshot(): ModelAdapterSidecarSnapshot {
    return {
      generatedAt: this.now(),
      provider: this.provider.name,
      loadedAdapters: [...this.loadedAdapters.values()].sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
      history: [...this.history],
    };
  }

  private async load(request: ModelAdapterSidecarRequest): Promise<{
    status: "accepted" | "rejected";
    loadedModuleIds: string[];
    message?: string;
    details?: JsonObject;
  }> {
    const loaded: ModelAdapterSidecarLoadedAdapter[] = [];
    const perModule: JsonObject[] = [];
    for (const module of request.modules) {
      const adapterName = this.adapterName(module);
      const adapterPath = adapterPathForModule(module);
      if (!adapterPath) {
        await this.rollbackLoaded(request.requestId, loaded);
        return this.rejected("module has no adapter/checkpoint artifact path for model-server loading", request.requestId, [], {
          moduleId: module.moduleId,
          provider: this.provider.name,
        });
      }
      const result = await this.provider.load({ requestId: request.requestId, module, adapterName, adapterPath });
      perModule.push(asJsonObject({ moduleId: module.moduleId, adapterName, adapterPath, result }));
      if (result.status !== "accepted") {
        await this.rollbackLoaded(request.requestId, loaded);
        return this.rejected(result.message ?? "model adapter provider rejected load", request.requestId, [], {
          provider: this.provider.name,
          moduleId: module.moduleId,
          adapterName,
          perModule,
          ...(result.details ? { providerDetails: result.details } : {}),
        });
      }

      const record: ModelAdapterSidecarLoadedAdapter = {
        moduleId: module.moduleId,
        adapterName,
        ...(result.providerModuleId ? { providerModuleId: result.providerModuleId } : {}),
        requestId: request.requestId,
        provider: this.provider.name,
        loadedAt: this.now(),
        adapterPath,
      };
      this.loadedAdapters.set(module.moduleId, record);
      loaded.push(record);
    }

    const loadedModuleIds = loaded.map((module) => module.moduleId);
    this.pushEvent({ type: "load", requestId: request.requestId, moduleIds: loadedModuleIds });
    return {
      status: "accepted",
      loadedModuleIds,
      message: `loaded ${loadedModuleIds.length} adapter module(s) through ${this.provider.name}`,
      details: asJsonObject({ provider: this.provider.name, perModule }),
    };
  }

  private async rollback(request: ModelAdapterSidecarRequest): Promise<{
    status: "accepted" | "rejected";
    rolledBackModuleIds: string[];
    message?: string;
    details?: JsonObject;
  }> {
    const rolledBackModuleIds: string[] = [];
    const failed: JsonObject[] = [];
    const perModule: JsonObject[] = [];
    for (const module of request.modules) {
      const existing = this.loadedAdapters.get(module.moduleId);
      const adapterName = existing?.adapterName ?? this.adapterName(module);
      const result = await this.provider.rollback({
        requestId: request.requestId,
        module,
        adapterName,
        ...(existing?.providerModuleId ? { providerModuleId: existing.providerModuleId } : {}),
      });
      perModule.push(asJsonObject({ moduleId: module.moduleId, adapterName, result }));
      if (result.status === "accepted") {
        rolledBackModuleIds.push(module.moduleId);
        this.loadedAdapters.delete(module.moduleId);
      } else {
        failed.push(asJsonObject({ moduleId: module.moduleId, adapterName, message: result.message }));
      }
    }

    if (rolledBackModuleIds.length === 0 && failed.length > 0) {
      return this.rejected("model adapter provider rejected rollback", request.requestId, [], {
        provider: this.provider.name,
        failed,
        perModule,
      });
    }

    this.pushEvent({
      type: "rollback",
      requestId: request.requestId,
      moduleIds: rolledBackModuleIds,
      ...(failed.length > 0 ? { message: `${failed.length} rollback(s) failed` } : {}),
    });
    return {
      status: "accepted",
      rolledBackModuleIds,
      ...(failed.length > 0 ? { message: `${failed.length} rollback(s) failed` } : {}),
      details: asJsonObject({ provider: this.provider.name, failed, perModule }),
    };
  }

  private async rollbackLoaded(requestId: string, loaded: ModelAdapterSidecarLoadedAdapter[]): Promise<void> {
    for (const module of loaded.reverse()) {
      await this.provider.rollback({
        requestId,
        module: { moduleId: module.moduleId },
        adapterName: module.adapterName,
        ...(module.providerModuleId ? { providerModuleId: module.providerModuleId } : {}),
      });
      this.loadedAdapters.delete(module.moduleId);
    }
  }

  private rejected(
    message: string,
    requestId: string,
    moduleIds: string[],
    details: unknown,
  ): { status: "rejected"; loadedModuleIds: []; rolledBackModuleIds: []; message: string; details: JsonObject } {
    this.pushEvent({ type: "rejected", requestId, moduleIds, message });
    return { status: "rejected", loadedModuleIds: [], rolledBackModuleIds: [], message, details: asJsonObject(details) };
  }

  private adapterName(module: ModelAdapterSidecarModule): string {
    return `${this.adapterNamePrefix}${sanitizeAdapterName(module.moduleId)}`;
  }

  private pushEvent(input: Omit<ModelAdapterSidecarEvent, "id" | "createdAt">): void {
    const event: ModelAdapterSidecarEvent = {
      id: `model-adapter-event-${this.history.length + 1}`,
      createdAt: this.now(),
      ...input,
    };
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
  }
}

export class VllmModelAdapterProvider implements ModelAdapterSidecarProvider {
  readonly name = "vllm";
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: ModelAdapterSidecarFetch;
  private readonly loadInPlace: boolean;

  constructor(options: VllmModelAdapterProviderOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.loadInPlace = options.loadInPlace ?? true;
  }

  async load(input: ModelAdapterSidecarProviderLoadInput): Promise<ModelAdapterSidecarProviderResult> {
    const response = await this.post("/v1/load_lora_adapter", {
      lora_name: input.adapterName,
      lora_path: input.adapterPath,
      load_inplace: this.loadInPlace,
    });
    return response.ok
      ? {
          status: "accepted",
          providerModuleId: input.adapterName,
          message: `vLLM accepted LoRA adapter ${input.adapterName}`,
          details: asJsonObject({ response: response.body }),
        }
      : {
          status: "rejected",
          message: response.message,
          details: asJsonObject({ response: response.body }),
        };
  }

  async rollback(input: ModelAdapterSidecarProviderRollbackInput): Promise<ModelAdapterSidecarProviderResult> {
    const response = await this.post("/v1/unload_lora_adapter", { lora_name: input.providerModuleId ?? input.adapterName });
    return response.ok
      ? {
          status: "accepted",
          providerModuleId: input.providerModuleId ?? input.adapterName,
          message: `vLLM unloaded LoRA adapter ${input.providerModuleId ?? input.adapterName}`,
          details: asJsonObject({ response: response.body }),
        }
      : {
          status: "rejected",
          message: response.message,
          details: asJsonObject({ response: response.body }),
        };
  }

  private async post(path: string, body: Record<string, unknown>): Promise<ProviderHttpResult> {
    return postJson({
      url: `${this.baseUrl}${path}`,
      body,
      apiKey: this.apiKey,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }
}

export class OllamaModelAdapterProvider implements ModelAdapterSidecarProvider {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly baseModel: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: ModelAdapterSidecarFetch;
  private readonly modelNamePrefix: string;
  private readonly deleteOnRollback: boolean;

  constructor(options: OllamaModelAdapterProviderOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.baseModel = options.baseModel;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.modelNamePrefix = options.modelNamePrefix ?? "irene-";
    this.deleteOnRollback = options.deleteOnRollback ?? false;
  }

  async load(input: ModelAdapterSidecarProviderLoadInput): Promise<ModelAdapterSidecarProviderResult> {
    const model = `${this.modelNamePrefix}${sanitizeOllamaModelName(input.module.moduleId)}`;
    const response = await this.post("/api/create", {
      model,
      modelfile: `FROM ${this.baseModel}\nADAPTER ${input.adapterPath}\n`,
      stream: false,
    });
    return response.ok
      ? {
          status: "accepted",
          providerModuleId: model,
          message: `Ollama created adapter model ${model}`,
          details: asJsonObject({ response: response.body }),
        }
      : {
          status: "rejected",
          message: response.message,
          details: asJsonObject({ response: response.body }),
        };
  }

  async rollback(input: ModelAdapterSidecarProviderRollbackInput): Promise<ModelAdapterSidecarProviderResult> {
    const model = input.providerModuleId ?? `${this.modelNamePrefix}${sanitizeOllamaModelName(input.module.moduleId)}`;
    const unload = await this.post("/api/chat", { model, messages: [], keep_alive: 0, stream: false });
    if (!unload.ok) {
      return { status: "rejected", message: unload.message, details: asJsonObject({ response: unload.body }) };
    }

    if (this.deleteOnRollback) {
      const deleted = await this.post("/api/delete", { model });
      if (!deleted.ok) {
        return { status: "rejected", message: deleted.message, details: asJsonObject({ unload: unload.body, delete: deleted.body }) };
      }
      return {
        status: "accepted",
        providerModuleId: model,
        message: `Ollama unloaded and deleted adapter model ${model}`,
        details: asJsonObject({ unload: unload.body, delete: deleted.body }),
      };
    }

    return {
      status: "accepted",
      providerModuleId: model,
      message: `Ollama unloaded adapter model ${model}`,
      details: asJsonObject({ response: unload.body }),
    };
  }

  private async post(path: string, body: Record<string, unknown>): Promise<ProviderHttpResult> {
    return postJson({
      url: `${this.baseUrl}${path}`,
      body,
      apiKey: this.apiKey,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }
}

export function buildModelAdapterSidecarServer(options: ModelAdapterSidecarServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("preHandler", async (request, reply) => {
    if (!options.apiKey) return;
    if (request.url === "/health") return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${options.apiKey}`) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok", provider: options.service.snapshot().provider }));

  app.post("/parameter-modules", async (request, reply) => {
    const result = await options.service.handle(request.body);
    return reply.status(result.status === "accepted" ? 200 : 409).send(result);
  });

  app.get("/parameter-modules/status", async () => options.service.snapshot());

  app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(500).send({ error: "internal error", message: error.message });
  });

  return app;
}

interface ProviderHttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: unknown;
  message?: string;
}

async function postJson(options: {
  url: string;
  body: Record<string, unknown>;
  apiKey?: string;
  timeoutMs: number;
  fetchImpl: ModelAdapterSidecarFetch;
}): Promise<ProviderHttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    const response = await options.fetchImpl(options.url, {
      method: "POST",
      headers,
      body: `${JSON.stringify(options.body)}\n`,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const body = parseJsonBody(bodyText);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body,
      ...(response.ok ? {} : { message: `model server returned HTTP ${response.status} ${response.statusText}` }),
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

function adapterPathForModule(module: ModelAdapterSidecarModule): string | undefined {
  const artifacts = module.artifacts ?? [];
  const artifact =
    artifacts.find((item) => item.kind === "adapter") ??
    artifacts.find((item) => item.kind === "checkpoint") ??
    artifacts.find((item) => item.kind === "config");
  if (!artifact) return undefined;
  const resolvedPath = resolveArtifactPath(artifact.path, module.stagingManifestPath);
  if (artifact.kind === "config") return dirname(resolvedPath);
  return dirname(resolvedPath);
}

function resolveArtifactPath(path: string, stagingManifestPath?: string): string {
  if (isAbsolute(path)) return path;
  if (stagingManifestPath) return join(dirname(stagingManifestPath), path);
  return path;
}

function sanitizeAdapterName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "adapter";
}

function sanitizeOllamaModelName(value: string): string {
  const name = sanitizeAdapterName(value).toLowerCase();
  return basename(name) || "adapter";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function parseJsonBody(body: string): unknown {
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
