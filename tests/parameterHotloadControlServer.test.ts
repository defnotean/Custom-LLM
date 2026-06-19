import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildParameterHotloadControlServer,
  HttpParameterHotloadBackend,
  InMemoryParameterHotloadControlService,
  type ParameterHotloadBackend,
  type ParameterHotloadBackendFetch,
  type ParameterHotloadBackendLoadInput,
  type ParameterHotloadBackendRollbackInput,
} from "../src/serving/ParameterHotloadControlServer";

describe("ParameterHotloadControlServer", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("loads checked hotload payloads and exposes current state", async () => {
    const fixture = await writeFixture();
    const app = buildParameterHotloadControlServer({
      service: new InMemoryParameterHotloadControlService({ now: () => "2026-06-18T23:00:00.000Z" }),
    });

    const applied = await app.inject({
      method: "POST",
      url: "/parameter-hotload",
      payload: applyPayload(fixture.manifest, { requestId: "apply-1" }),
    });
    const status = await app.inject({ method: "GET", url: "/parameter-hotload/status" });

    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      status: "accepted",
      loadedModuleIds: ["expert-1"],
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      loadedModules: [
        {
          moduleId: "expert-1",
          manifestId: "parameter-hotload-fixture",
          requestId: "apply-1",
          parameters: 2_000_000,
          activeParameters: 500_000,
        },
      ],
      history: [{ type: "load", requestId: "apply-1", moduleIds: ["expert-1"] }],
    });
    await app.close();
  });

  it("dry-runs without mutating loaded module state", async () => {
    const fixture = await writeFixture();
    const app = buildParameterHotloadControlServer();

    const applied = await app.inject({
      method: "POST",
      url: "/parameter-hotload",
      payload: applyPayload(fixture.manifest, { requestId: "dry-1", dryRun: true }),
    });
    const status = await app.inject({ method: "GET", url: "/parameter-hotload/status" });

    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      status: "accepted",
      loadedModuleIds: [],
      message: expect.stringContaining("dry run"),
    });
    expect(status.json()).toMatchObject({
      loadedModules: [],
      history: [{ type: "dry_run", requestId: "dry-1", moduleIds: ["expert-1"] }],
    });
    await app.close();
  });

  it("rejects tampered artifacts before mutating loader state", async () => {
    const fixture = await writeFixture();
    await writeFile(fixture.checkpointPath, "tampered", "utf8");
    const app = buildParameterHotloadControlServer();

    const applied = await app.inject({
      method: "POST",
      url: "/parameter-hotload",
      payload: applyPayload(fixture.manifest, { requestId: "bad-1" }),
    });
    const status = await app.inject({ method: "GET", url: "/parameter-hotload/status" });

    expect(applied.statusCode).toBe(409);
    expect(applied.json()).toMatchObject({
      status: "rejected",
      loadedModuleIds: [],
      details: {
        qualityReport: {
          status: "fail",
          checks: expect.arrayContaining([
            expect.objectContaining({ id: "artifact-hash:expert-1:checkpoint", status: "fail" }),
          ]),
        },
      },
    });
    expect(status.json()).toMatchObject({ loadedModules: [] });
    await app.close();
  });

  it("rolls back loaded modules by request id", async () => {
    const fixture = await writeFixture();
    const app = buildParameterHotloadControlServer();
    await app.inject({
      method: "POST",
      url: "/parameter-hotload",
      payload: applyPayload(fixture.manifest, { requestId: "apply-rollback" }),
    });

    const rollback = await app.inject({
      method: "POST",
      url: "/parameter-hotload/rollback",
      payload: { requestId: "apply-rollback" },
    });
    const status = await app.inject({ method: "GET", url: "/parameter-hotload/status" });

    expect(rollback.statusCode).toBe(200);
    expect(rollback.json()).toMatchObject({
      status: "accepted",
      rolledBackModuleIds: ["expert-1"],
      missingModuleIds: [],
    });
    expect(status.json()).toMatchObject({
      loadedModules: [],
      history: expect.arrayContaining([
        expect.objectContaining({ type: "rollback", moduleIds: ["expert-1"] }),
      ]),
    });
    await app.close();
  });

  it("does not mutate loaded state when the backend rejects a load", async () => {
    const fixture = await writeFixture();
    const backend: ParameterHotloadBackend = {
      name: "rejecting-backend",
      load: async () => ({ status: "rejected", message: "backend refused load" }),
      rollback: async () => ({ status: "accepted" }),
    };
    const app = buildParameterHotloadControlServer({
      service: new InMemoryParameterHotloadControlService({ backend }),
    });

    const applied = await app.inject({
      method: "POST",
      url: "/parameter-hotload",
      payload: applyPayload(fixture.manifest, { requestId: "reject-load" }),
    });
    const status = await app.inject({ method: "GET", url: "/parameter-hotload/status" });

    expect(applied.statusCode).toBe(409);
    expect(applied.json()).toMatchObject({
      status: "rejected",
      loadedModuleIds: [],
      message: "backend refused load",
      details: { backend: "rejecting-backend" },
    });
    expect(status.json()).toMatchObject({
      backend: "rejecting-backend",
      loadedModules: [],
      history: [{ type: "rejected", requestId: "reject-load" }],
    });
    await app.close();
  });

  it("delegates load and rollback to the configured backend before mutating state", async () => {
    const fixture = await writeFixture();
    const loadCalls: ParameterHotloadBackendLoadInput[] = [];
    const rollbackCalls: ParameterHotloadBackendRollbackInput[] = [];
    const backend: ParameterHotloadBackend = {
      name: "recording-backend",
      load: async (input) => {
        loadCalls.push(input);
        return { status: "accepted", loadedModuleIds: input.modules.map((item) => item.moduleId) };
      },
      rollback: async (input) => {
        rollbackCalls.push(input);
        return { status: "accepted", rolledBackModuleIds: input.modules.map((item) => item.moduleId) };
      },
    };
    const app = buildParameterHotloadControlServer({
      service: new InMemoryParameterHotloadControlService({ backend }),
    });

    await app.inject({
      method: "POST",
      url: "/parameter-hotload",
      payload: applyPayload(fixture.manifest, { requestId: "backend-1" }),
    });
    const rollback = await app.inject({
      method: "POST",
      url: "/parameter-hotload/rollback",
      payload: { requestId: "backend-1" },
    });

    expect(rollback.statusCode).toBe(200);
    expect(loadCalls).toHaveLength(1);
    expect(loadCalls[0]).toMatchObject({
      requestId: "backend-1",
      manifest: { id: "parameter-hotload-fixture" },
      modules: [{ moduleId: "expert-1" }],
    });
    expect(rollbackCalls).toHaveLength(1);
    expect(rollbackCalls[0]).toMatchObject({
      requestId: "backend-1",
      modules: [{ moduleId: "expert-1", requestId: "backend-1" }],
    });
    await app.close();
  });

  it("keeps modules loaded when the backend rejects rollback", async () => {
    const fixture = await writeFixture();
    const backend: ParameterHotloadBackend = {
      name: "rollback-rejecting-backend",
      load: async (input) => ({ status: "accepted", loadedModuleIds: input.modules.map((item) => item.moduleId) }),
      rollback: async () => ({ status: "rejected", message: "backend refused rollback" }),
    };
    const app = buildParameterHotloadControlServer({
      service: new InMemoryParameterHotloadControlService({ backend }),
    });
    await app.inject({
      method: "POST",
      url: "/parameter-hotload",
      payload: applyPayload(fixture.manifest, { requestId: "rollback-reject" }),
    });

    const rollback = await app.inject({
      method: "POST",
      url: "/parameter-hotload/rollback",
      payload: { requestId: "rollback-reject" },
    });
    const status = await app.inject({ method: "GET", url: "/parameter-hotload/status" });

    expect(rollback.statusCode).toBe(409);
    expect(rollback.json()).toMatchObject({
      status: "rejected",
      rolledBackModuleIds: [],
      message: "backend refused rollback",
    });
    expect(status.json()).toMatchObject({
      loadedModules: [{ moduleId: "expert-1" }],
      history: expect.arrayContaining([
        expect.objectContaining({ type: "rejected", requestId: "rollback-reject" }),
      ]),
    });
    await app.close();
  });

  it("posts load and rollback requests to an HTTP model-server backend", async () => {
    const fixture = await writeFixture();
    const manifest = fixture.manifest as ParameterHotloadBackendLoadInput["manifest"];
    const modules = manifest.requests;
    const calls: Array<{ input: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetchImpl: ParameterHotloadBackendFetch = async (input, init) => {
      calls.push({ input, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return responseJson({
        status: "accepted",
        loadedModuleIds: ["expert-1"],
        rolledBackModuleIds: ["expert-1"],
        message: "model server accepted adapter operation",
        details: { backend: "adapter-sidecar" },
      });
    };
    const backend = new HttpParameterHotloadBackend({
      endpointUrl: "http://127.0.0.1:9911/parameter-modules",
      apiKey: "model-secret",
      timeoutMs: 5_000,
      fetchImpl,
    });

    const loaded = await backend.load({ requestId: "http-load", manifest, modules });
    const rolledBack = await backend.rollback({
      requestId: "http-rollback",
      modules: [
        {
          moduleId: "expert-1",
          name: "ping-tool-expert",
          kind: "expert",
          rollbackTargetId: "active-before-expert",
          manifestId: "parameter-hotload-fixture",
          requestId: "http-load",
          loadedAt: "2026-06-18T23:00:00.000Z",
          parameters: 2_000_000,
          activeParameters: 500_000,
          trainableParameters: 2_000_000,
          artifacts: modules[0]?.artifacts ?? [],
        },
      ],
    });

    expect(loaded).toMatchObject({
      status: "accepted",
      loadedModuleIds: ["expert-1"],
      message: "model server accepted adapter operation",
      details: { backend: "adapter-sidecar" },
    });
    expect(rolledBack).toMatchObject({
      status: "accepted",
      rolledBackModuleIds: ["expert-1"],
      message: "model server accepted adapter operation",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      input: "http://127.0.0.1:9911/parameter-modules",
      headers: { authorization: "Bearer model-secret", "content-type": "application/json" },
      body: {
        runtimeContract: "parameter-hotload-backend-v1",
        action: "load",
        requestId: "http-load",
        modules: [{ moduleId: "expert-1" }],
      },
    });
    expect(calls[1]?.body).toMatchObject({
      runtimeContract: "parameter-hotload-backend-v1",
      action: "rollback",
      requestId: "http-rollback",
      modules: [{ moduleId: "expert-1" }],
    });
  });

  it("rejects HTTP model-server backend failures without defaulting loaded ids", async () => {
    const fixture = await writeFixture();
    const manifest = fixture.manifest as ParameterHotloadBackendLoadInput["manifest"];
    const backend = new HttpParameterHotloadBackend({
      endpointUrl: "http://127.0.0.1:9911/parameter-modules",
      fetchImpl: async () => responseJson({ error: "adapter not found" }, { ok: false, status: 503, statusText: "Unavailable" }),
    });

    const result = await backend.load({ requestId: "http-fail", manifest, modules: manifest.requests });

    expect(result).toMatchObject({
      status: "rejected",
      loadedModuleIds: [],
      message: "model-server backend returned HTTP 503 Unavailable",
      details: { response: { error: "adapter not found" } },
    });
  });

  it("protects hotload mutation routes with an optional bearer token", async () => {
    const fixture = await writeFixture();
    const app = buildParameterHotloadControlServer({ apiKey: "secret" });

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/parameter-hotload",
      payload: applyPayload(fixture.manifest),
    });
    const authenticated = await app.inject({
      method: "POST",
      url: "/parameter-hotload",
      headers: { authorization: "Bearer secret" },
      payload: applyPayload(fixture.manifest),
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toEqual({ error: "unauthorized" });
    expect(authenticated.statusCode).toBe(200);
    await app.close();
  });

  async function writeFixture(): Promise<{
    checkpointPath: string;
    manifest: unknown;
  }> {
    dir = await mkdtemp(join(tmpdir(), "parameter-hotload-control-"));
    const checkpointPath = join(dir, "expert.safetensors");
    const configPath = join(dir, "config.json");
    const stagingManifestPath = join(dir, "staging-manifest.json");
    await writeFile(checkpointPath, "checkpoint", "utf8");
    await writeFile(configPath, "{}", "utf8");
    await writeFile(stagingManifestPath, "{}", "utf8");
    const checkpointInfo = await fileInfo(checkpointPath);
    const configInfo = await fileInfo(configPath);
    return {
      checkpointPath,
      manifest: {
        id: "parameter-hotload-fixture",
        generatedAt: "2026-06-18T22:00:00.000Z",
        status: "ready",
        runtimeContract: "parameter-module-hotload-v1",
        summary: {
          activeModulesScanned: 1,
          loadRequests: 1,
          skippedModules: 0,
          totalLoadedParameters: 2_000_000,
          activeParametersPerRequest: 500_000,
        },
        requests: [
          {
            action: "load",
            moduleId: "expert-1",
            name: "ping-tool-expert",
            kind: "expert",
            parameters: 2_000_000,
            activeParameters: 500_000,
            trainableParameters: 2_000_000,
            route: "ping",
            rollbackTargetId: "active-before-expert",
            stagingManifestPath,
            artifacts: [
              { kind: "checkpoint", path: checkpointPath, ...checkpointInfo },
              { kind: "config", path: configPath, ...configInfo },
            ],
            datasetHashes: [hashText("dataset")],
            sourceLearningItemIds: ["skill-1"],
            evalReports: [
              { kind: "skill", path: "reports/skill.json", status: "pass" },
              { kind: "protocol", path: "reports/protocol.json", status: "pass" },
              { kind: "composite", path: "reports/staging.json", status: "pass" },
            ],
          },
        ],
        skipped: [],
      },
    };
  }
});

function applyPayload(manifest: unknown, options: { requestId?: string; dryRun?: boolean } = {}): Record<string, unknown> {
  return {
    runtimeContract: "parameter-module-hotload-apply-v1",
    requestId: options.requestId ?? "apply-1",
    dryRun: options.dryRun ?? false,
    manifest,
  };
}

function responseJson(
  body: unknown,
  options: { ok?: boolean; status?: number; statusText?: string } = {},
): ReturnType<ParameterHotloadBackendFetch> {
  return Promise.resolve({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    text: async () => JSON.stringify(body),
  });
}

async function fileInfo(path: string): Promise<{ bytes: number; sha256: string }> {
  const body = await readFile(path);
  return {
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
