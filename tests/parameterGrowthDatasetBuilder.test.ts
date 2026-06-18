import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ParameterGrowthDatasetBuilder } from "../src/training/parameter/ParameterGrowthDatasetBuilder";
import { buildParameterGrowthPlan } from "../src/training/parameter/ParameterGrowthPlanner";
import type { LearnedItem } from "../src/learning/LiveLearningRegistry";

describe("ParameterGrowthDatasetBuilder", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("writes gated parameter-growth JSONL records and a manifest", async () => {
    dir = await mkdtemp(join(tmpdir(), "parameter-growth-data-"));
    const items = [
      learnedItem({ id: "skill-1", content: "Use ping for quick health checks.", metadata: { toolName: "ping" } }),
      learnedItem({ id: "skill-2", content: "Use ping before deeper diagnostics.", metadata: { toolName: "ping" } }),
    ];
    const plan = buildParameterGrowthPlan(items, {
      limit: 100,
      now: () => "2026-06-18T20:00:00.000Z",
      minItemsByKind: { expert: 2 },
    });
    const builder = new ParameterGrowthDatasetBuilder({
      getLearnedItem: async (id) => items.find((item) => item.id === id) ?? null,
    });

    const result = await builder.build(plan, {
      outDir: dir,
      gateThresholds: { requireRiskReview: false },
      now: () => "2026-06-18T20:05:00.000Z",
    });

    expect(result.manifest.planId).toBe(plan.id);
    expect(result.manifest.files).toHaveLength(1);
    expect(result.manifest.files[0]?.lines).toBe(2);

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as { files: Array<{ path: string }> };
    const firstFile = manifest.files[0]?.path;
    expect(firstFile).toBeTruthy();
    const records = (await readFile(firstFile!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { messages: Array<{ role: string; content: string }>; target: { route?: string } });
    expect(records).toHaveLength(2);
    expect(records[0]?.target.route).toBe("ping");
    expect(records[0]?.messages[0]).toMatchObject({ role: "system" });
    expect(records[0]?.messages[1]?.content).toContain("Use ping for quick health checks.");
    expect(records[0]?.messages[2]?.content).toContain("must not bypass candidate-tool");
  });

  it("refuses to build when a learned item changed after planning", async () => {
    dir = await mkdtemp(join(tmpdir(), "parameter-growth-data-"));
    const planned = [
      learnedItem({ id: "skill-1", content: "Use ping for quick health checks.", metadata: { toolName: "ping" } }),
      learnedItem({ id: "skill-2", content: "Use ping before deeper diagnostics.", metadata: { toolName: "ping" } }),
    ];
    const changed = planned.map((item) =>
      item.id === "skill-2" ? { ...item, content: "Changed after plan creation." } : item,
    );
    const plan = buildParameterGrowthPlan(planned, {
      limit: 100,
      now: () => "2026-06-18T20:00:00.000Z",
      minItemsByKind: { expert: 2 },
    });
    const builder = new ParameterGrowthDatasetBuilder({
      getLearnedItem: async (id) => changed.find((item) => item.id === id) ?? null,
    });

    await expect(
      builder.build(plan, {
        outDir: dir,
        gateThresholds: { requireRiskReview: false },
      }),
    ).rejects.toThrow(/content hash changed/);
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
