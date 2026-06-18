import { describe, expect, it } from "vitest";
import { applyParameterModulePromotionGate } from "../src/training/parameter/ParameterModulePromotionGate";
import type { ParameterModule } from "../src/learning/LiveLearningRegistry";

describe("ParameterModulePromotionGate", () => {
  it("passes a staged expert with manifest evidence, rollback, provenance, and required evals", () => {
    const result = applyParameterModulePromotionGate({
      module: parameterModule(),
      gateStatus: "pass",
    });

    expect(result.status).toBe("pass");
    expect(result.failures).toEqual([]);
    expect(result.summary).toMatchObject({
      requiredEvalKinds: ["skill", "protocol", "composite"],
      hasRollbackTarget: true,
      hasStagingEvidence: true,
    });
  });

  it("fails missing staging evidence and required evals", () => {
    const result = applyParameterModulePromotionGate({
      module: parameterModule({
        rollbackTargetId: undefined,
        datasetHashes: [],
        sourceLearningItemIds: [],
        evalReports: [{ kind: "skill", path: "reports/skill.json", status: "pass" }],
        metadata: {},
      }),
      gateStatus: "pass",
    });

    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.code)).toEqual([
      "missing_rollback_target",
      "missing_source_learning_items",
      "missing_dataset_hashes",
      "missing_staging_evidence",
      "missing_required_eval",
    ]);
  });

  it("fails when any attached eval report failed", () => {
    const result = applyParameterModulePromotionGate({
      module: parameterModule({
        evalReports: [
          { kind: "skill", path: "reports/skill.json", status: "pass" },
          { kind: "protocol", path: "reports/protocol.json", status: "fail" },
          { kind: "composite", path: "reports/staging.json", status: "pass" },
        ],
      }),
      gateStatus: "pass",
    });

    expect(result.status).toBe("fail");
    expect(result.failures).toContainEqual(expect.objectContaining({ code: "failed_eval_report" }));
  });
});

function parameterModule(overrides: Partial<ParameterModule> = {}): ParameterModule {
  return {
    id: "module-1",
    name: "ping-tool-expert",
    kind: "expert",
    parameters: 2_000_000,
    activeParameters: 500_000,
    trainableParameters: 2_000_000,
    status: "staged",
    datasetHashes: ["dataset-manifest-sha", "batch-sha"],
    evalReports: [
      { kind: "skill", path: "reports/skill.json", status: "pass" },
      { kind: "protocol", path: "reports/protocol.json", status: "pass" },
      { kind: "composite", path: "reports/staging.json", status: "pass" },
    ],
    sourceLearningItemIds: ["skill-1", "skill-2"],
    rollbackTargetId: "active-before-ping-expert",
    createdAt: "2026-06-18T15:00:00.000Z",
    metadata: {
      staging: {
        manifestPath: "training/runs/parameter-modules/run-1/staging-manifest.json",
        gateReport: { status: "pass" },
      },
    },
    ...overrides,
  };
}
