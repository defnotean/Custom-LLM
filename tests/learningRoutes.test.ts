import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerLearningRoutes } from "../src/server/routes/learning";
import type { LearnedItem } from "../src/learning/LiveLearningRegistry";

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
