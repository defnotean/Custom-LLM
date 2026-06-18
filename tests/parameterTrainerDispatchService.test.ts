import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpParameterTrainerBackend,
  ParameterTrainerDispatchService,
  type ParameterTrainerDispatchRequest,
} from "../src/training/parameter/ParameterTrainerDispatchService";

describe("ParameterTrainerDispatchService", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("quality-checks a parameter-growth dataset and returns a dry-run trainer request", async () => {
    const fixture = await writeFixture();
    const service = new ParameterTrainerDispatchService({ now: () => "2026-06-18T23:30:00.000Z" });

    const report = await service.dispatch({
      manifestPath: fixture.manifestPath,
      dryRun: true,
      requestId: "dispatch-1",
      trainerProfile: "qlora-sft-smoke",
      outDir: "training/runs/parameter-modules",
    });

    expect(report.status).toBe("dry_run");
    expect(report.qualityReport.status).toBe("pass");
    expect(report.dispatchRequest).toMatchObject({
      runtimeContract: "parameter-training-dispatch-v1",
      requestId: "dispatch-1",
      dryRun: true,
      trainerProfile: "qlora-sft-smoke",
      datasetManifestPath: fixture.manifestPath,
      datasetManifest: { id: "parameter-growth-dataset-fixture", planId: "plan-1" },
      expectedOutput: {
        runDir: join("training", "runs", "parameter-modules", "dispatch-1"),
        stagingManifestPath: join("training", "runs", "parameter-modules", "dispatch-1", "staging-manifest.json"),
        nextGates: expect.arrayContaining(["check:parameter-module-staging", "apply:parameter-hotload"]),
      },
    });
  });

  it("blocks dispatch when the dataset quality gate fails", async () => {
    const fixture = await writeFixture();
    await writeFile(fixture.datasetPath, "tampered\n", "utf8");
    const calls: ParameterTrainerDispatchRequest[] = [];
    const service = new ParameterTrainerDispatchService({
      backend: {
        dispatch: async (request) => {
          calls.push(request);
          return { status: "accepted" };
        },
      },
    });

    const report = await service.dispatch({ manifestPath: fixture.manifestPath, requestId: "blocked-dispatch" });

    expect(report.status).toBe("blocked");
    expect(report.qualityReport.checks).toContainEqual(
      expect.objectContaining({ id: "file-hash:batch-1", status: "fail" }),
    );
    expect(report.dispatchRequest).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("sends a checked dispatch request to the configured backend", async () => {
    const fixture = await writeFixture();
    const calls: ParameterTrainerDispatchRequest[] = [];
    const service = new ParameterTrainerDispatchService({
      backend: {
        dispatch: async (request) => {
          calls.push(request);
          return {
            status: "accepted",
            trainingRunId: "run-1",
            stagingManifestPath: request.expectedOutput.stagingManifestPath,
          };
        },
      },
    });

    const report = await service.dispatch({ manifestPath: fixture.manifestPath, requestId: "dispatch-live" });

    expect(report.status).toBe("dispatched");
    expect(report.backendResult).toMatchObject({
      status: "accepted",
      trainingRunId: "run-1",
      stagingManifestPath: expect.stringContaining("staging-manifest.json"),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      runtimeContract: "parameter-training-dispatch-v1",
      requestId: "dispatch-live",
      datasetManifest: { batches: [{ batchId: "batch-1", targetKind: "expert" }] },
    });
  });

  it("maps HTTP trainer failures to rejected backend results", async () => {
    const backend = new HttpParameterTrainerBackend({
      endpointUrl: "http://trainer.local/dispatch",
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        statusText: "Unavailable",
        text: async () => JSON.stringify({ error: "offline" }),
      }),
    });

    const result = await backend.dispatch({
      runtimeContract: "parameter-training-dispatch-v1",
      requestId: "dispatch-http",
      dryRun: false,
      trainerProfile: "qlora-sft-smoke",
      datasetManifestPath: "training/data/parameter-growth/plan-1/manifest.json",
      datasetManifest: {
        id: "parameter-growth-dataset-fixture",
        planId: "plan-1",
        generatedAt: "2026-06-18T23:20:00.000Z",
        gate: { status: "pass" },
        files: [],
        batches: [],
      },
      expectedOutput: {
        runDir: "training/runs/parameter-modules/dispatch-http",
        stagingManifestPath: "training/runs/parameter-modules/dispatch-http/staging-manifest.json",
        nextGates: [],
      },
    });

    expect(result).toMatchObject({
      status: "rejected",
      message: "trainer endpoint returned HTTP 503 Unavailable",
      details: { response: { error: "offline" } },
    });
  });

  async function writeFixture(): Promise<{ manifestPath: string; datasetPath: string }> {
    dir = await mkdtemp(join(tmpdir(), "parameter-trainer-dispatch-"));
    const datasetPath = join(dir, "batch-1.jsonl");
    const record = {
      id: "batch-1:skill-1",
      batchId: "batch-1",
      itemId: "skill-1",
      target: {
        kind: "expert",
        route: "ping",
        moduleName: "ping_tool_expert",
        datasetId: "dataset-ping-expert",
      },
      messages: [
        { role: "system", content: "You are Irene." },
        { role: "user", content: "Ping tool workflow" },
        { role: "assistant", content: "Use the ping tool only when gates allow it." },
      ],
      source: {
        kind: "skill",
        source: "tool_success",
        confidence: 0.95,
        content: "Ping tool workflow",
        metadata: { toolName: "ping" },
      },
      quality: {
        reviewStatus: "approved",
        trainingStatus: "queued",
        contentHash: hashText("Ping tool workflow"),
        metadataHash: hashText("{\"toolName\":\"ping\"}"),
        canRetrieve: true,
        canTrain: true,
      },
    };
    await writeFile(datasetPath, `${JSON.stringify(record)}\n`, "utf8");
    const datasetInfo = await fileInfo(datasetPath);
    const manifestPath = join(dir, "manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          id: "parameter-growth-dataset-fixture",
          planId: "plan-1",
          generatedAt: "2026-06-18T23:20:00.000Z",
          gate: { status: "pass" },
          files: [{ batchId: "batch-1", path: datasetPath, lines: 1, ...datasetInfo }],
          batches: [
            {
              batchId: "batch-1",
              targetKind: "expert",
              route: "ping",
              records: 1,
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
    return { manifestPath, datasetPath };
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
