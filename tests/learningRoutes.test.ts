import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerLearningRoutes } from "../src/server/routes/learning";
import type { LearnedItem, ParameterModule } from "../src/learning/LiveLearningRegistry";

describe("learning routes", () => {
  it("returns live learning and parameter-growth status", async () => {
    const app = Fastify({ logger: false });
    registerLearningRoutes(app, {
      getStats: async () => ({
        learnedItems: 3,
        candidateItems: 1,
        approvedItems: 1,
        queuedItems: 1,
        trainedItems: 1,
        parameterModules: 2,
        activeParameterModules: 1,
        stagedParameterModules: 1,
        totalSystemParams: 4_012_000_000,
        stagedParams: 775_358,
        activeParamsPerRequest: 4_012_000_000,
      }),
    });

    const response = await app.inject({ method: "GET", url: "/learning/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      learnedItems: 3,
      queuedItems: 1,
      trainedItems: 1,
      activeParameterModules: 1,
      stagedParameterModules: 1,
      totalSystemParams: 4_012_000_000,
    });
    await app.close();
  });

  it("returns unavailable when live learning persistence is not configured", async () => {
    const app = Fastify({ logger: false });
    registerLearningRoutes(app, { getStats: null });

    const response = await app.inject({ method: "GET", url: "/learning/status" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "live learning persistence disabled" });
    await app.close();
  });

  it("lists learned candidates with typed filters", async () => {
    const app = Fastify({ logger: false });
    const calls: unknown[] = [];
    registerLearningRoutes(app, {
      getStats: null,
      listLearnedItems: async (filter) => {
        calls.push(filter);
        return [learnedItem({ id: "learned-1", kind: "skill" })];
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/learning/items?kind=skill&reviewStatus=candidate&trainingStatus=not_queued&limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ count: 1, items: [{ id: "learned-1", kind: "skill" }] });
    expect(calls).toEqual([
      { kind: "skill", reviewStatus: "candidate", trainingStatus: "not_queued", limit: 25 },
    ]);
    await app.close();
  });

  it("reviews and queues learned items for training", async () => {
    const app = Fastify({ logger: false });
    const reviewCalls: unknown[] = [];
    const queueCalls: unknown[] = [];
    registerLearningRoutes(app, {
      getStats: null,
      markReviewed: async (id, status, options) => {
        reviewCalls.push({ id, status, options });
        return learnedItem({ id, reviewStatus: status });
      },
      queueForTraining: async (id, options) => {
        queueCalls.push({ id, options });
        return learnedItem({
          id,
          reviewStatus: "approved",
          training: { status: "queued", queuedAt: "2026-06-18T15:00:00.000Z", datasetId: options?.datasetId },
          accessPaths: ["skill_registry", "training_queue"],
        });
      },
    });

    const review = await app.inject({
      method: "POST",
      url: "/learning/items/learned-1/review",
      payload: { status: "approved", reviewerId: "admin-1", reason: "good reusable workflow" },
    });
    const queued = await app.inject({
      method: "POST",
      url: "/learning/items/learned-1/queue",
      payload: { datasetId: "skill-ledger-v1", reason: "approved reusable skill" },
    });

    expect(review.statusCode).toBe(200);
    expect(queued.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ id: "learned-1", reviewStatus: "approved" });
    expect(queued.json()).toMatchObject({
      id: "learned-1",
      training: { status: "queued", datasetId: "skill-ledger-v1" },
      accessPaths: ["skill_registry", "training_queue"],
    });
    expect(reviewCalls).toEqual([
      {
        id: "learned-1",
        status: "approved",
        options: { reviewerId: "admin-1", reason: "good reusable workflow" },
      },
    ]);
    expect(queueCalls).toEqual([
      {
        id: "learned-1",
        options: { datasetId: "skill-ledger-v1", reason: "approved reusable skill" },
      },
    ]);
    await app.close();
  });

  it("dry-runs batch review and queue planning without mutating learned items", async () => {
    const app = Fastify({ logger: false });
    const calls: unknown[] = [];
    registerLearningRoutes(app, {
      getStats: null,
      listLearnedItems: async (filter) => {
        calls.push({ method: "list", filter });
        return [
          learnedItem({
            id: "skill-1",
            confidence: 0.82,
            reviewStatus: "candidate",
            retention: { canRetrieve: true, canTrain: true },
          }),
        ];
      },
      markReviewed: async () => {
        calls.push({ method: "review" });
        throw new Error("should not mutate on dry-run");
      },
      queueForTraining: async () => {
        calls.push({ method: "queue" });
        throw new Error("should not mutate on dry-run");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/learning/items/batch-review",
      payload: {
        filter: { kind: "skill", reviewStatus: "candidate", trainingStatus: "not_queued", limit: 10 },
        reviewStatus: "approved",
        queue: true,
        datasetId: "skill-ledger-v2",
        dryRun: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runtimeContract: "learning-batch-review-v1",
      status: "dry_run",
      dryRun: true,
      summary: { matched: 1, reviewed: 1, queued: 1, skipped: 0, errors: 0 },
      matchedItemIds: ["skill-1"],
      reviewed: [{ id: "skill-1", status: "approved" }],
      queued: [{ id: "skill-1", trainingStatus: "queued" }],
    });
    expect(calls).toEqual([
      {
        method: "list",
        filter: { kind: "skill", reviewStatus: "candidate", trainingStatus: "not_queued", limit: 10 },
      },
    ]);
    await app.close();
  });

  it("executes batch review and queues only items allowed by training retention", async () => {
    const app = Fastify({ logger: false });
    const calls: unknown[] = [];
    registerLearningRoutes(app, {
      getStats: null,
      getLearnedItem: async (id) => {
        calls.push({ method: "get", id });
        if (id === "missing") return null;
        return learnedItem({
          id,
          confidence: id === "blocked" ? 0.99 : 0.76,
          reviewStatus: "candidate",
          retention: { canRetrieve: true, canTrain: id !== "blocked" },
        });
      },
      markReviewed: async (id, status, options) => {
        calls.push({ method: "review", id, status, options });
        return learnedItem({
          id,
          reviewStatus: status,
          retention: { canRetrieve: true, canTrain: id !== "blocked" },
        });
      },
      queueForTraining: async (id, options) => {
        calls.push({ method: "queue", id, options });
        return learnedItem({
          id,
          reviewStatus: "approved",
          retention: { canRetrieve: true, canTrain: true },
          training: { status: "queued", queuedAt: "2026-06-18T16:00:00.000Z", datasetId: options?.datasetId },
          accessPaths: ["skill_registry", "training_queue"],
        });
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/learning/items/batch-review",
      payload: {
        ids: ["trainable", "blocked", "missing", "trainable"],
        reviewStatus: "approved",
        reviewerId: "admin",
        reviewReason: "batch-approved reusable learning",
        queue: true,
        datasetId: "skill-ledger-v2",
        queueReason: "ready for next parameter-growth pass",
        execute: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "partial",
      dryRun: false,
      selector: { ids: ["trainable", "blocked", "missing"] },
      summary: { matched: 2, missing: 1, reviewed: 2, queued: 1, skipped: 2, errors: 0 },
      missingIds: ["missing"],
      queued: [{ id: "trainable", trainingStatus: "queued" }],
      skipped: expect.arrayContaining([
        { id: "missing", operation: "review", reason: "learning item not found" },
        { id: "blocked", operation: "queue", reason: "retention policy does not allow training" },
      ]),
    });
    expect(calls).toMatchObject([
      { method: "get", id: "trainable" },
      { method: "get", id: "blocked" },
      { method: "get", id: "missing" },
      {
        method: "review",
        id: "trainable",
        status: "approved",
        options: { reviewerId: "admin", reason: "batch-approved reusable learning" },
      },
      {
        method: "queue",
        id: "trainable",
        options: { datasetId: "skill-ledger-v2", reason: "ready for next parameter-growth pass" },
      },
      {
        method: "review",
        id: "blocked",
        status: "approved",
        options: { reviewerId: "admin", reason: "batch-approved reusable learning" },
      },
    ]);
    await app.close();
  });

  it("rejects batch review requests without an explicit selector or operation", async () => {
    const app = Fastify({ logger: false });
    registerLearningRoutes(app, {
      getStats: null,
      listLearnedItems: async () => [],
    });

    const noSelector = await app.inject({
      method: "POST",
      url: "/learning/items/batch-review",
      payload: { reviewStatus: "approved" },
    });
    const noOperation = await app.inject({
      method: "POST",
      url: "/learning/items/batch-review",
      payload: { filter: { reviewStatus: "candidate", limit: 10 } },
    });

    expect(noSelector.statusCode).toBe(400);
    expect(noSelector.json()).toEqual({ error: "batch review requires ids or filter" });
    expect(noOperation.statusCode).toBe(400);
    expect(noOperation.json()).toEqual({ error: "batch review requires reviewStatus or queue=true" });
    await app.close();
  });

  it("reports queue gate failures without mutating training state", async () => {
    const app = Fastify({ logger: false });
    registerLearningRoutes(app, {
      getStats: null,
      queueForTraining: async () => {
        throw new Error("learned item learned-1 is not approved or high-confidence enough for training");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/learning/items/learned-1/queue",
      payload: { datasetId: "skill-ledger-v1" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "learning item cannot be queued",
      reason: expect.stringContaining("not approved"),
    });
    await app.close();
  });

  it("lists, creates, promotes, and snapshots parameter modules", async () => {
    const app = Fastify({ logger: false });
    const calls: unknown[] = [];
    registerLearningRoutes(app, {
      getStats: null,
      listParameterModules: async (filter) => {
        calls.push({ method: "list", filter });
        return [parameterModule({ id: "module-1", kind: "expert", status: "active" })];
      },
      createParameterModule: async (input) => {
        calls.push({ method: "create", input });
        return parameterModule({ id: input.id ?? "module-created", ...input });
      },
      promoteParameterModule: async (id, options) => {
        calls.push({ method: "promote", id, options });
        return parameterModule({ id, status: "active", promotedAt: "2026-06-18T15:00:00.000Z" });
      },
      getParameterSnapshot: async (options) => {
        calls.push({ method: "snapshot", options });
        return {
          generatedAt: "2026-06-18T15:00:00.000Z",
          baseModelParams: 4_000_000_000,
          adapterParams: 12_000_000,
          routerParams: 0,
          specialistParams: 0,
          expertParams: 775_358,
          otherParams: 0,
          totalSystemParams: 4_012_775_358,
          stagedParams: 0,
          activeParamsPerRequest: 4_012_775_358,
          activeModuleIds: ["base-1", "adapter-1", "module-1"],
          stagedModuleIds: [],
          selectedModuleIds: options?.selectedModuleIds ?? [],
        };
      },
    });

    const list = await app.inject({
      method: "GET",
      url: "/learning/parameter-modules?kind=expert&status=active&limit=10",
    });
    const created = await app.inject({
      method: "POST",
      url: "/learning/parameter-modules",
      payload: {
        id: "module-1",
        name: "tool expert v1",
        kind: "expert",
        parameters: 775_358,
        activeParameters: 775_358,
        status: "staged",
        route: "ping",
        sourceLearningItemIds: ["learned-1"],
        metadata: { toolName: "ping" },
      },
    });
    const promoted = await app.inject({
      method: "POST",
      url: "/learning/parameter-modules/module-1/promote",
      payload: {
        gateStatus: "pass",
        evalReport: { kind: "skill", path: "training/evals/skill.report.json", status: "pass" },
      },
    });
    const snapshot = await app.inject({
      method: "GET",
      url: "/learning/parameter-snapshot?selectedModuleIds=module-1,adapter-1",
    });

    expect(list.statusCode).toBe(200);
    expect(created.statusCode).toBe(201);
    expect(promoted.statusCode).toBe(200);
    expect(snapshot.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ count: 1, modules: [{ id: "module-1", kind: "expert" }] });
    expect(created.json()).toMatchObject({
      id: "module-1",
      name: "tool expert v1",
      kind: "expert",
      parameters: 775_358,
      route: "ping",
    });
    expect(promoted.json()).toMatchObject({ id: "module-1", status: "active" });
    expect(snapshot.json()).toMatchObject({
      totalSystemParams: 4_012_775_358,
      selectedModuleIds: ["module-1", "adapter-1"],
    });
    expect(calls).toMatchObject([
      { method: "list", filter: { kind: "expert", status: "active", limit: 10 } },
      {
        method: "create",
        input: {
          id: "module-1",
          name: "tool expert v1",
          kind: "expert",
          parameters: 775_358,
          route: "ping",
          sourceLearningItemIds: ["learned-1"],
          metadata: { toolName: "ping" },
        },
      },
      {
        method: "promote",
        id: "module-1",
        options: { gateStatus: "pass", evalReport: { kind: "skill", path: "training/evals/skill.report.json", status: "pass" } },
      },
      { method: "snapshot", options: { selectedModuleIds: ["module-1", "adapter-1"] } },
    ]);
    await app.close();
  });

  it("stages parameter modules from a verified staging manifest", async () => {
    const app = Fastify({ logger: false });
    const calls: unknown[] = [];
    registerLearningRoutes(app, {
      getStats: null,
      stageParameterModuleFromManifest: async (input) => {
        calls.push(input);
        return {
          module: parameterModule({
            id: input.id ?? "module-created",
            name: "ping_tool_expert",
            kind: "expert",
            route: "ping",
            status: "staged",
            rollbackTargetId: "active-module-before-ping-expert",
          }),
          gateReport: {
            status: "pass",
            manifestPath: input.manifestPath,
            generatedAt: "2026-06-18T21:00:00.000Z",
            summary: {
              moduleName: "ping_tool_expert",
              kind: "expert",
              route: "ping",
              parameters: 2_000_000,
              activeParameters: 500_000,
              trainableParameters: 2_000_000,
              artifacts: 2,
              evalReports: 6,
              sourceLearningItems: 2,
              requiredEvalKinds: ["dataset_quality", "parameter_growth", "training_report", "contamination", "skill", "protocol"],
              requiredArtifactKinds: ["checkpoint", "config"],
              datasetManifestPath: "training/data/parameter-growth/plan-1/manifest.json",
            },
            checks: [],
          },
        };
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/learning/parameter-modules/stage-from-manifest",
      payload: {
        id: "module-from-manifest",
        manifestPath: "training/runs/parameter-modules/run-1/staging-manifest.json",
        maxParameters: 5_000_000,
        requiredEvalKinds: ["skill", "protocol"],
        requiredArtifactKinds: ["checkpoint", "config"],
        requireEvalReportHashes: true,
        verifyDatasetFiles: true,
        metadata: { operator: "admin-1" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      module: {
        id: "module-from-manifest",
        name: "ping_tool_expert",
        kind: "expert",
        status: "staged",
      },
      gateReport: { status: "pass" },
    });
    expect(calls).toEqual([
      {
        id: "module-from-manifest",
        manifestPath: "training/runs/parameter-modules/run-1/staging-manifest.json",
        gateOptions: {
          maxParameters: 5_000_000,
          requiredEvalKinds: ["skill", "protocol"],
          requiredArtifactKinds: ["checkpoint", "config"],
          requireEvalReportHashes: true,
          verifyDatasetFiles: true,
        },
        metadata: { operator: "admin-1" },
      },
    ]);
    await app.close();
  });

  it("applies a parameter hotload manifest through the configured service", async () => {
    const app = Fastify({ logger: false });
    const calls: unknown[] = [];
    registerLearningRoutes(app, {
      getStats: null,
      applyParameterHotloadManifest: async (input) => {
        calls.push(input);
        return {
          status: "dry_run",
          manifestPath: input.manifestPath,
          manifestId: "parameter-hotload-fixture",
          generatedAt: "2026-06-18T22:15:00.000Z",
          dryRun: input.dryRun ?? false,
          requestId: input.requestId ?? "generated-request",
          summary: {
            manifestStatus: "ready",
            loadRequests: 1,
            skippedModules: 0,
            artifacts: 2,
            totalLoadedParameters: 2_000_000,
            activeParametersPerRequest: 500_000,
          },
          qualityReport: {
            status: "pass",
            manifestPath: input.manifestPath,
            generatedAt: "2026-06-18T22:15:00.000Z",
            summary: {
              manifestStatus: "ready",
              loadRequests: 1,
              skippedModules: 0,
              artifacts: 2,
              totalLoadedParameters: 2_000_000,
              activeParametersPerRequest: 500_000,
            },
            checks: [],
          },
        };
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/learning/parameter-hotload/apply",
      payload: {
        manifestPath: "training/plans/parameter-hotload/latest.json",
        dryRun: true,
        requestId: "api-hotload-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "dry_run",
      manifestPath: "training/plans/parameter-hotload/latest.json",
      requestId: "api-hotload-1",
    });
    expect(calls).toEqual([
      {
        manifestPath: "training/plans/parameter-hotload/latest.json",
        dryRun: true,
        requestId: "api-hotload-1",
      },
    ]);
    await app.close();
  });

  it("reports blocked hotload manifests without applying them", async () => {
    const app = Fastify({ logger: false });
    registerLearningRoutes(app, {
      getStats: null,
      applyParameterHotloadManifest: async (input) => ({
        status: "blocked",
        manifestPath: input.manifestPath,
        generatedAt: "2026-06-18T22:15:00.000Z",
        dryRun: input.dryRun ?? false,
        requestId: input.requestId ?? "generated-request",
        summary: {
          manifestStatus: "blocked",
          loadRequests: 0,
          skippedModules: 1,
          artifacts: 0,
          totalLoadedParameters: 0,
          activeParametersPerRequest: 0,
        },
        qualityReport: {
          status: "fail",
          manifestPath: input.manifestPath,
          generatedAt: "2026-06-18T22:15:00.000Z",
          summary: {
            manifestStatus: "blocked",
            loadRequests: 0,
            skippedModules: 1,
            artifacts: 0,
            totalLoadedParameters: 0,
            activeParametersPerRequest: 0,
          },
          checks: [{ id: "loader-ready-status", status: "fail", summary: "blocked" }],
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/learning/parameter-hotload/apply",
      payload: { manifestPath: "training/plans/parameter-hotload/latest.json" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      status: "blocked",
      qualityReport: { checks: [{ id: "loader-ready-status", status: "fail" }] },
    });
    await app.close();
  });

  it("reports staging gate failures without creating a parameter module", async () => {
    const app = Fastify({ logger: false });
    registerLearningRoutes(app, {
      getStats: null,
      stageParameterModuleFromManifest: async () => {
        throw new Error("parameter module staging gate failed: required-eval:skill");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/learning/parameter-modules/stage-from-manifest",
      payload: { manifestPath: "training/runs/parameter-modules/run-1/staging-manifest.json" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "parameter module cannot be changed",
      reason: expect.stringContaining("staging gate failed"),
    });
    await app.close();
  });

  it("reports parameter promotion gate failures without activating the module", async () => {
    const app = Fastify({ logger: false });
    registerLearningRoutes(app, {
      getStats: null,
      promoteParameterModule: async () => {
        throw new Error("parameter module module-1 cannot be promoted without passing gates");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/learning/parameter-modules/module-1/promote",
      payload: { gateStatus: "fail" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "parameter module cannot be changed",
      reason: expect.stringContaining("cannot be promoted"),
    });
    await app.close();
  });
});

function learnedItem(overrides: Partial<LearnedItem> = {}): LearnedItem {
  return {
    id: "learned-1",
    kind: "skill",
    content: "Skill candidate",
    source: "tool_success",
    confidence: 0.8,
    reviewStatus: "candidate",
    accessPaths: ["skill_registry"],
    provenance: {},
    retention: { canRetrieve: true, canTrain: true },
    training: { status: "not_queued" },
    parameterModuleIds: [],
    createdAt: "2026-06-18T15:00:00.000Z",
    updatedAt: "2026-06-18T15:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function parameterModule(overrides: Partial<ParameterModule> = {}): ParameterModule {
  return {
    id: "module-1",
    name: "module",
    kind: "adapter",
    parameters: 12_000_000,
    activeParameters: 12_000_000,
    trainableParameters: 12_000_000,
    status: "staged",
    datasetHashes: [],
    evalReports: [],
    sourceLearningItemIds: [],
    createdAt: "2026-06-18T15:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}
