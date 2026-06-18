import { describe, expect, it } from "vitest";
import { LiveLearningRepository } from "../src/database/repositories/LiveLearningRepository";

describe("LiveLearningRepository", () => {
  it("persists learned items with immediate retrieval metadata", async () => {
    let createArgs: { data: Record<string, unknown> } | undefined;
    const prisma = {
      learnedItem: {
        create: async (args: { data: Record<string, unknown> }) => {
          createArgs = args;
          return learnedRow({
            ...args.data,
            id: "learned-1",
            createdAt: nowDate(),
            updatedAt: nowDate(),
            parameterLinks: [],
          });
        },
      },
    };

    const repo = new LiveLearningRepository(prisma as never);
    const item = await repo.createLearnedItem({
      kind: "memory",
      content: " Ian prefers direct answers. ",
      source: "conversation",
      confidence: 0.8,
      retention: { canTrain: true },
      provenance: { userId: "user-1", guildId: "guild-1" },
    });

    expect(createArgs?.data.kind).toBe("MEMORY");
    expect(createArgs?.data.reviewStatus).toBe("CANDIDATE");
    expect(createArgs?.data.trainingStatus).toBe("NOT_QUEUED");
    expect(createArgs?.data.accessPathsJson).toEqual(["memory_rag"]);
    expect(createArgs?.data.retentionJson).toEqual({ canRetrieve: true, canTrain: true });
    expect(item).toMatchObject({
      id: "learned-1",
      kind: "memory",
      content: "Ian prefers direct answers.",
      accessPaths: ["memory_rag"],
      retention: { canRetrieve: true, canTrain: true },
      parameterModuleIds: [],
    });
  });

  it("queues reviewed trainable learning without losing immediate access paths", async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const prisma = {
      learnedItem: {
        findUnique: async () =>
          learnedRow({
            reviewStatus: "APPROVED",
            retentionJson: { canRetrieve: true, canTrain: true },
            accessPathsJson: ["memory_rag"],
          }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return learnedRow({
            reviewStatus: "APPROVED",
            retentionJson: { canRetrieve: true, canTrain: true },
            accessPathsJson: args.data.accessPathsJson,
            trainingStatus: args.data.trainingStatus,
            trainingJson: args.data.trainingJson,
          });
        },
      },
    };

    const repo = new LiveLearningRepository(prisma as never, () => "2026-06-18T14:05:00.000Z");
    const queued = await repo.queueForTraining("learned-1", { datasetId: "skill-ledger-v1" });

    expect(updateArgs?.data.accessPathsJson).toEqual(["memory_rag", "training_queue"]);
    expect(updateArgs?.data.trainingStatus).toBe("QUEUED");
    expect(updateArgs?.data.trainingJson).toMatchObject({
      status: "queued",
      queuedAt: "2026-06-18T14:05:00.000Z",
      datasetId: "skill-ledger-v1",
    });
    expect(queued.training.status).toBe("queued");
    expect(queued.accessPaths).toEqual(["memory_rag", "training_queue"]);
  });

  it("stores review metadata when approving or rejecting learned items", async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const prisma = {
      learnedItem: {
        findUnique: async () =>
          learnedRow({
            metadataJson: { existing: true },
            accessPathsJson: ["skill_registry"],
            retentionJson: { canRetrieve: true, canTrain: true },
          }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return learnedRow({
            reviewStatus: args.data.reviewStatus,
            metadataJson: args.data.metadataJson,
            accessPathsJson: ["skill_registry"],
            retentionJson: { canRetrieve: true, canTrain: true },
          });
        },
      },
    };

    const repo = new LiveLearningRepository(prisma as never, () => "2026-06-18T15:00:00.000Z");
    const reviewed = await repo.markReviewed("learned-1", "approved", {
      reviewerId: "admin-1",
      reason: "good reusable workflow",
    });

    const expectedMetadata = {
      existing: true,
      review: {
        status: "approved",
        reviewedAt: "2026-06-18T15:00:00.000Z",
        reviewerId: "admin-1",
        reason: "good reusable workflow",
      },
    };
    expect(updateArgs?.data.reviewStatus).toBe("APPROVED");
    expect(updateArgs?.data.metadataJson).toEqual(expectedMetadata);
    expect(reviewed.metadata.review).toEqual(expectedMetadata.review);
  });

  it("stores parameter counts as BigInt and reports active/staged growth snapshots", async () => {
    let createArgs: { data: Record<string, unknown> } | undefined;
    const prisma = {
      parameterModuleRecord: {
        create: async (args: { data: Record<string, unknown> }) => {
          createArgs = args;
          return parameterRow({
            ...args.data,
            id: "base-1",
            createdAt: nowDate(),
          });
        },
        findMany: async () => [
          parameterRow({
            id: "base-1",
            name: "qwen3-4b",
            kind: "BASE_MODEL",
            parameters: 4_000_000_000n,
            activeParameters: 4_000_000_000n,
            trainableParameters: 4_000_000_000n,
            status: "ACTIVE",
          }),
          parameterRow({
            id: "adapter-1",
            name: "irene-behavior-lora-v1",
            kind: "ADAPTER",
            parameters: 12_000_000n,
            activeParameters: 12_000_000n,
            trainableParameters: 12_000_000n,
            status: "ACTIVE",
          }),
          parameterRow({
            id: "expert-1",
            name: "tool-expert-v1",
            kind: "EXPERT",
            parameters: 775_358n,
            activeParameters: 775_358n,
            trainableParameters: 775_358n,
            status: "STAGED",
          }),
        ],
      },
    };

    const repo = new LiveLearningRepository(prisma as never, () => "2026-06-18T14:06:00.000Z");
    await repo.createParameterModule({
      name: "qwen3-4b",
      kind: "base_model",
      parameters: 4_000_000_000,
      status: "active",
    });
    const snapshot = await repo.getParameterSnapshot();

    expect(createArgs?.data.parameters).toBe(4_000_000_000n);
    expect(createArgs?.data.status).toBe("ACTIVE");
    expect(snapshot).toMatchObject({
      generatedAt: "2026-06-18T14:06:00.000Z",
      baseModelParams: 4_000_000_000,
      adapterParams: 12_000_000,
      expertParams: 0,
      totalSystemParams: 4_012_000_000,
      stagedParams: 775_358,
      activeParamsPerRequest: 4_012_000_000,
      activeModuleIds: ["base-1", "adapter-1"],
      stagedModuleIds: ["expert-1"],
    });
  });

  it("promotes only after passing gates and links trained knowledge to the module", async () => {
    const calls: { upsert?: unknown; learnedUpdate?: { data: Record<string, unknown> }; moduleUpdate?: unknown } = {};
    const prisma = {
      parameterModuleRecord: {
        findUnique: async () =>
          parameterRow({
            id: "module-1",
            name: "skill-router-v1",
            kind: "SPECIALIST",
            parameters: 2_000_000n,
            activeParameters: 2_000_000n,
            trainableParameters: 2_000_000n,
            status: "STAGED",
            rollbackTargetId: "active-module-before-skill-router",
            datasetHashesJson: ["dataset-manifest-sha", "batch-sha"],
            sourceLearningItemIdsJson: ["learned-1"],
            evalReportsJson: [
              { kind: "skill", path: "reports/skill.json", status: "pass" },
              { kind: "protocol", path: "reports/protocol.json", status: "pass" },
              { kind: "composite", path: "reports/staging.json", status: "pass" },
            ],
            metadataJson: {
              staging: {
                manifestPath: "training/runs/parameter-modules/run-1/staging-manifest.json",
                gateReport: { status: "pass" },
              },
            },
          }),
        update: async (args: unknown) => {
          calls.moduleUpdate = args;
          return parameterRow({
            id: "module-1",
            name: "skill-router-v1",
            kind: "SPECIALIST",
            parameters: 2_000_000n,
            activeParameters: 2_000_000n,
            trainableParameters: 2_000_000n,
            status: "ACTIVE",
            sourceLearningItemIdsJson: ["learned-1"],
            evalReportsJson: [{ kind: "skill", path: "reports/skill.json", status: "pass" }],
            promotedAt: nowDate(),
          });
        },
      },
      learnedItem: {
        findUnique: async () =>
          learnedRow({
            id: "learned-1",
            kind: "SKILL",
            accessPathsJson: ["skill_registry", "training_queue"],
            trainingStatus: "QUEUED",
            trainingJson: { status: "queued", datasetId: "skill-ledger-v1" },
            parameterLinks: [],
          }),
        update: async (args: { data: Record<string, unknown> }) => {
          calls.learnedUpdate = args;
          return learnedRow({
            id: "learned-1",
            kind: "SKILL",
            accessPathsJson: args.data.accessPathsJson,
            trainingStatus: args.data.trainingStatus,
            trainingJson: args.data.trainingJson,
            parameterLinks: [{ parameterModuleId: "module-1" }],
          });
        },
      },
      learnedParameterModule: {
        upsert: async (args: unknown) => {
          calls.upsert = args;
          return {};
        },
      },
    };

    const repo = new LiveLearningRepository(prisma as never, () => "2026-06-18T14:07:00.000Z");
    const promoted = await repo.promoteParameterModule("module-1", {
      gateStatus: "pass",
      evalReport: { kind: "skill", path: "reports/skill.json", status: "pass" },
    });

    expect(promoted.status).toBe("active");
    expect(calls.upsert).toMatchObject({
      where: { learnedItemId_parameterModuleId: { learnedItemId: "learned-1", parameterModuleId: "module-1" } },
    });
    expect(calls.learnedUpdate?.data.accessPathsJson).toEqual([
      "skill_registry",
      "training_queue",
      "parameter_module",
    ]);
    expect(calls.learnedUpdate?.data.trainingStatus).toBe("TRAINED");
    expect(calls.learnedUpdate?.data.trainingJson).toMatchObject({
      status: "trained",
      trainedAt: "2026-06-18T14:07:00.000Z",
    });
  });

  it("summarizes learned items and parameter module growth", async () => {
    const prisma = {
      learnedItem: {
        count: async (args?: { where?: Record<string, unknown> }) => {
          if (args?.where?.reviewStatus === "CANDIDATE") return 2;
          if (args?.where?.reviewStatus === "APPROVED") return 1;
          if (args?.where?.trainingStatus === "QUEUED") return 1;
          if (args?.where?.trainingStatus === "TRAINED") return 1;
          return 4;
        },
      },
      parameterModuleRecord: {
        count: async (args?: { where?: Record<string, unknown> }) => {
          if (args?.where?.status === "ACTIVE") return 2;
          if (args?.where?.status === "STAGED") return 1;
          return 3;
        },
        findMany: async () => [
          parameterRow({
            id: "base-1",
            kind: "BASE_MODEL",
            parameters: 4_000_000_000n,
            activeParameters: 4_000_000_000n,
            status: "ACTIVE",
          }),
          parameterRow({
            id: "adapter-1",
            kind: "ADAPTER",
            parameters: 12_000_000n,
            activeParameters: 12_000_000n,
            status: "ACTIVE",
          }),
          parameterRow({
            id: "expert-1",
            kind: "EXPERT",
            parameters: 775_358n,
            activeParameters: 775_358n,
            status: "STAGED",
          }),
        ],
      },
    };

    const repo = new LiveLearningRepository(prisma as never);
    await expect(repo.getStats()).resolves.toMatchObject({
      learnedItems: 4,
      candidateItems: 2,
      approvedItems: 1,
      queuedItems: 1,
      trainedItems: 1,
      parameterModules: 3,
      activeParameterModules: 2,
      stagedParameterModules: 1,
      totalSystemParams: 4_012_000_000,
      stagedParams: 775_358,
      activeParamsPerRequest: 4_012_000_000,
    });
  });
});

function learnedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "learned-1",
    kind: "MEMORY",
    content: "Learned content.",
    source: "conversation",
    confidence: 0.8,
    reviewStatus: "CANDIDATE",
    trainingStatus: "NOT_QUEUED",
    accessPathsJson: ["memory_rag"],
    provenanceJson: {},
    retentionJson: { canRetrieve: true, canTrain: false },
    trainingJson: { status: "not_queued" },
    metadataJson: {},
    createdAt: nowDate(),
    updatedAt: nowDate(),
    parameterLinks: [],
    ...overrides,
  };
}

function parameterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "module-1",
    name: "module",
    kind: "ADAPTER",
    parameters: 12_000_000n,
    activeParameters: 12_000_000n,
    trainableParameters: 12_000_000n,
    status: "STAGED",
    baseModuleId: null,
    route: null,
    datasetHashesJson: [],
    evalReportsJson: [],
    sourceLearningItemIdsJson: [],
    rollbackTargetId: null,
    metadataJson: {},
    createdAt: nowDate(),
    promotedAt: null,
    retiredAt: null,
    ...overrides,
  };
}

function nowDate(): Date {
  return new Date("2026-06-18T14:00:00.000Z");
}
