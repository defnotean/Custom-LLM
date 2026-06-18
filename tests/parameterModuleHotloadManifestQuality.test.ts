import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkParameterModuleHotloadManifestQuality } from "../src/learning/ParameterModuleHotloadManifestQuality";

describe("ParameterModuleHotloadManifestQuality", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes a ready hotload manifest with hash-verified artifacts", async () => {
    const fixture = await writeFixture();

    const report = await checkParameterModuleHotloadManifestQuality(fixture.manifestPath);

    expect(report.status).toBe("pass");
    expect(report.summary).toMatchObject({
      manifestStatus: "ready",
      loadRequests: 1,
      skippedModules: 0,
      artifacts: 2,
    });
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("fails when artifact content changes after manifest creation", async () => {
    const fixture = await writeFixture();
    await writeFile(fixture.checkpointPath, "tampered", "utf8");

    const report = await checkParameterModuleHotloadManifestQuality(fixture.manifestPath);

    expect(report.status).toBe("fail");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "artifact-hash:expert-1:checkpoint", status: "fail" }),
    );
  });

  it("fails blocked manifests before loader consumption", async () => {
    const fixture = await writeFixture({ blocked: true });

    const report = await checkParameterModuleHotloadManifestQuality(fixture.manifestPath);

    expect(report.status).toBe("fail");
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "loader-ready-status", status: "fail" }));
  });

  async function writeFixture(options: { blocked?: boolean } = {}): Promise<{
    manifestPath: string;
    checkpointPath: string;
  }> {
    dir = await mkdtemp(join(tmpdir(), "parameter-hotload-quality-"));
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
    return { manifestPath, checkpointPath };
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
