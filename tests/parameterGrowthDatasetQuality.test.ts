import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ParameterGrowthDatasetBuilder } from "../src/training/parameter/ParameterGrowthDatasetBuilder";
import { checkParameterGrowthDatasetQuality } from "../src/training/parameter/ParameterGrowthDatasetQuality";
import { buildParameterGrowthPlan } from "../src/training/parameter/ParameterGrowthPlanner";
import type { LearnedItem } from "../src/learning/LiveLearningRegistry";

describe("ParameterGrowthDatasetQuality", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes a freshly built gated parameter-growth dataset", async () => {
    const built = await buildFixture();

    const report = await checkParameterGrowthDatasetQuality(built.manifestPath);

    expect(report.status).toBe("pass");
    expect(report.summary).toMatchObject({ files: 1, records: 2, batches: 1, gateStatus: "pass" });
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("fails when dataset files change after manifest creation", async () => {
    const built = await buildFixture();
    const filePath = built.manifest.files[0]!.path;
    await writeFile(filePath, `${await readFile(filePath, "utf8")}tampered\n`, "utf8");

    const report = await checkParameterGrowthDatasetQuality(built.manifestPath);

    expect(report.status).toBe("fail");
    expect(report.checks.map((check) => check.id)).toContain(`file-hash:${built.manifest.files[0]!.batchId}`);
  });

  it("fails obvious secret leakage in records", async () => {
    const built = await buildFixture({
      content: "Use ping with api_key=sk-thisshouldnotbeleaked12345",
    });

    const report = await checkParameterGrowthDatasetQuality(built.manifestPath);

    expect(report.status).toBe("fail");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "secret-scan",
        status: "fail",
      }),
    );
  });

  async function buildFixture(overrides: Partial<LearnedItem> = {}) {
    dir = await mkdtemp(join(tmpdir(), "parameter-growth-quality-"));
    const items = [
      learnedItem({ id: "skill-1", content: "Use ping for quick health checks.", metadata: { toolName: "ping" }, ...overrides }),
      learnedItem({ id: "skill-2", content: "Use ping before deeper diagnostics.", metadata: { toolName: "ping" } }),
    ];
    const plan = buildParameterGrowthPlan(items, {
      limit: 100,
      now: () => "2026-06-18T20:00:00.000Z",
      minItemsByKind: { expert: 2 },
    });
    return new ParameterGrowthDatasetBuilder({
      getLearnedItem: async (id) => items.find((item) => item.id === id) ?? null,
    }).build(plan, {
      outDir: dir,
      gateThresholds: { requireRiskReview: false },
      now: () => "2026-06-18T20:05:00.000Z",
    });
  }
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
