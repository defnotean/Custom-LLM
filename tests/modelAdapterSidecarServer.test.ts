import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildModelAdapterSidecarServer,
  ModelAdapterSidecarService,
  OllamaModelAdapterProvider,
  VllmModelAdapterProvider,
  type ModelAdapterSidecarFetch,
} from "../src/serving/ModelAdapterSidecarServer";

describe("ModelAdapterSidecarServer", () => {
  it("loads and rolls back vLLM LoRA adapters through the sidecar contract", async () => {
    const calls: HttpCall[] = [];
    const fetchImpl: ModelAdapterSidecarFetch = async (input, init) => {
      calls.push(toCall(input, init));
      return responseText("Success");
    };
    const provider = new VllmModelAdapterProvider({
      baseUrl: "http://127.0.0.1:8000",
      apiKey: "vllm-secret",
      timeoutMs: 5_000,
      fetchImpl,
    });
    const service = new ModelAdapterSidecarService({
      provider,
      adapterNamePrefix: "irene-",
      now: () => "2026-06-19T01:30:00.000Z",
    });
    const app = buildModelAdapterSidecarServer({ apiKey: "sidecar-secret", service });
    const module = moduleFixture("expert-1");

    const unauthorized = await app.inject({
      method: "POST",
      url: "/parameter-modules",
      payload: sidecarPayload("load", "load-1", [module]),
    });
    const loaded = await app.inject({
      method: "POST",
      url: "/parameter-modules",
      headers: { authorization: "Bearer sidecar-secret" },
      payload: sidecarPayload("load", "load-1", [module]),
    });
    const rolledBack = await app.inject({
      method: "POST",
      url: "/parameter-modules",
      headers: { authorization: "Bearer sidecar-secret" },
      payload: sidecarPayload("rollback", "rollback-1", [module]),
    });
    const status = await app.inject({
      method: "GET",
      url: "/parameter-modules/status",
      headers: { authorization: "Bearer sidecar-secret" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({ status: "accepted", loadedModuleIds: ["expert-1"] });
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.json()).toMatchObject({ status: "accepted", rolledBackModuleIds: ["expert-1"] });
    expect(status.json()).toMatchObject({
      provider: "vllm",
      loadedAdapters: [],
      history: [
        { type: "load", requestId: "load-1", moduleIds: ["expert-1"] },
        { type: "rollback", requestId: "rollback-1", moduleIds: ["expert-1"] },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      input: "http://127.0.0.1:8000/v1/load_lora_adapter",
      headers: { authorization: "Bearer vllm-secret", "content-type": "application/json" },
      body: {
        lora_name: "irene-expert-1",
        lora_path: dirname(module.artifacts[0]!.path),
        load_inplace: true,
      },
    });
    expect(calls[1]).toMatchObject({
      input: "http://127.0.0.1:8000/v1/unload_lora_adapter",
      body: { lora_name: "irene-expert-1" },
    });
    await app.close();
  });

  it("creates and unloads Ollama adapter models from module artifacts", async () => {
    const calls: HttpCall[] = [];
    const fetchImpl: ModelAdapterSidecarFetch = async (input, init) => {
      calls.push(toCall(input, init));
      return responseJson({ status: "success" });
    };
    const provider = new OllamaModelAdapterProvider({
      baseUrl: "http://127.0.0.1:11434",
      baseModel: "qwen2.5:7b-instruct",
      apiKey: "ollama-secret",
      timeoutMs: 5_000,
      fetchImpl,
    });
    const service = new ModelAdapterSidecarService({ provider });
    const module = moduleFixture("Social Expert");

    const loaded = await service.handle(sidecarPayload("load", "ollama-load", [module]));
    const rolledBack = await service.handle(sidecarPayload("rollback", "ollama-rollback", [module]));

    expect(loaded).toMatchObject({
      status: "accepted",
      loadedModuleIds: ["Social Expert"],
      details: { provider: "ollama" },
    });
    expect(rolledBack).toMatchObject({
      status: "accepted",
      rolledBackModuleIds: ["Social Expert"],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      input: "http://127.0.0.1:11434/api/create",
      headers: { authorization: "Bearer ollama-secret", "content-type": "application/json" },
      body: {
        model: "irene-social-expert",
        modelfile: `FROM qwen2.5:7b-instruct\nADAPTER ${dirname(module.artifacts[0]!.path)}\n`,
        stream: false,
      },
    });
    expect(calls[1]).toMatchObject({
      input: "http://127.0.0.1:11434/api/chat",
      body: { model: "irene-social-expert", messages: [], keep_alive: 0, stream: false },
    });
  });

  it("rolls back already-loaded vLLM adapters when a later load fails", async () => {
    const calls: HttpCall[] = [];
    const fetchImpl: ModelAdapterSidecarFetch = async (input, init) => {
      const call = toCall(input, init);
      calls.push(call);
      if (call.input.endsWith("/v1/load_lora_adapter") && call.body.lora_name === "second") {
        return responseJson({ error: "adapter rejected" }, { ok: false, status: 503, statusText: "Unavailable" });
      }
      return responseText("Success");
    };
    const provider = new VllmModelAdapterProvider({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
    });
    const service = new ModelAdapterSidecarService({ provider });
    const app = buildModelAdapterSidecarServer({ service });

    const result = await app.inject({
      method: "POST",
      url: "/parameter-modules",
      payload: sidecarPayload("load", "partial-load", [moduleFixture("first"), moduleFixture("second")]),
    });
    const status = await app.inject({ method: "GET", url: "/parameter-modules/status" });

    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({
      status: "rejected",
      loadedModuleIds: [],
      message: "model server returned HTTP 503 Unavailable",
    });
    expect(status.json()).toMatchObject({
      loadedAdapters: [],
      history: [{ type: "rejected", requestId: "partial-load", moduleIds: [] }],
    });
    expect(calls.map((call) => call.input)).toEqual([
      "http://127.0.0.1:8000/v1/load_lora_adapter",
      "http://127.0.0.1:8000/v1/load_lora_adapter",
      "http://127.0.0.1:8000/v1/unload_lora_adapter",
    ]);
    expect(calls[2]?.body).toMatchObject({ lora_name: "first" });
    await app.close();
  });
});

interface HttpCall {
  input: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function sidecarPayload(
  action: "load" | "rollback",
  requestId: string,
  modules: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    runtimeContract: "parameter-hotload-backend-v1",
    action,
    requestId,
    modules,
  };
}

function moduleFixture(moduleId: string): {
  moduleId: string;
  name: string;
  kind: string;
  artifacts: Array<{ kind: string; path: string; sha256: string }>;
} {
  return {
    moduleId,
    name: moduleId,
    kind: "expert",
    artifacts: [
      {
        kind: "adapter",
        path: join(process.cwd(), "training", "runs", moduleId, "adapter_model.safetensors"),
        sha256: "a".repeat(64),
      },
      {
        kind: "config",
        path: join(process.cwd(), "training", "runs", moduleId, "adapter_config.json"),
        sha256: "b".repeat(64),
      },
    ],
  };
}

function toCall(
  input: string,
  init: {
    method: "POST" | "DELETE";
    headers: Record<string, string>;
    body?: string;
  },
): HttpCall {
  return {
    input,
    method: init.method,
    headers: init.headers,
    body: JSON.parse(init.body ?? "{}") as Record<string, unknown>,
  };
}

function responseJson(
  body: unknown,
  options: { ok?: boolean; status?: number; statusText?: string } = {},
): ReturnType<ModelAdapterSidecarFetch> {
  return Promise.resolve({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    text: async () => JSON.stringify(body),
  });
}

function responseText(
  body: string,
  options: { ok?: boolean; status?: number; statusText?: string } = {},
): ReturnType<ModelAdapterSidecarFetch> {
  return Promise.resolve({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    text: async () => body,
  });
}
