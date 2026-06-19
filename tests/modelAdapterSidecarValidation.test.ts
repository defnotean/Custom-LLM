import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateModelAdapterSidecar,
  type ModelAdapterSidecarValidationFetch,
} from "../src/serving/ModelAdapterSidecarValidation";

describe("ModelAdapterSidecarValidation", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("dry-runs checked sidecar load and rollback payloads without HTTP calls", async () => {
    const fixture = await writeFixture();
    const calls: HttpCall[] = [];

    const report = await validateModelAdapterSidecar({
      manifestPath: fixture.manifestPath,
      endpointUrl: "http://127.0.0.1:9099/parameter-modules",
      requestId: "validation-1",
      now: () => "2026-06-19T03:00:00.000Z",
      fetchImpl: async (input, init) => {
        calls.push(toCall(input, init));
        return responseJson({});
      },
    });

    expect(report.status).toBe("ready");
    expect(report.dryRun).toBe(true);
    expect(report.endpointUrl).toBe("http://127.0.0.1:9099");
    expect(report.qualityReport.status).toBe("pass");
    expect(report.loadRequest).toMatchObject({
      runtimeContract: "parameter-hotload-backend-v1",
      action: "load",
      requestId: "validation-1",
      modules: [{ moduleId: "expert-1", name: "ping-tool-expert", rollbackTargetId: "active-before-expert" }],
    });
    expect(report.rollbackRequest).toMatchObject({
      runtimeContract: "parameter-hotload-backend-v1",
      action: "rollback",
      requestId: "validation-1:rollback",
      modules: [{ moduleId: "expert-1" }],
    });
    expect(calls).toEqual([]);
  });

  it("executes health, load, status, rollback, and final status calls against a sidecar", async () => {
    const fixture = await writeFixture();
    const calls: HttpCall[] = [];
    const fetchImpl: ModelAdapterSidecarValidationFetch = async (input, init) => {
      const call = toCall(input, init);
      calls.push(call);
      if (call.method === "GET" && call.input.endsWith("/health")) {
        return responseJson({ status: "ok", provider: "vllm" });
      }
      if (call.method === "GET" && call.input.endsWith("/parameter-modules/status")) {
        return responseJson({ provider: "vllm", loadedAdapters: [], history: [] });
      }
      if (call.body?.action === "load") {
        return responseJson({ status: "accepted", loadedModuleIds: ["expert-1"] });
      }
      if (call.body?.action === "rollback") {
        return responseJson({ status: "accepted", rolledBackModuleIds: ["expert-1"] });
      }
      return responseJson({ status: "rejected" }, { ok: false, status: 409, statusText: "Conflict" });
    };

    const report = await validateModelAdapterSidecar({
      manifestPath: fixture.manifestPath,
      endpointUrl: "http://127.0.0.1:9099",
      apiKey: "sidecar-secret",
      requestId: "validation-live",
      execute: true,
      fetchImpl,
    });

    expect(report.status).toBe("validated");
    expect(report.loadResult).toMatchObject({ ok: true, body: { status: "accepted", loadedModuleIds: ["expert-1"] } });
    expect(report.rollbackResult).toMatchObject({
      ok: true,
      body: { status: "accepted", rolledBackModuleIds: ["expert-1"] },
    });
    expect(calls.map((call) => `${call.method} ${call.input}`)).toEqual([
      "GET http://127.0.0.1:9099/health",
      "POST http://127.0.0.1:9099/parameter-modules",
      "GET http://127.0.0.1:9099/parameter-modules/status",
      "POST http://127.0.0.1:9099/parameter-modules",
      "GET http://127.0.0.1:9099/parameter-modules/status",
    ]);
    expect(calls[1]).toMatchObject({
      headers: { authorization: "Bearer sidecar-secret", "content-type": "application/json" },
      body: { action: "load", requestId: "validation-live" },
    });
    expect(calls[3]).toMatchObject({
      headers: { authorization: "Bearer sidecar-secret", "content-type": "application/json" },
      body: { action: "rollback", requestId: "validation-live:rollback" },
    });
  });

  it("blocks live sidecar validation when manifest artifact hashes fail", async () => {
    const fixture = await writeFixture();
    await writeFile(fixture.checkpointPath, "tampered", "utf8");
    const calls: HttpCall[] = [];

    const report = await validateModelAdapterSidecar({
      manifestPath: fixture.manifestPath,
      endpointUrl: "http://127.0.0.1:9099",
      requestId: "blocked-validation",
      execute: true,
      fetchImpl: async (input, init) => {
        calls.push(toCall(input, init));
        return responseJson({});
      },
    });

    expect(report.status).toBe("blocked");
    expect(report.qualityReport.status).toBe("fail");
    expect(report.loadRequest).toBeUndefined();
    expect(calls).toEqual([]);
  });

  async function writeFixture(): Promise<{
    manifestPath: string;
    checkpointPath: string;
  }> {
    dir = await mkdtemp(join(tmpdir(), "model-adapter-sidecar-validation-"));
    const checkpointPath = join(dir, "expert.safetensors");
    const configPath = join(dir, "config.json");
    const stagingManifestPath = join(dir, "staging-manifest.json");
    const manifestPath = join(dir, "hotload.json");
    await writeFile(checkpointPath, "checkpoint", "utf8");
    await writeFile(configPath, "{}", "utf8");
    await writeFile(stagingManifestPath, "{}", "utf8");
    const checkpointInfo = await fileInfo(checkpointPath);
    const configInfo = await fileInfo(configPath);
    const requests = [
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
    ];
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          id: "parameter-hotload-fixture",
          generatedAt: "2026-06-19T03:00:00.000Z",
          status: "ready",
          runtimeContract: "parameter-module-hotload-v1",
          summary: {
            activeModulesScanned: 1,
            loadRequests: requests.length,
            skippedModules: 0,
            totalLoadedParameters: requests.reduce((sum, request) => sum + request.parameters, 0),
            activeParametersPerRequest: requests.reduce((sum, request) => sum + request.activeParameters, 0),
          },
          requests,
          skipped: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { manifestPath, checkpointPath };
  }
});

interface HttpCall {
  input: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function toCall(
  input: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  },
): HttpCall {
  return {
    input,
    method: init.method,
    headers: init.headers,
    ...(init.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
  };
}

function responseJson(
  body: unknown,
  options: { ok?: boolean; status?: number; statusText?: string } = {},
): ReturnType<ModelAdapterSidecarValidationFetch> {
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
