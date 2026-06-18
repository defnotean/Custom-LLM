import type { FastifyInstance } from "fastify";
import type { LearningStatsPayload } from "../../types/common";

export interface LearningRouteDeps {
  getStats: (() => Promise<LearningStatsPayload>) | null;
}

export function registerLearningRoutes(app: FastifyInstance, deps: LearningRouteDeps): void {
  app.get("/learning/status", async (_request, reply) => {
    if (!deps.getStats) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    return deps.getStats();
  });
}
