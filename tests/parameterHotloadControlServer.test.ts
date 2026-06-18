import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildParameterHotloadControlServer,
  InMemoryParameterHotloadControlService,
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
    expect(rollback.json()).toEqual({
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
