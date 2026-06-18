import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerLearningRoutes } from "../src/server/routes/learning";

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
});
