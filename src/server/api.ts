import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { HealthPayload, StatsPayload } from "../types/common";
import type { ToolRegistry } from "../tools/ToolRegistry";
import { registerHealthRoutes } from "./routes/health";
import { registerToolRoutes } from "./routes/tools";
import { registerMemoryRoutes, type MemoryRouteDeps } from "./routes/memory";
import { registerTrainingRoutes, type TrainingRouteDeps } from "./routes/training";
import { registerLearningRoutes, type LearningRouteDeps } from "./routes/learning";

/**
 * Operational HTTP API (health, tool catalog, memory search, training
 * export, stats). NOTE: unauthenticated — bind it to localhost/private
 * networks only, or add auth before exposing (documented in
 * docs/DEPLOYMENT.md).
 */

export interface ApiDeps {
  registry: ToolRegistry;
  memory: MemoryRouteDeps["search"];
  learningStats?: LearningRouteDeps["getStats"];
  exporter: TrainingRouteDeps["exportAll"];
  recordFeedbackPreference?: TrainingRouteDeps["recordFeedbackPreference"];
  getHealth: () => Promise<HealthPayload>;
  getStats: () => Promise<StatsPayload>;
  logger: Logger;
}

export function buildApiServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error: Error, _request, reply) => {
    deps.logger.error({ err: error.message }, "api error");
    void reply.status(500).send({ error: "internal error" });
  });

  registerHealthRoutes(app, { getHealth: deps.getHealth, getStats: deps.getStats });
  registerToolRoutes(app, deps.registry);
  registerMemoryRoutes(app, { search: deps.memory });
  registerLearningRoutes(app, { getStats: deps.learningStats ?? null });
  registerTrainingRoutes(app, {
    exportAll: deps.exporter,
    recordFeedbackPreference: deps.recordFeedbackPreference,
  });

  return app;
}

export async function startApiServer(
  app: FastifyInstance,
  options: { port: number; host: string },
  logger: Logger,
): Promise<void> {
  await app.listen({ port: options.port, host: options.host });
  logger.info({ port: options.port, host: options.host }, "api server listening");
}
