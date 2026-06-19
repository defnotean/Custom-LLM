import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkParameterModuleStagingManifest,
  readParameterModuleStagingManifest,
} from "../src/training/parameter/ParameterModuleStagingGate";
import {
  ParameterTrainerDispatchService,
  type ParameterTrainerDispatchRequest,
} from "../src/training/parameter/ParameterTrainerDispatchService";
import {
  runParameterTrainer,
  type ParameterTrainerRunnerEvalReportInput,
} from "../src/training/parameter/ParameterTrainerRunner";

describe("ParameterTrainerRunner", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("writes a SubQ-aware plan without staging artifacts", async () => {
    const fixture = await writeFixture();

    const report = await runParameterTrainer({
      requestPath: fixture.requestPath,
      mode: "plan",
      framework: "axolotl",
      now: () => "2026-06-19T00:15:00.000Z",
    });
    const plan = JSON.parse(await readFile(report.planPath, "utf8")) as Record<string, unknown>;

    expect(report).toMatchObject({
      status: "planned",
      mode: "plan",
      framework: "axolotl",
      requestId: "runner-1",
      trainerProfile: "qlora-subq-sft",
    });
    expect(plan).toMatchObject({
      runtimeContract: "parameter-trainer-runner-plan-v1",
      architecture: {
        target: "subquadratic-sparse-attention",
        requiredGate: "npm run check:subq-architecture",
        longContextProvider: "subq",
      },
      suggestedCommands: expect.arrayContaining(["npm run check:subq-architecture"]),
    });
    expect(await exists(fixture.request.expectedOutput.stagingManifestPath)).toBe(false);
  });

  it("imports trusted trainer artifacts into a staging manifest", async () => {
    const fixture = await writeFixture();
    const artifactDir = join(fixture.dir, "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "adapter_model.safetensors"), "adapter bytes", "utf8");
    await writeFile(
      join(artifactDir, "adapter_config.json"),
      `${JSON.stringify({ architectureTarget: "subquadratic-sparse-attention", rank: 16 })}\n`,
      "utf8",
    );
    const evalReports = await writeEvalReports(fixture.dir, [
      "dataset_quality",
      "parameter_growth",
      "training_report",
      "contamination",
      "protocol",
      "knowledge",
      "behavior",
    ]);

    const report = await runParameterTrainer({
      requestPath: fixture.requestPath,
      mode: "import-artifacts",
      framework: "axolotl",
      artifactDir,
      moduleKind: "adapter",
      parameters: 2_000_000,
      activeParameters: 500_000,
      trainableParameters: 2_000_000,
      rollbackTargetId: "base-before-adapter",
      evalReports,
      now: () => "2026-06-19T00:20:00.000Z",
    });
    const manifest = await readParameterModuleStagingManifest(fixture.request.expectedOutput.stagingManifestPath);
    const gate = await checkParameterModuleStagingManifest(fixture.request.expectedOutput.stagingManifestPath);

    expect(report).toMatchObject({
      status: "staged",
      moduleName: "irene_subq_tool_adapter",
      moduleKind: "adapter",
      artifacts: expect.arrayContaining([
        expect.objectContaining({ kind: "adapter" }),
        expect.objectContaining({ kind: "config" }),
      ]),
    });
    expect(manifest).toMatchObject({
      moduleName: "irene_subq_tool_adapter",
      kind: "adapter",
      route: "tool_protocol",
      sourceLearningItemIds: ["skill-1"],
      rollbackTargetId: "base-before-adapter",
      metadata: {
        requestId: "runner-1",
        trainerProfile: "qlora-subq-sft",
        architectureTarget: "subquadratic-sparse-attention",
        requiredArchitectureGate: "check:subq-architecture",
      },
    });
    expect(manifest.datasetHashes).toContain(fixture.datasetInfo.sha256);
    expect(manifest.evalReports).toHaveLength(7);
    expect(gate.status).toBe("pass");
  });

  it("requires parameter counts before importing artifacts", async () => {
    const fixture = await writeFixture();
    const evalReports = await writeEvalReports(fixture.dir, ["dataset_quality"]);

    await expect(
      runParameterTrainer({
        requestPath: fixture.requestPath,
        mode: "import-artifacts",
        framework: "custom",
        evalReports,
        rollbackTargetId: "base-before-adapter",
      }),
    ).rejects.toThrow("--parameters is required");
  });

  async function writeFixture(): Promise<{
    dir: string;
    requestPath: string;
    request: ParameterTrainerDispatchRequest;
    datasetInfo: { bytes: number; sha256: string };
  }> {
    dir = await mkdtemp(join(tmpdir(), "parameter-trainer-runner-"));
    const datasetPath = join(dir, "batch-1.jsonl");
    const record = datasetRecord("record-1", "skill-1", "Use the selected Discord tool only after protocol gates pass.");
    await writeFile(datasetPath, `${JSON.stringify(record)}\n`, "utf8");
    const datasetInfo = await fileInfo(datasetPath);
    const manifestPath = join(dir, "manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          id: "parameter-growth-dataset-fixture",
          planId: "plan-subq-1",
          generatedAt: "2026-06-19T00:10:00.000Z",
          gate: { status: "pass" },
          files: [{ batchId: "batch-1", path: datasetPath, lines: 1, ...datasetInfo }],
          batches: [
            {
              batchId: "batch-1",
              targetKind: "adapter",
              route: "tool_protocol",
              records: 1,
              moduleName: "irene_subq_tool_adapter",
              datasetId: "dataset-subq-tool-adapter",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const report = await new ParameterTrainerDispatchService({
      backend: { dispatch: async () => ({ status: "accepted" }) },
    }).dispatch({
      manifestPath,
      requestId: "runner-1",
      trainerProfile: "qlora-subq-sft",
      outDir: join(dir, "runs"),
    });
    if (!report.dispatchRequest) throw new Error("dispatch request was not built");
    await mkdir(report.dispatchRequest.expectedOutput.runDir, { recursive: true });
    const requestPath = join(report.dispatchRequest.expectedOutput.runDir, "trainer-dispatch-request.json");
    await writeFile(requestPath, `${JSON.stringify(report.dispatchRequest, null, 2)}\n`, "utf8");
    return { dir, requestPath, request: report.dispatchRequest, datasetInfo };
  }
});

function datasetRecord(id: string, itemId: string, content: string): unknown {
  return {
    id,
    batchId: "batch-1",
    itemId,
    target: {
      kind: "adapter",
      route: "tool_protocol",
      moduleName: "irene_subq_tool_adapter",
      datasetId: "dataset-subq-tool-adapter",
    },
    messages: [
      { role: "system", content: "You are Irene." },
      { role: "user", content },
      { role: "assistant", content: "I will use the protocol gates before calling any tool." },
    ],
    source: {
      kind: "skill",
      source: "tool_success",
      confidence: 0.94,
      content,
      metadata: { route: "tool_protocol" },
    },
    quality: {
      reviewStatus: "approved",
      trainingStatus: "queued",
      contentHash: hashText(content),
      metadataHash: hashText(JSON.stringify({ route: "tool_protocol" })),
      canRetrieve: true,
      canTrain: true,
    },
  };
}

async function writeEvalReports(
  dir: string,
  kinds: ParameterTrainerRunnerEvalReportInput["kind"][],
): Promise<ParameterTrainerRunnerEvalReportInput[]> {
  const reports: ParameterTrainerRunnerEvalReportInput[] = [];
  for (const kind of kinds) {
    const path = join(dir, `${kind}.report.json`);
    await writeFile(path, `${JSON.stringify({ kind, status: "pass" })}\n`, "utf8");
    reports.push({ kind, path, status: "pass", summary: `${kind} passed` });
  }
  return reports;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
