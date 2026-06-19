import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildParameterTrainerControlServer,
  CommandParameterTrainerBackend,
  InMemoryParameterTrainerControlService,
  type ParameterTrainerBackendDispatchInput,
  type ParameterTrainerControlBackend,
} from "../src/serving/ParameterTrainerControlServer";
import {
  ParameterTrainerDispatchService,
  type ParameterTrainerDispatchRequest,
} from "../src/training/parameter/ParameterTrainerDispatchService";

describe("ParameterTrainerControlServer", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("accepts checked trainer dispatches and exposes queued state", async () => {
    const fixture = await writeFixture();
    const request = await buildDispatchRequest(fixture.manifestPath, "dispatch-1");
    const app = buildParameterTrainerControlServer({
      service: new InMemoryParameterTrainerControlService({ now: () => "2026-06-18T23:50:00.000Z" }),
    });

    const dispatched = await app.inject({
      method: "POST",
      url: "/parameter-training/dispatch",
      payload: request,
    });
    const status = await app.inject({ method: "GET", url: "/parameter-training/status" });

    expect(dispatched.statusCode).toBe(200);
    expect(dispatched.json()).toMatchObject({
      status: "accepted",
      trainingRunId: "dispatch-1",
      stagingManifestPath: request.expectedOutput.stagingManifestPath,
      message: "state-only backend accepted trainer dispatch; no weights were trained",
      details: { backend: "state-only", qualityReport: { status: "pass" } },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      backend: "state-only",
      jobs: [
        {
          requestId: "dispatch-1",
          status: "accepted",
          datasetManifestId: "parameter-growth-dataset-fixture",
          planId: "plan-1",
          stagingManifestPath: request.expectedOutput.stagingManifestPath,
        },
      ],
      history: [{ type: "accepted", requestId: "dispatch-1", datasetManifestId: "parameter-growth-dataset-fixture" }],
    });
    await app.close();
  });

  it("dry-runs without calling the trainer backend", async () => {
    const fixture = await writeFixture();
    const request = await buildDispatchRequest(fixture.manifestPath, "dry-run-1", { dryRun: true });
    let calls = 0;
    const backend: ParameterTrainerControlBackend = {
      name: "should-not-run",
      dispatch: async () => {
        calls++;
        return { status: "rejected", message: "backend should not be called" };
      },
    };
    const app = buildParameterTrainerControlServer({
      service: new InMemoryParameterTrainerControlService({ backend }),
    });

    const dispatched = await app.inject({
      method: "POST",
      url: "/parameter-training/dispatch",
      payload: request,
    });
    const status = await app.inject({ method: "GET", url: "/parameter-training/status" });

    expect(dispatched.statusCode).toBe(200);
    expect(dispatched.json()).toMatchObject({
      status: "accepted",
      message: "dry run accepted; no trainer backend called",
    });
    expect(calls).toBe(0);
    expect(status.json()).toMatchObject({
      jobs: [{ requestId: "dry-run-1", status: "dry_run", dryRun: true }],
      history: [{ type: "dry_run", requestId: "dry-run-1" }],
    });
    await app.close();
  });

  it("rejects tampered datasets before recording an accepted job", async () => {
    const fixture = await writeFixture();
    const request = await buildDispatchRequest(fixture.manifestPath, "tampered-1");
    await writeFile(fixture.datasetPath, "tampered\n", "utf8");
    const app = buildParameterTrainerControlServer();

    const dispatched = await app.inject({
      method: "POST",
      url: "/parameter-training/dispatch",
      payload: request,
    });
    const status = await app.inject({ method: "GET", url: "/parameter-training/status" });

    expect(dispatched.statusCode).toBe(409);
    expect(dispatched.json()).toMatchObject({
      status: "rejected",
      message: "parameter training dataset quality gate failed",
      details: {
        qualityReport: {
          status: "fail",
          checks: expect.arrayContaining([
            expect.objectContaining({ id: "file-hash:batch-1", status: "fail" }),
          ]),
        },
      },
    });
    expect(status.json()).toMatchObject({
      jobs: [{ requestId: "tampered-1", status: "rejected" }],
      history: [{ type: "rejected", requestId: "tampered-1" }],
    });
    await app.close();
  });

  it("rejects dispatches whose embedded manifest does not match disk", async () => {
    const fixture = await writeFixture();
    const request = await buildDispatchRequest(fixture.manifestPath, "mismatch-1");
    const mismatched: ParameterTrainerDispatchRequest = {
      ...request,
      datasetManifest: { ...request.datasetManifest, id: "wrong-manifest-id" },
    };
    const app = buildParameterTrainerControlServer();

    const dispatched = await app.inject({
      method: "POST",
      url: "/parameter-training/dispatch",
      payload: mismatched,
    });

    expect(dispatched.statusCode).toBe(409);
    expect(dispatched.json()).toMatchObject({
      status: "rejected",
      message: "parameter training dispatch manifest does not match manifest path",
      details: {
        reason: "embedded dataset manifest differs from the manifest file on disk",
        qualityReport: { status: "pass" },
      },
    });
    await app.close();
  });

  it("delegates accepted dispatches to a configured backend", async () => {
    const fixture = await writeFixture();
    const request = await buildDispatchRequest(fixture.manifestPath, "backend-1");
    const calls: ParameterTrainerBackendDispatchInput[] = [];
    const backend: ParameterTrainerControlBackend = {
      name: "recording-trainer",
      dispatch: async (input) => {
        calls.push(input);
        return {
          status: "accepted",
          trainingRunId: "trainer-run-1",
          stagingManifestPath: input.request.expectedOutput.stagingManifestPath,
          message: "trainer accepted job",
        };
      },
    };
    const app = buildParameterTrainerControlServer({
      service: new InMemoryParameterTrainerControlService({ backend }),
    });

    const dispatched = await app.inject({
      method: "POST",
      url: "/parameter-training/dispatch",
      payload: request,
    });

    expect(dispatched.statusCode).toBe(200);
    expect(dispatched.json()).toMatchObject({
      status: "accepted",
      trainingRunId: "trainer-run-1",
      message: "trainer accepted job",
      details: { backend: "recording-trainer", qualityReport: { status: "pass" } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      request: { requestId: "backend-1", datasetManifest: { id: "parameter-growth-dataset-fixture" } },
      qualityReport: { status: "pass" },
    });
    await app.close();
  });

  it("runs a configured command trainer backend and requires staging output", async () => {
    const fixture = await writeFixture();
    const request = await buildDispatchRequest(fixture.manifestPath, "command-1", {
      outDir: join(fixture.dir, "runs"),
    });
    const backend = new CommandParameterTrainerBackend({
      command: process.execPath,
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const out = process.env.PARAMETER_TRAINER_STAGING_MANIFEST_PATH;",
          "fs.mkdirSync(path.dirname(out), { recursive: true });",
          "fs.writeFileSync(out, JSON.stringify({ requestId: process.env.PARAMETER_TRAINER_REQUEST_ID }) + '\\n');",
          "console.log('wrote ' + out);",
        ].join(""),
      ],
      timeoutMs: 10_000,
    });
    const app = buildParameterTrainerControlServer({
      service: new InMemoryParameterTrainerControlService({ backend }),
    });

    const dispatched = await app.inject({
      method: "POST",
      url: "/parameter-training/dispatch",
      payload: request,
    });
    const staging = JSON.parse(await readFile(request.expectedOutput.stagingManifestPath, "utf8")) as Record<string, unknown>;

    expect(dispatched.statusCode).toBe(200);
    expect(dispatched.json()).toMatchObject({
      status: "accepted",
      trainingRunId: "command-1",
      stagingManifestPath: request.expectedOutput.stagingManifestPath,
      message: "trainer command completed and staging manifest is present",
      details: {
        backend: "command",
        backendDetails: {
          exitCode: 0,
          requestPath: join(request.expectedOutput.runDir, "trainer-dispatch-request.json"),
          qualityReportPath: join(request.expectedOutput.runDir, "trainer-quality-report.json"),
        },
      },
    });
    expect(staging).toEqual({ requestId: "command-1" });
    await app.close();
  });

  it("rejects command trainer backend runs that do not write staging output", async () => {
    const fixture = await writeFixture();
    const request = await buildDispatchRequest(fixture.manifestPath, "command-missing-staging", {
      outDir: join(fixture.dir, "runs"),
    });
    const backend = new CommandParameterTrainerBackend({
      command: process.execPath,
      args: ["-e", "console.log('accepted but produced no staging manifest')"],
      timeoutMs: 10_000,
    });
    const app = buildParameterTrainerControlServer({
      service: new InMemoryParameterTrainerControlService({ backend }),
    });

    const dispatched = await app.inject({
      method: "POST",
      url: "/parameter-training/dispatch",
      payload: request,
    });
    const status = await app.inject({ method: "GET", url: "/parameter-training/status" });

    expect(dispatched.statusCode).toBe(409);
    expect(dispatched.json()).toMatchObject({
      status: "rejected",
      message: "trainer command did not write expected staging manifest",
      details: { backend: "command", backendDetails: { exitCode: 0 } },
    });
    expect(status.json()).toMatchObject({
      jobs: [{ requestId: "command-missing-staging", status: "rejected", backend: "command" }],
      history: [{ type: "rejected", requestId: "command-missing-staging" }],
    });
    await app.close();
  });

  it("protects trainer dispatch routes with an optional bearer token", async () => {
    const fixture = await writeFixture();
    const request = await buildDispatchRequest(fixture.manifestPath, "auth-1");
    const app = buildParameterTrainerControlServer({ apiKey: "secret" });

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/parameter-training/dispatch",
      payload: request,
    });
    const authenticated = await app.inject({
      method: "POST",
      url: "/parameter-training/dispatch",
      headers: { authorization: "Bearer secret" },
      payload: request,
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toEqual({ error: "unauthorized" });
    expect(authenticated.statusCode).toBe(200);
    await app.close();
  });

  async function writeFixture(): Promise<{ dir: string; manifestPath: string; datasetPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), "parameter-trainer-control-"));
    dirs.push(dir);
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
          generatedAt: "2026-06-18T23:45:00.000Z",
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
    return { dir, manifestPath, datasetPath };
  }
});

async function buildDispatchRequest(
  manifestPath: string,
  requestId: string,
  options: { dryRun?: boolean; outDir?: string } = {},
): Promise<ParameterTrainerDispatchRequest> {
  const report = await new ParameterTrainerDispatchService({
    backend: { dispatch: async () => ({ status: "accepted" }) },
  }).dispatch({
    manifestPath,
    requestId,
    dryRun: options.dryRun ?? false,
    trainerProfile: "qlora-sft-smoke",
    outDir: options.outDir ?? join("training", "runs", "parameter-modules"),
  });
  if (!report.dispatchRequest) throw new Error("dispatch request was not built");
  return report.dispatchRequest;
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
