import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ParameterGrowthPlanner,
  buildParameterGrowthPlan,
} from "../src/training/parameter/ParameterGrowthPlanner";
import type { LearnedItem } from "../src/learning/LiveLearningRegistry";

describe("ParameterGrowthPlanner", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("groups queued approved skill learning into ready expert batches", () => {
    const plan = buildParameterGrowthPlan(
      [
        learnedItem({
          id: "skill-1",
          content: "Use ping for quick health checks.",
          metadata: { toolName: "ping" },
        }),
        learnedItem({
          id: "skill-2",
          content: "Use ping before deeper diagnostics.",
          metadata: { toolName: "ping" },
        }),
      ],
      {
        limit: 100,
        now: () => "2026-06-18T20:00:00.000Z",
        minItemsByKind: { expert: 2 },
      },
    );

    expect(plan.status).toBe("ready");
    expect(plan.summary).toMatchObject({
      queuedCandidates: 2,
      trainableCandidates: 2,
      readyBatches: 1,
      estimatedNewParameters: 775_358,
    });
    expect(plan.batches[0]).toMatchObject({
      status: "ready",
      targetKind: "expert",
      route: "ping",
      estimatedNewParameters: 775_358,
      sourceLearningItemIds: ["skill-1", "skill-2"],
      gateRequirements: expect.arrayContaining(["skill", "contamination", "parameter_growth"]),
    });
  });

  it("blocks non-trainable candidates and avoids previews for non-retrievable training sources", () => {
    const plan = buildParameterGrowthPlan(
      [
        learnedItem({
          id: "private-skill",
          content: "Private but trainable tool habit.",
          metadata: { toolName: "remember_fact" },
          retention: { canRetrieve: false, canTrain: true },
        }),
        learnedItem({
          id: "blocked-memory",
          kind: "memory",
          content: "Recall only; do not train.",
          retention: { canRetrieve: true, canTrain: false },
        }),
      ],
      {
        limit: 100,
        now: () => "2026-06-18T20:00:00.000Z",
        minItemsByKind: { expert: 1 },
      },
    );

    expect(plan.summary).toMatchObject({ trainableCandidates: 1, blockedCandidates: 1 });
    expect(plan.blockedCandidates).toEqual([
      { itemId: "blocked-memory", kind: "memory", reason: "item retention policy does not allow training" },
    ]);
    expect(plan.batches[0]?.records[0]).toMatchObject({
      itemId: "private-skill",
      canRetrieve: false,
      canTrain: true,
    });
    expect(plan.batches[0]?.records[0]).not.toHaveProperty("contentPreview");
    expect(plan.batches[0]?.riskFlags).toContain("contains_non_retrievable_training_source");
  });

  it("writes timestamped and latest plan artifacts", async () => {
    dir = await mkdtemp(join(tmpdir(), "parameter-growth-plan-"));
    const planner = new ParameterGrowthPlanner(
      {
        listLearnedItems: async () => [
          learnedItem({ id: "skill-1", metadata: { toolName: "ping" } }),
          learnedItem({ id: "skill-2", metadata: { toolName: "ping" } }),
        ],
      },
      {
        now: () => "2026-06-18T20:00:00.000Z",
        minItemsByKind: { expert: 2 },
      },
    );

    const written = await planner.writePlan(dir);
    const saved = JSON.parse(await readFile(written.path, "utf8")) as { summary: { readyBatches: number } };
    const latest = JSON.parse(await readFile(written.latestPath, "utf8")) as { id: string };

    expect(saved.summary.readyBatches).toBe(1);
    expect(latest.id).toBe(written.plan.id);
  });
});

function learnedItem(overrides: Partial<LearnedItem> = {}): LearnedItem {
  return {
    id: "learned-1",
    kind: "skill",
    content: "Learned content.",
    source: "tool_success",
    confidence: 0.9,
    reviewStatus: "approved",
    accessPaths: ["skill_registry", "training_queue"],
    provenance: {},
    retention: { canRetrieve: true, canTrain: true },
    training: { status: "queued", queuedAt: "2026-06-18T19:00:00.000Z", datasetId: "skill-ledger-v1" },
    parameterModuleIds: [],
    createdAt: "2026-06-18T19:00:00.000Z",
    updatedAt: "2026-06-18T19:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}
