import { timingSafeEqual } from "node:crypto";
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
 * export, stats). Default bind is loopback. Configure API_AUTH_TOKEN
 * before binding to anything wider than localhost.
 */

export interface ApiDeps {
  registry: ToolRegistry;
  memory: MemoryRouteDeps["search"];
  learningStats?: LearningRouteDeps["getStats"];
  listLearnedItems?: LearningRouteDeps["listLearnedItems"];
  getLearnedItem?: LearningRouteDeps["getLearnedItem"];
  markLearningReviewed?: LearningRouteDeps["markReviewed"];
  queueLearningForTraining?: LearningRouteDeps["queueForTraining"];
  listParameterModules?: LearningRouteDeps["listParameterModules"];
  getParameterModule?: LearningRouteDeps["getParameterModule"];
  createParameterModule?: LearningRouteDeps["createParameterModule"];
  stageParameterModuleFromManifest?: LearningRouteDeps["stageParameterModuleFromManifest"];
  buildParameterGrowthPlan?: LearningRouteDeps["buildParameterGrowthPlan"];
  writeParameterGrowthPlan?: LearningRouteDeps["writeParameterGrowthPlan"];
  buildParameterGrowthDataset?: LearningRouteDeps["buildParameterGrowthDataset"];
  dispatchParameterTraining?: LearningRouteDeps["dispatchParameterTraining"];
  applyParameterHotloadManifest?: LearningRouteDeps["applyParameterHotloadManifest"];
  promoteParameterModule?: LearningRouteDeps["promoteParameterModule"];
  retireParameterModule?: LearningRouteDeps["retireParameterModule"];
  getParameterSnapshot?: LearningRouteDeps["getParameterSnapshot"];
  getIreneStatus?: LearningRouteDeps["getIreneStatus"];
  exporter: TrainingRouteDeps["exportAll"];
  recordFeedbackPreference?: TrainingRouteDeps["recordFeedbackPreference"];
  getHealth: () => Promise<HealthPayload>;
  getStats: () => Promise<StatsPayload>;
  logger: Logger;
  apiAuthToken?: string | null;
}

export function buildApiServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  installApiAuth(app, deps.apiAuthToken ?? null);

  app.setErrorHandler((error: Error, _request, reply) => {
    deps.logger.error({ err: error.message }, "api error");
    void reply.status(500).send({ error: "internal error" });
  });

  registerHealthRoutes(app, { getHealth: deps.getHealth, getStats: deps.getStats });
  registerToolRoutes(app, deps.registry);
  registerMemoryRoutes(app, { search: deps.memory });
  registerLearningRoutes(app, {
    getStats: deps.learningStats ?? null,
    listLearnedItems: deps.listLearnedItems ?? null,
    getLearnedItem: deps.getLearnedItem ?? null,
    markReviewed: deps.markLearningReviewed ?? null,
    queueForTraining: deps.queueLearningForTraining ?? null,
    listParameterModules: deps.listParameterModules ?? null,
    getParameterModule: deps.getParameterModule ?? null,
    createParameterModule: deps.createParameterModule ?? null,
    stageParameterModuleFromManifest: deps.stageParameterModuleFromManifest ?? null,
    buildParameterGrowthPlan: deps.buildParameterGrowthPlan ?? null,
    writeParameterGrowthPlan: deps.writeParameterGrowthPlan ?? null,
    buildParameterGrowthDataset: deps.buildParameterGrowthDataset ?? null,
    dispatchParameterTraining: deps.dispatchParameterTraining ?? null,
    applyParameterHotloadManifest: deps.applyParameterHotloadManifest ?? null,
    promoteParameterModule: deps.promoteParameterModule ?? null,
    retireParameterModule: deps.retireParameterModule ?? null,
    getParameterSnapshot: deps.getParameterSnapshot ?? null,
    getIreneStatus: deps.getIreneStatus ?? null,
  });
  registerTrainingRoutes(app, {
    exportAll: deps.exporter,
    recordFeedbackPreference: deps.recordFeedbackPreference,
  });

  return app;
}

export async function startApiServer(
  app: FastifyInstance,
  options: { port: number; host: string; authToken?: string | null },
  logger: Logger,
): Promise<void> {
  assertApiExposureIsSafe(options);
  await app.listen({ port: options.port, host: options.host });
  logger.info({ port: options.port, host: options.host }, "api server listening");
}

export function assertApiExposureIsSafe(options: { host: string; authToken?: string | null }): void {
  if (isLoopbackHost(options.host) || hasNonEmptyToken(options.authToken)) return;
  throw new Error(
    `Refusing to start unauthenticated API on non-loopback host "${options.host}". Set API_HOST=127.0.0.1 or configure API_AUTH_TOKEN before exposing the API.`,
  );
}

function installApiAuth(app: FastifyInstance, token: string | null): void {
  if (!hasNonEmptyToken(token)) return;
  app.addHook("onRequest", async (request, reply) => {
    if (isPublicApiRoute(request.url)) return;
    const header = request.headers.authorization;
    if (!matchesBearerToken(typeof header === "string" ? header : null, token)) {
      await reply.status(401).send({ error: "unauthorized" });
    }
  });
}

function isPublicApiRoute(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return path === "/health";
}

function matchesBearerToken(header: string | null, expectedToken: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const actual = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hasNonEmptyToken(token: string | null | undefined): token is string {
  return typeof token === "string" && token.length > 0;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}
