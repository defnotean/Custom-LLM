import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ParameterModuleHotloadService,
  type ParameterModuleHotloadLoaderRequest,
} from "../src/learning/ParameterModuleHotloadService";

describe("ParameterModuleHotloadService", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("validates a hotload manifest and returns a dry-run payload without calling a loader", async () => {
    const fixture = await writeFixture();

    const report = await new ParameterModuleHotloadService().apply({
      manifestPath: fixture.manifestPath,
      dryRun: true,
      requestId: "dry-run-1",
    });

    expect(report.status).toBe("dry_run");
    expect(report.requestId).toBe("dry-run-1");
    expect(report.loaderRequest).toMatchObject({
      runtimeContract: "parameter-module-hotload-apply-v1",
      dryRun: true,
      manifest: { id: "parameter-hotload-fixture", status: "ready" },
    });
    expect(report.loaderResult).toBeUndefined();
  });

  it("posts a checked manifest to the configured loader", async () => {
    const fixture = await writeFixture();
    const calls: ParameterModuleHotloadLoaderRequest[] = [];
    const service = new ParameterModuleHotloadService({
      apply: async (request) => {
        calls.push(request);
        return { status: "accepted", loadedModuleIds: request.manifest.requests.map((item) => item.moduleId) };
      },
    });

    const report = await service.apply({ manifestPath: fixture.manifestPath, requestId: "apply-1" });

    expect(report.status).toBe("applied");
    expect(report.loaderResult).toEqual({ status: "accepted", loadedModuleIds: ["expert-1"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      requestId: "apply-1",
      dryRun: false,
      manifest: { status: "ready", requests: [{ moduleId: "expert-1" }] },
    });
  });

  it("blocks loader calls when the hotload quality gate fails", async () => {
    const fixture = await writeFixture({ blocked: true });
    const calls: ParameterModuleHotloadLoaderRequest[] = [];
    const service = new ParameterModuleHotloadService({
      apply: async (request) => {
        calls.push(request);
        return { status: "accepted", loadedModuleIds: [] };
      },
    });

    const report = await service.apply({ manifestPath: fixture.manifestPath, requestId: "blocked-1" });

    expect(report.status).toBe("blocked");
    expect(report.qualityReport.checks).toContainEqual(
      expect.objectContaining({ id: "loader-ready-status", status: "fail" }),
    );
    expect(report.loaderRequest).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("requires a loader for non-dry-run ready manifests", async () => {
    const fixture = await writeFixture();

    await expect(new ParameterModuleHotloadService().apply({ manifestPath: fixture.manifestPath })).rejects.toThrow(
      /loader is not configured/,
    );
  });

  async function writeFixture(options: { blocked?: boolean } = {}): Promise<{
    manifestPath: string;
  }> {
    dir = await mkdtemp(join(tmpdir(), "parameter-hotload-service-"));
    const checkpointPath = join(dir, "expert.safetensors");
    const configPath = join(dir, "config.json");
    const stagingManifestPath = join(dir, "staging-manifest.json");
    const manifestPath = join(dir, "hotload.json");
    await writeFile(checkpointPath, "checkpoint", "utf8");
    await writeFile(configPath, "{}", "utf8");
    await writeFile(stagingManifestPath, "{}", "utf8");
    const checkpointInfo = await fileInfo(checkpointPath);
    const configInfo = await fileInfo(configPath);
    const requests = options.blocked
      ? []
      : [
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
          generatedAt: "2026-06-18T22:00:00.000Z",
          status: options.blocked ? "blocked" : "ready",
          runtimeContract: "parameter-module-hotload-v1",
          summary: {
            activeModulesScanned: 1,
            loadRequests: requests.length,
            skippedModules: options.blocked ? 1 : 0,
            totalLoadedParameters: requests.reduce((sum, request) => sum + request.parameters, 0),
            activeParametersPerRequest: requests.reduce((sum, request) => sum + request.activeParameters, 0),
          },
          requests,
          skipped: options.blocked
            ? [{ moduleId: "expert-1", name: "ping-tool-expert", kind: "expert", reasons: ["missing staging artifacts"] }]
            : [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { manifestPath };
  }
});

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
