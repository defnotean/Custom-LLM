import type { FastifyInstance } from "fastify";
import type { HealthPayload, StatsPayload } from "../../types/common";

export interface HealthRouteDeps {
  getHealth: () => Promise<HealthPayload>;
  getStats: () => Promise<StatsPayload>;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get("/health", async () => deps.getHealth());
  app.get("/stats", async () => deps.getStats());
}
