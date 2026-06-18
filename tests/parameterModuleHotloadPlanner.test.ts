import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildParameterModuleHotloadManifest,
  ParameterModuleHotloadPlanner,
} from "../src/learning/ParameterModuleHotloadPlanner";
import type { ParameterModule } from "../src/learning/LiveLearningRegistry";

describe("ParameterModuleHotloadPlanner", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds a ready hotload manifest for active promoted modules with artifacts", () => {
    const manifest = buildParameterModuleHotloadManifest([
      parameterModule({ kind: "base_model", status: "active" }),
      parameterModule({
        id: "expert-1",
        name: "ping-tool-expert",
        kind: "expert",
        status: "active",
        route: "ping",
      }),
    ], { now: () => "2026-06-18T22:00:00.000Z" });

    expect(manifest.status).toBe("ready");
    expect(manifest.summary).toMatchObject({
      activeModulesScanned: 1,
      loadRequests: 1,
      skippedModules: 0,
      totalLoadedParameters: 2_000_000,
    });
    expect(manifest.requests[0]).toMatchObject({
      action: "load",
      moduleId: "expert-1",
      kind: "expert",
      route: "ping",
      rollbackTargetId: "active-before-module",
      artifacts: expect.arrayContaining([
        expect.objectContaining({ kind: "checkpoint", sha256: hashText("checkpoint") }),
      ]),
    });
  });

  it("blocks when an active non-base module lacks hotload evidence", () => {
    const manifest = buildParameterModuleHotloadManifest([
      parameterModule({
        id: "manual-active",
        status: "active",
        rollbackTargetId: undefined,
        metadata: {},
      }),
      parameterModule({ id: "staged-module", status: "staged" }),
    ], { now: () => "2026-06-18T22:00:00.000Z" });

    expect(manifest.status).toBe("blocked");
    expect(manifest.summary).toMatchObject({ activeModulesScanned: 1, loadRequests: 0, skippedModules: 1 });
    expect(manifest.skipped[0]).toMatchObject({
      moduleId: "manual-active",
      reasons: expect.arrayContaining(["missing rollback target", "missing staging metadata", "missing staging artifacts"]),
    });
  });

  it("writes timestamped and latest hotload manifests", async () => {
    dir = await mkdtemp(join(tmpdir(), "parameter-hotload-"));
    const planner = new ParameterModuleHotloadPlanner(
      {
        listParameterModules: async () => [
          parameterModule({ kind: "base_model", status: "active" }),
          parameterModule({ id: "expert-1", kind: "expert", status: "active" }),
        ],
      },
      { now: () => "2026-06-18T22:00:00.000Z" },
    );

    const written = await planner.writeManifest(dir);
    const saved = JSON.parse(await readFile(written.path, "utf8")) as { status: string; requests: unknown[] };
    const latest = JSON.parse(await readFile(written.latestPath, "utf8")) as { id: string };

    expect(saved.status).toBe("ready");
    expect(saved.requests).toHaveLength(1);
    expect(latest.id).toBe(written.manifest.id);
  });
});

function parameterModule(overrides: Partial<ParameterModule> = {}): ParameterModule {
  return {
    id: "module-1",
    name: "module",
    kind: "expert",
    parameters: 2_000_000,
    activeParameters: 500_000,
    trainableParameters: 2_000_000,
    status: "active",
    datasetHashes: [hashText("dataset")],
    evalReports: [
      { kind: "skill", path: "reports/skill.json", status: "pass" },
      { kind: "protocol", path: "reports/protocol.json", status: "pass" },
      { kind: "composite", path: "reports/staging.json", status: "pass" },
    ],
    sourceLearningItemIds: ["skill-1"],
    rollbackTargetId: "active-before-module",
    createdAt: "2026-06-18T21:00:00.000Z",
    metadata: {
      staging: {
        manifestPath: "training/runs/parameter-modules/run-1/staging-manifest.json",
        trainedAt: "2026-06-18T20:00:00.000Z",
        trainer: "fixture-trainer",
        artifacts: [
          {
            kind: "checkpoint",
            path: "training/runs/parameter-modules/run-1/expert.safetensors",
            sha256: hashText("checkpoint"),
            bytes: 10,
          },
          {
            kind: "config",
            path: "training/runs/parameter-modules/run-1/config.json",
            sha256: hashText("config"),
            bytes: 2,
          },
        ],
        gateReport: { status: "pass" },
      },
    },
    ...overrides,
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
