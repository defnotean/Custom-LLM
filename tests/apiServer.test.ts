import { describe, expect, it } from "vitest";
import { buildApiServer, assertApiExposureIsSafe } from "../src/server/api";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { testLogger } from "./helpers";

describe("API server security", () => {
  it("keeps health public but protects private routes when API auth is configured", async () => {
    const app = buildTestApi("api-secret");

    const health = await app.inject({ method: "GET", url: "/health" });
    const statsWithoutAuth = await app.inject({ method: "GET", url: "/stats" });
    const statsWithWrongAuth = await app.inject({
      method: "GET",
      url: "/stats",
      headers: { authorization: "Bearer wrong" },
    });
    const statsWithAuth = await app.inject({
      method: "GET",
      url: "/stats",
      headers: { authorization: "Bearer api-secret" },
    });
    const toolsWithAuth = await app.inject({
      method: "GET",
      url: "/tools",
      headers: { authorization: "Bearer api-secret" },
    });

    await app.close();

    expect(health.statusCode).toBe(200);
    expect(statsWithoutAuth.statusCode).toBe(401);
    expect(statsWithoutAuth.json()).toEqual({ error: "unauthorized" });
    expect(statsWithWrongAuth.statusCode).toBe(401);
    expect(statsWithAuth.statusCode).toBe(200);
    expect(toolsWithAuth.statusCode).toBe(200);
  });

  it("refuses non-loopback API binding unless auth is configured", () => {
    expect(() => assertApiExposureIsSafe({ host: "127.0.0.1" })).not.toThrow();
    expect(() => assertApiExposureIsSafe({ host: "localhost" })).not.toThrow();
    expect(() => assertApiExposureIsSafe({ host: "0.0.0.0" })).toThrow(/API_AUTH_TOKEN/);
    expect(() => assertApiExposureIsSafe({ host: "0.0.0.0", authToken: "api-secret" })).not.toThrow();
  });
});

function buildTestApi(apiAuthToken?: string) {
  return buildApiServer({
    registry: new ToolRegistry(),
    memory: null,
    exporter: null,
    getHealth: async () => ({
      status: "ok",
      uptimeSec: 1,
      discord: { configured: false, connected: false },
      llm: { provider: "mock", model: "mock", baseUrl: "mock://" },
      database: { available: false },
      runtimeState: { store: "memory", redisConnected: false },
      memory: { enabled: false, store: "memory" },
    }),
    getStats: async () => ({
      uptimeSec: 1,
      registry: { tools: 0, categories: [] },
      llm: { provider: "mock", model: "mock" },
      db: { available: false },
    }),
    logger: testLogger,
    apiAuthToken,
  });
}
