import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ParameterModuleStagingService } from "../src/learning/ParameterModuleStagingService";
import type { ParameterModule } from "../src/learning/LiveLearningRegistry";
import { checkParameterModuleStagingManifest } from "../src/training/parameter/ParameterModuleStagingGate";

describe("ParameterModuleStagingGate", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes a complete expert staging manifest", async () => {
    const fixture = await writeFixture();

    const report = await checkParameterModuleStagingManifest(fixture.stagingManifestPath);

    expect(report.status).toBe("pass");
    expect(report.summary).toMatchObject({
      moduleName: "ping_tool_expert",
      kind: "expert",
      route: "ping",
      sourceLearningItems: 2,
    });
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("creates a staged parameter module from a passing manifest", async () => {
    const fixture = await writeFixture();
    const createdInputs: unknown[] = [];
    const service = new ParameterModuleStagingService({
      createParameterModule: async (input) => {
        createdInputs.push(input);
        return parameterModule({ id: input.id ?? "module-created", ...input });
      },
    });

    const result = await service.stageFromManifest({
      id: "module-from-manifest",
      manifestPath: fixture.stagingManifestPath,
      metadata: { operator: "admin-1" },
    });

    expect(result.gateReport.status).toBe("pass");
    expect(result.module).toMatchObject({
      id: "module-from-manifest",
      name: "ping_tool_expert",
      kind: "expert",
      status: "staged",
      route: "ping",
      rollbackTargetId: "active-module-before-ping-expert",
    });
    expect(createdInputs).toEqual([
      expect.objectContaining({
        id: "module-from-manifest",
        name: "ping_tool_expert",
        kind: "expert",
        datasetHashes: expect.any(Array),
        sourceLearningItemIds: ["skill-1", "skill-2"],
        evalReports: expect.arrayContaining([
          expect.objectContaining({ kind: "skill", status: "pass" }),
          expect.objectContaining({ kind: "composite", status: "pass" }),
        ]),
        metadata: expect.objectContaining({
          operator: "admin-1",
          staging: expect.objectContaining({
            manifestPath: fixture.stagingManifestPath,
            trainer: "fixture-trainer",
            gateReport: expect.objectContaining({ status: "pass" }),
          }),
        }),
      }),
    ]);
  });

  it("fails when rollback target is missing", async () => {
    const fixture = await writeFixture({ omitRollbackTarget: true });

    const report = await checkParameterModuleStagingManifest(fixture.stagingManifestPath);

    expect(report.status).toBe("fail");
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "rollback-target", status: "fail" }));
  });

  it("fails when a required eval report is missing", async () => {
    const fixture = await writeFixture({ omitEvalKind: "skill" });

    const report = await checkParameterModuleStagingManifest(fixture.stagingManifestPath);

    expect(report.status).toBe("fail");
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "required-eval:skill", status: "fail" }));
  });

  it("fails when an artifact hash changes after staging manifest creation", async () => {
    const fixture = await writeFixture();
    await writeFile(fixture.checkpointPath, "tampered checkpoint", "utf8");

    const report = await checkParameterModuleStagingManifest(fixture.stagingManifestPath);

    expect(report.status).toBe("fail");
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "artifact-hash:checkpoint", status: "fail" }));
  });

  async function writeFixture(options: { omitRollbackTarget?: boolean; omitEvalKind?: string } = {}): Promise<{
    stagingManifestPath: string;
    checkpointPath: string;
  }> {
    dir = await mkdtemp(join(tmpdir(), "parameter-module-staging-"));
    const datasetPath = join(dir, "batch-1.jsonl");
    const datasetRecords = [
      datasetRecord("record-1", "skill-1", "Use ping for quick health checks."),
      datasetRecord("record-2", "skill-2", "Use ping before deeper diagnostics."),
    ];
    await writeFile(datasetPath, `${datasetRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    const datasetInfo = await fileInfo(datasetPath);

    const datasetManifestPath = join(dir, "dataset-manifest.json");
    await writeFile(
      datasetManifestPath,
      `${JSON.stringify(
        {
          id: "parameter-growth-dataset-fixture",
          planId: "parameter-growth-plan-fixture",
          generatedAt: "2026-06-18T20:05:00.000Z",
          gate: { status: "pass" },
          files: [{ batchId: "batch-1", path: datasetPath, lines: 2, ...datasetInfo }],
          batches: [
            {
              batchId: "batch-1",
              targetKind: "expert",
              route: "ping",
              records: 2,
              moduleName: "ping_tool_expert",
              datasetId: "dataset-ping-expert",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const datasetManifestInfo = await fileInfo(datasetManifestPath);

    const checkpointPath = join(dir, "expert.safetensors");
    const configPath = join(dir, "expert-config.json");
    await writeFile(checkpointPath, "checkpoint bytes", "utf8");
    await writeFile(configPath, JSON.stringify({ architecture: "expert-fixture" }), "utf8");
    const checkpointInfo = await fileInfo(checkpointPath);
    const configInfo = await fileInfo(configPath);

    const evalReports = [];
    for (const kind of ["dataset_quality", "parameter_growth", "training_report", "contamination", "skill", "protocol"]) {
      if (kind === options.omitEvalKind) continue;
      const path = join(dir, `${kind}.report.json`);
      await writeFile(path, `${JSON.stringify({ status: "pass", kind })}\n`, "utf8");
      evalReports.push({ kind, path, status: "pass", ...(await fileInfo(path)) });
    }

    const stagingManifestPath = join(dir, "staging-manifest.json");
    await writeFile(
      stagingManifestPath,
      `${JSON.stringify(
        {
          moduleName: "ping_tool_expert",
          kind: "expert",
          parameters: 2_000_000,
          activeParameters: 500_000,
          trainableParameters: 2_000_000,
          route: "ping",
          datasetManifestPath,
          datasetManifestSha256: datasetManifestInfo.sha256,
          sourceLearningItemIds: ["skill-1", "skill-2"],
          datasetHashes: [datasetManifestInfo.sha256, datasetInfo.sha256],
          artifacts: [
            { kind: "checkpoint", path: checkpointPath, ...checkpointInfo },
            { kind: "config", path: configPath, ...configInfo },
          ],
          evalReports,
          ...(options.omitRollbackTarget ? {} : { rollbackTargetId: "active-module-before-ping-expert" }),
          trainedAt: "2026-06-18T20:20:00.000Z",
          trainer: "fixture-trainer",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { stagingManifestPath, checkpointPath };
  }
});

function datasetRecord(id: string, itemId: string, content: string): unknown {
  return {
    id,
    batchId: "batch-1",
    itemId,
    target: {
      kind: "expert",
      route: "ping",
      moduleName: "ping_tool_expert",
      datasetId: "dataset-ping-expert",
    },
    messages: [
      { role: "system", content: "You are Irene." },
      { role: "user", content },
      { role: "assistant", content: "Use the ping tool only when the tool gate permits it." },
    ],
    source: {
      kind: "skill",
      source: "tool_success",
      confidence: 0.95,
      content,
      metadata: { toolName: "ping" },
    },
    quality: {
      reviewStatus: "approved",
      trainingStatus: "queued",
      contentHash: hashText(content),
      metadataHash: hashText(JSON.stringify({ toolName: "ping" })),
      canRetrieve: true,
      canTrain: true,
    },
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

function parameterModule(overrides: Partial<ParameterModule> = {}): ParameterModule {
  return {
    id: "module-1",
    name: "module",
    kind: "adapter",
    parameters: 12_000_000,
    activeParameters: 12_000_000,
    trainableParameters: 12_000_000,
    status: "staged",
    datasetHashes: [],
    evalReports: [],
    sourceLearningItemIds: [],
    createdAt: "2026-06-18T15:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}
