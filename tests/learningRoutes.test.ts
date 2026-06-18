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
