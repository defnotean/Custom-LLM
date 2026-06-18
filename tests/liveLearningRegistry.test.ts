import { describe, expect, it } from "vitest";
import { LiveLearningRegistry } from "../src/learning/LiveLearningRegistry";

describe("LiveLearningRegistry", () => {
  it("records immediately accessible memories without pretending parameters changed", () => {
    const registry = makeRegistry();

    const item = registry.recordLearnedItem({
      kind: "memory",
      content: "Ian prefers Irene to answer directly and casually.",
      source: "conversation",
      confidence: 0.8,
      retention: { canTrain: true },
      provenance: { userId: "u1", guildId: "g1", channelId: "c1" },
    });

    expect(item.accessPaths).toEqual(["memory_rag"]);
    expect(item.parameterModuleIds).toEqual([]);
    expect(registry.getKnowledgeStatus(item.id)).toMatchObject({
      immediatelyRetrievable: true,
      queuedForTraining: false,
      trainedIntoParameters: false,
    });
    expect(registry.getParameterSnapshot()).toMatchObject({
      totalSystemParams: 0,
      activeParamsPerRequest: 0,
    });
  });

  it("queues only approved or high-confidence trainable items for background learning", () => {
    const registry = makeRegistry();
    const item = registry.recordLearnedItem({
      kind: "correction",
      content: "When a user says 'wrong direction', ask what was missed.",
      source: "human_correction",
      confidence: 0.7,
      retention: { canTrain: true },
    });

    expect(() => registry.queueForTraining(item.id)).toThrow(/not approved or high-confidence/);

    registry.markReviewed(item.id, "approved");
    const queued = registry.queueForTraining(item.id, { datasetId: "behavior-sft-v2" });
    expect(queued.training).toMatchObject({ status: "queued", datasetId: "behavior-sft-v2" });
    expect(queued.accessPaths).toContain("training_queue");
  });

  it("blocks training promotion for retained memories that are not allowed for training", () => {
    const registry = makeRegistry();
    const item = registry.recordLearnedItem({
      kind: "voice_summary",
      content: "A voice session summary that can be recalled but not trained on.",
      source: "voice",
      confidence: 0.99,
      retention: { canRetrieve: true, canTrain: false },
    });

    expect(registry.getKnowledgeStatus(item.id).immediatelyRetrievable).toBe(true);
    expect(() => registry.queueForTraining(item.id)).toThrow(/not allowed for training/);
  });

  it("tracks active, staged, total, and per-request parameter counts", () => {
    const registry = makeRegistry();
    const base = registry.registerParameterModule({
      name: "qwen3-4b",
      kind: "base_model",
      parameters: 4_000_000_000,
      activeParameters: 4_000_000_000,
      status: "active",
    });
    registry.registerParameterModule({
      name: "irene-behavior-lora-v1",
      kind: "adapter",
      parameters: 12_000_000,
      activeParameters: 12_000_000,
      baseModuleId: base.id,
      status: "active",
    });
    const router = registry.registerParameterModule({
      name: "irene-router-v1",
      kind: "router",
      parameters: 343_050,
      activeParameters: 343_050,
      status: "active",
    });
    const specialist = registry.registerParameterModule({
      name: "irene-social-specialist-v2",
      kind: "specialist",
      parameters: 392_619,
      activeParameters: 392_619,
      status: "staged",
    });

    const before = registry.getParameterSnapshot();
    expect(before).toMatchObject({
      baseModelParams: 4_000_000_000,
      adapterParams: 12_000_000,
      routerParams: 343_050,
      specialistParams: 0,
      totalSystemParams: 4_012_343_050,
      stagedParams: 392_619,
    });
    expect(before.activeModuleIds).toEqual([base.id, "id-2", router.id]);

    registry.promoteParameterModule(specialist.id, { gateStatus: "pass" });
    const after = registry.getParameterSnapshot({ selectedModuleIds: [specialist.id] });
    expect(after.specialistParams).toBe(392_619);
    expect(after.totalSystemParams).toBe(4_012_735_669);
    expect(after.activeParamsPerRequest).toBe(4_012_735_669);
  });

  it("requires a passing gate before hot-promoting staged parameter modules", () => {
    const registry = makeRegistry();
    const module = registry.registerParameterModule({
      name: "irene-tool-expert-v1",
      kind: "expert",
      parameters: 775_358,
      activeParameters: 775_358,
    });

    expect(() => registry.promoteParameterModule(module.id, { gateStatus: "fail" })).toThrow(/cannot be promoted/);
    expect(registry.getParameterModule(module.id)?.status).toBe("staged");
  });

  it("links trained modules back to the learned items that created them", () => {
    const registry = makeRegistry();
    const item = registry.recordLearnedItem({
      kind: "skill",
      content: "If a workflow succeeds twice, store the exact tool sequence as a reusable skill.",
      source: "tool_trace",
      confidence: 0.95,
      reviewStatus: "approved",
      retention: { canTrain: true },
    });
    registry.queueForTraining(item.id, { datasetId: "skill-ledger-v1" });

    const module = registry.registerParameterModule({
      name: "skill-router-v1",
      kind: "specialist",
      parameters: 2_000_000,
      sourceLearningItemIds: [item.id],
    });
    registry.promoteParameterModule(module.id, { gateStatus: "pass" });

    expect(registry.getKnowledgeStatus(item.id)).toMatchObject({
      immediatelyRetrievable: true,
      queuedForTraining: false,
      trainedIntoParameters: true,
      parameterModuleIds: [module.id],
    });
    expect(registry.getLearnedItem(item.id)?.training.status).toBe("trained");
  });
});

function makeRegistry(): LiveLearningRegistry {
  let nextId = 1;
  let tick = 0;
  return new LiveLearningRegistry({
    idFactory: () => `id-${nextId++}`,
    now: () => `2026-06-18T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  });
}
