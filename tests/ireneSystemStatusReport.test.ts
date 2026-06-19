import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIreneSystemStatusReport } from "../src/training/quality/IreneSystemStatusReport";

describe("IreneSystemStatusReport", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("reports active parameters, scratch parameters, and current capability gates", async () => {
    const fixture = await writeFixture();

    const report = await buildIreneSystemStatusReport({
      runRoot: fixture.runRoot,
      includeProductionReadiness: false,
      toolProtocolGatePath: fixture.gates.toolProtocol,
      behaviorScratchGatePath: fixture.gates.behavior,
      routerScratchGatePath: fixture.gates.router,
      specialistRouterBaselineGatePath: fixture.gates.specialistRouterBaseline,
      toolRouterGatePath: fixture.gates.toolRouter,
      memoryContinuityGatePath: fixture.gates.memory,
      skillRetrievalGatePath: fixture.gates.skill,
      longContextGatePath: fixture.gates.longContext,
      voiceGatePath: fixture.gates.voice,
      learningStats: {
        learnedItems: 12,
        candidateItems: 4,
        approvedItems: 3,
        queuedItems: 2,
        trainedItems: 1,
        parameterModules: 3,
        activeParameterModules: 2,
        stagedParameterModules: 1,
        totalSystemParams: 4_012_000_000,
        stagedParams: 775_358,
        activeParamsPerRequest: 4_012_000_000,
      },
      now: () => "2026-06-19T07:00:00.000Z",
    });

    expect(report.runtimeContract).toBe("irene-system-status-v1");
    expect(report.generatedAt).toBe("2026-06-19T07:00:00.000Z");
    expect(report.overall).toMatchObject({
      capabilityLevel: "tool_protocol_specialist_prototype",
      criticalFailures: ["behavior_scratch", "router_scratch"],
    });
    expect(report.parameterAccounting).toMatchObject({
      source: "learning_stats",
      plannedProductionBaseParams: 4_000_000_000,
      activeSystemParams: 4_012_000_000,
      activeParamsPerRequest: 4_012_000_000,
      stagedParams: 775_358,
      largestScratchCheckpointParams: 2_715_772,
      largestScratchCheckpointRun: "tiny-transformer-iter6-expanded-sft",
      bestProtocolScratchParams: 775_358,
      behaviorScratchParams: 845_005,
      routerScratchParams: 785_670,
    });
    expect(report.learning).toMatchObject({
      enabled: true,
      learnedItems: 12,
      queuedItems: 2,
      trainedItems: 1,
    });
    expect(surface(report, "tool_protocol_scratch")).toMatchObject({
      status: "pass",
      cases: 34,
      params: 775_358,
      metrics: {
        validJsonRate: 1,
        actionTypeAccuracy: 1,
        hallucinatedToolRate: 0,
      },
    });
    expect(surface(report, "behavior_scratch")).toMatchObject({
      status: "fail",
      params: 845_005,
      metrics: { validJsonRate: 0.545455, requirementPassRate: 0.454545 },
    });
    expect(surface(report, "router_scratch")).toMatchObject({
      status: "fail",
      params: 785_670,
      metrics: { routeAccuracy: 0.722222, invalidPredictions: 1 },
    });
    expect(surface(report, "router_heuristic_baseline")).toMatchObject({
      status: "pass",
      params: null,
      metrics: { routeAccuracy: 1, expertAccuracy: 1, invalidPredictions: 0 },
    });
    expect(surface(report, "memory_continuity")).toMatchObject({
      status: "pass",
      cases: 17,
      metrics: { passRate: 1, recallHitRate: 1 },
    });
    expect(report.nextActions).toEqual(
      expect.arrayContaining([
        "Fix behavior/persona JSON stability before judging social quality.",
        "Use the deterministic MoE router baseline as the guarded fallback while training the learned router to match it.",
        "Keep expanding BFCL-style tool cases so the perfect-tool-call target stays measurable.",
      ]),
    );
  });

  it("marks missing evidence as unmeasured without inventing quality", async () => {
    dir = await mkdtemp(join(tmpdir(), "irene-status-missing-"));
    const report = await buildIreneSystemStatusReport({
      runRoot: join(dir, "runs"),
      includeProductionReadiness: false,
      toolProtocolGatePath: join(dir, "missing-tool.json"),
      behaviorScratchGatePath: join(dir, "missing-behavior.json"),
      routerScratchGatePath: join(dir, "missing-router.json"),
      specialistRouterBaselineGatePath: join(dir, "missing-router-baseline.json"),
      toolRouterGatePath: join(dir, "missing-tool-router.json"),
      memoryContinuityGatePath: join(dir, "missing-memory.json"),
      skillRetrievalGatePath: join(dir, "missing-skill.json"),
      longContextGatePath: join(dir, "missing-long-context.json"),
      voiceGatePath: join(dir, "missing-voice.json"),
      now: () => "2026-06-19T07:10:00.000Z",
    });

    expect(report.overall.capabilityLevel).toBe("unmeasured");
    expect(report.parameterAccounting.source).toBe("not_configured");
    expect(report.parameterAccounting.activeSystemParams).toBe(0);
    expect(report.scratchRuns.totalRuns).toBe(0);
    expect(report.capabilityScorecard.every((surface) => surface.status === "not_measured")).toBe(true);
  });

  async function writeFixture(): Promise<{
    runRoot: string;
    gates: Record<
      "toolProtocol" | "behavior" | "router" | "specialistRouterBaseline" | "toolRouter" | "memory" | "skill" | "longContext" | "voice",
      string
    >;
  }> {
    dir = await mkdtemp(join(tmpdir(), "irene-status-"));
    const runRoot = join(dir, "runs");
    const gateDir = join(dir, "gates");
    await mkdir(runRoot, { recursive: true });
    await mkdir(gateDir, { recursive: true });

    await writeMetrics(runRoot, "tiny-transformer-protocol-iter16", 775_358, 235, 58, 6.0791, 0.0511);
    await writeMetrics(runRoot, "tiny-transformer-behavior-iter1", 392_619, 45, 11, 6.4848, 0.2655);
    await writeMetrics(runRoot, "tiny-transformer-behavior-iter2", 819_819, 45, 11, 6.3389, 0.1024);
    await writeMetrics(runRoot, "tiny-transformer-behavior-iter3", 840_122, 74, 18, 6.4123, 0.1215);
    await writeMetrics(runRoot, "tiny-transformer-behavior-iter4", 845_005, 90, 22, 6.3008, 0.135);
    await writeMetrics(runRoot, "tiny-transformer-router-iter1", 343_050, 34, 8, 6.2163, 0.3845);
    await writeMetrics(runRoot, "tiny-transformer-router-iter2", 753_802, 34, 8, 5.7557, 0.1145);
    await writeMetrics(runRoot, "tiny-transformer-router-iter3", 773_848, 60, 14, 5.9795, 0.1232);
    await writeMetrics(runRoot, "tiny-transformer-router-iter4", 785_670, 79, 19, 6.1731, 0.1587);
    await writeMetrics(runRoot, "tiny-transformer-iter6-expanded-sft", 2_715_772, 8_000, 1_000, 9.0983, 4.5789);

    const gates = {
      toolProtocol: join(gateDir, "tool-protocol.gate.json"),
      behavior: join(gateDir, "behavior.gate.json"),
      router: join(gateDir, "router.gate.json"),
      specialistRouterBaseline: join(gateDir, "specialist-router-baseline.gate.json"),
      toolRouter: join(gateDir, "tool-router.gate.json"),
      memory: join(gateDir, "memory.gate.json"),
      skill: join(gateDir, "skill.gate.json"),
      longContext: join(gateDir, "long-context.gate.json"),
      voice: join(gateDir, "voice.gate.json"),
    };
    await writeJson(
      gates.toolProtocol,
      gate("pass", {
        total: 34,
        validJsonRate: 1,
        actionTypeAccuracy: 1,
        toolNameAccuracy: 1,
        toolArgumentValidity: 1,
        noToolAccuracy: 1,
        hallucinatedToolRate: 0,
        latencyP95Ms: 653.428,
      }),
    );
    await writeJson(
      gates.behavior,
      gate("fail", {
        total: 11,
        validJsonRate: 0.545455,
        actionTypeAccuracy: 0.818182,
        requirementPassRate: 0.454545,
        personaConsistencyRate: 0.666667,
        socialCueAccuracy: 0.4,
        casualToneAccuracy: 0.5,
        boundaryAccuracy: 1,
      }),
    );
    await writeJson(
      gates.router,
      gate("fail", {
        total: 18,
        routeAccuracy: 0.722222,
        expertAccuracy: 0.777778,
        toolVsNonToolAccuracy: 0.888889,
        invalidPredictions: 1,
        latencyP95Ms: 1538.282,
      }),
    );
    await writeJson(
      gates.specialistRouterBaseline,
      gate("pass", {
        total: 18,
        routeAccuracy: 1,
        expertAccuracy: 1,
        toolVsNonToolAccuracy: 1,
        invalidPredictions: 0,
        latencyP95Ms: 1,
      }),
    );
    await writeJson(
      gates.toolRouter,
      gate("pass", {
        total: 75,
        expectedToolRecall: 1,
        top1Accuracy: 1,
        noToolAccuracy: 1,
        forbiddenCandidateRate: 0,
        latencyP95Ms: 1,
      }),
    );
    await writeJson(
      gates.memory,
      gate("pass", {
        total: 17,
        passRate: 1,
        recallHitRate: 1,
        isolationPassRate: 1,
        forgetPassRate: 1,
        policyRejectionPassRate: 1,
        learnedItemPassRate: 1,
        latencyP95Ms: 4,
      }),
    );
    await writeJson(
      gates.skill,
      gate("pass", { total: 10, recallAtK: 1, precisionAtK: 1, top1Accuracy: 1, noHitAccuracy: 1, latencyP95Ms: 1 }),
    );
    await writeJson(
      gates.longContext,
      gate("pass", { total: 28, answerRate: 1, exactMatchRate: 1, expectedContainRate: 1, falsePositiveRate: 0 }),
    );
    await writeJson(
      gates.voice,
      gate("pass", {
        total: 12,
        transcriptExactRate: 1,
        speakerAttributionAccuracy: 1,
        responseDecisionAccuracy: 1,
        latencyPassRate: 1,
        retentionPolicyPassRate: 1,
      }),
    );

    return { runRoot, gates };
  }
});

async function writeMetrics(
  runRoot: string,
  runName: string,
  parameters: number,
  trainRecords: number,
  validationRecords: number,
  firstValLoss: number,
  finalValLoss: number,
): Promise<void> {
  const runDir = join(runRoot, runName);
  await mkdir(runDir, { recursive: true });
  await writeJson(join(runDir, "metrics.json"), {
    model: "tiny_pytorch_transformer_lm",
    parameters,
    train_records: trainRecords,
    val_records: validationRecords,
    best_checkpoint_val_loss: finalValLoss,
    final_val_loss: finalValLoss,
    history: [
      { step: 1, val_loss: firstValLoss },
      { step: 2, val_loss: finalValLoss },
    ],
  });
}

function gate(status: "pass" | "fail", candidate: Record<string, unknown>): Record<string, unknown> {
  return { status, candidate, failures: status === "pass" ? [] : [{ metric: "fixture" }], warnings: [] };
}

async function writeJson(path: string, body: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function surface(
  report: Awaited<ReturnType<typeof buildIreneSystemStatusReport>>,
  id: string,
): Awaited<ReturnType<typeof buildIreneSystemStatusReport>>["capabilityScorecard"][number] {
  const found = report.capabilityScorecard.find((item) => item.id === id);
  if (!found) throw new Error(`missing surface ${id}`);
  return found;
}
