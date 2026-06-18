import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type {
  LearnedItem,
  LearningKind,
  LearningReviewStatus,
  ParameterEvalReport,
  ParameterGrowthSnapshot,
  ParameterModule,
  ParameterModuleKind,
  ParameterModuleStatus,
  TrainingPromotionStatus,
} from "../../learning/LiveLearningRegistry";
import type {
  StageParameterModuleFromManifestInput,
  StageParameterModuleFromManifestResult,
} from "../../learning/ParameterModuleStagingService";
import {
  PARAMETER_MODULE_STAGING_EVAL_KINDS,
  type ParameterModuleStagingEvalKind,
} from "../../training/parameter/ParameterModuleStagingGate";
import { toJsonValue, type JsonObject, type LearningStatsPayload } from "../../types/common";

export interface LearningRouteDeps {
  getStats: (() => Promise<LearningStatsPayload>) | null;
  listLearnedItems?: ((filter?: {
    kind?: LearningKind;
    reviewStatus?: LearningReviewStatus;
    trainingStatus?: TrainingPromotionStatus;
    limit?: number;
  }) => Promise<LearnedItem[]>) | null;
  getLearnedItem?: ((id: string) => Promise<LearnedItem | null>) | null;
  markReviewed?: ((
    id: string,
    status: LearningReviewStatus,
    options?: { reviewerId?: string | null; reason?: string | null },
  ) => Promise<LearnedItem>) | null;
  queueForTraining?: ((
    id: string,
    options?: { datasetId?: string; reason?: string; force?: boolean; autoQueueConfidence?: number },
  ) => Promise<LearnedItem>) | null;
  listParameterModules?: ((filter?: {
    kind?: ParameterModuleKind;
    status?: ParameterModuleStatus;
    limit?: number;
  }) => Promise<ParameterModule[]>) | null;
  getParameterModule?: ((id: string) => Promise<ParameterModule | null>) | null;
  createParameterModule?: ((input: {
    id?: string;
    name: string;
    kind: ParameterModuleKind;
    parameters: number;
    activeParameters?: number;
    trainableParameters?: number;
    status?: ParameterModuleStatus;
    baseModuleId?: string;
    route?: string;
    datasetHashes?: string[];
    evalReports?: ParameterEvalReport[];
    sourceLearningItemIds?: string[];
    rollbackTargetId?: string;
    metadata?: JsonObject;
  }) => Promise<ParameterModule>) | null;
  stageParameterModuleFromManifest?: ((
    input: StageParameterModuleFromManifestInput,
  ) => Promise<StageParameterModuleFromManifestResult>) | null;
  promoteParameterModule?: ((
    id: string,
    options: { gateStatus: "pass" | "fail" | "warn"; evalReport?: ParameterEvalReport },
  ) => Promise<ParameterModule>) | null;
  retireParameterModule?: ((id: string) => Promise<ParameterModule>) | null;
  getParameterSnapshot?: ((options?: { selectedModuleIds?: string[] }) => Promise<ParameterGrowthSnapshot>) | null;
}

const kindSchema = z.enum(["memory", "skill", "preference", "correction", "eval_failure", "voice_summary", "document"]);
const reviewStatusSchema = z.enum(["candidate", "approved", "rejected"]);
const trainingStatusSchema = z.enum(["not_queued", "queued", "trained", "blocked"]);
const parameterKindSchema = z.enum([
  "base_model",
  "adapter",
  "router",
  "specialist",
  "expert",
  "merged_checkpoint",
  "ensemble_member",
]);
const parameterStatusSchema = z.enum(["staged", "active", "retired", "rejected"]);
const evalReportKindSchema = z.enum([
  "protocol",
  "knowledge",
  "behavior",
  "router",
  "memory",
  "skill",
  "voice",
  "composite",
]);
const stagingEvalKindSchema = z.enum(PARAMETER_MODULE_STAGING_EVAL_KINDS);

const listQuerySchema = z.object({
  kind: kindSchema.optional(),
  reviewStatus: reviewStatusSchema.optional(),
  trainingStatus: trainingStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const parameterModuleQuerySchema = z.object({
  kind: parameterKindSchema.optional(),
  status: parameterStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const parameterSnapshotQuerySchema = z.object({
  selectedModuleIds: z.string().trim().optional(),
});

const idParamsSchema = z.object({
  id: z.string().trim().min(1).max(256),
});

const reviewBodySchema = z
  .object({
    status: reviewStatusSchema,
    reviewerId: z.string().trim().min(1).max(256).nullable().optional(),
    reason: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict();

const queueBodySchema = z
  .object({
    datasetId: z.string().trim().min(1).max(256).optional(),
    reason: z.string().trim().max(2_000).optional(),
    force: z.boolean().optional(),
    autoQueueConfidence: z.number().min(0).max(1).optional(),
  })
  .strict();

const evalReportSchema = z
  .object({
    kind: evalReportKindSchema,
    path: z.string().trim().min(1).max(1_024),
    status: z.enum(["pass", "fail", "warn"]),
    summary: z.string().trim().max(2_000).optional(),
  })
  .strict();

const createParameterModuleBodySchema = z
  .object({
    id: z.string().trim().min(1).max(256).optional(),
    name: z.string().trim().min(1).max(256),
    kind: parameterKindSchema,
    parameters: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    activeParameters: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    trainableParameters: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    status: parameterStatusSchema.optional(),
    baseModuleId: z.string().trim().min(1).max(256).optional(),
    route: z.string().trim().min(1).max(256).optional(),
    datasetHashes: z.array(z.string().trim().min(1).max(256)).max(200).optional(),
    evalReports: z.array(evalReportSchema).max(50).optional(),
    sourceLearningItemIds: z.array(z.string().trim().min(1).max(256)).max(500).optional(),
    rollbackTargetId: z.string().trim().min(1).max(256).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const stageParameterModuleBodySchema = z
  .object({
    id: z.string().trim().min(1).max(256).optional(),
    manifestPath: z.string().trim().min(1).max(2_048),
    maxParameters: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    requiredEvalKinds: z.array(stagingEvalKindSchema).min(1).max(20).optional(),
    requiredArtifactKinds: z.array(z.string().trim().min(1).max(128)).min(1).max(20).optional(),
    requireEvalReportHashes: z.boolean().optional(),
    verifyDatasetFiles: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const promoteParameterModuleBodySchema = z
  .object({
    gateStatus: z.enum(["pass", "fail", "warn"]),
    evalReport: evalReportSchema.optional(),
  })
  .strict();

export function registerLearningRoutes(app: FastifyInstance, deps: LearningRouteDeps): void {
  app.get("/learning/status", async (_request, reply) => {
    if (!deps.getStats) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    return deps.getStats();
  });

  app.get("/learning/items", async (request, reply) => {
    if (!deps.listLearnedItems) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid learning item query", details: parsed.error.flatten() });
    }
    const items = await deps.listLearnedItems(parsed.data);
    return { count: items.length, items };
  });

  app.get("/learning/items/:id", async (request, reply) => {
    if (!deps.getLearnedItem) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid learning item id", details: parsed.error.flatten() });
    }
    const item = await deps.getLearnedItem(parsed.data.id);
    if (!item) return reply.status(404).send({ error: "learning item not found" });
    return item;
  });

  app.post("/learning/items/:id/review", async (request, reply) => {
    if (!deps.markReviewed) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const params = idParamsSchema.safeParse(request.params);
    const body = reviewBodySchema.safeParse(request.body ?? {});
    if (!params.success) {
      return reply.status(400).send({ error: "invalid learning item id", details: params.error.flatten() });
    }
    if (!body.success) {
      return reply.status(400).send({ error: "invalid review payload", details: body.error.flatten() });
    }
    try {
      const item = await deps.markReviewed(params.data.id, body.data.status, {
        reviewerId: body.data.reviewerId ?? null,
        reason: body.data.reason ?? null,
      });
      return item;
    } catch (err) {
      return learningMutationError(reply, err);
    }
  });

  app.post("/learning/items/:id/queue", async (request, reply) => {
    if (!deps.queueForTraining) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const params = idParamsSchema.safeParse(request.params);
    const body = queueBodySchema.safeParse(request.body ?? {});
    if (!params.success) {
      return reply.status(400).send({ error: "invalid learning item id", details: params.error.flatten() });
    }
    if (!body.success) {
      return reply.status(400).send({ error: "invalid queue payload", details: body.error.flatten() });
    }
    try {
      const item = await deps.queueForTraining(params.data.id, body.data);
      return item;
    } catch (err) {
      return learningMutationError(reply, err);
    }
  });

  app.get("/learning/parameter-snapshot", async (request, reply) => {
    if (!deps.getParameterSnapshot) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const parsed = parameterSnapshotQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid parameter snapshot query", details: parsed.error.flatten() });
    }
    const selectedModuleIds = parsed.data.selectedModuleIds
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    return deps.getParameterSnapshot(selectedModuleIds?.length ? { selectedModuleIds } : undefined);
  });

  app.get("/learning/parameter-modules", async (request, reply) => {
    if (!deps.listParameterModules) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const parsed = parameterModuleQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid parameter module query", details: parsed.error.flatten() });
    }
    const modules = await deps.listParameterModules(parsed.data);
    return { count: modules.length, modules };
  });

  app.post("/learning/parameter-modules", async (request, reply) => {
    if (!deps.createParameterModule) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const body = createParameterModuleBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: "invalid parameter module payload", details: body.error.flatten() });
    }
    try {
      const { metadata, ...input } = body.data;
      const module = await deps.createParameterModule({
        ...input,
        ...(metadata ? { metadata: asJsonObject(metadata) } : {}),
      });
      return reply.status(201).send(module);
    } catch (err) {
      return parameterMutationError(reply, err);
    }
  });

  app.post("/learning/parameter-modules/stage-from-manifest", async (request, reply) => {
    if (!deps.stageParameterModuleFromManifest) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const body = stageParameterModuleBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: "invalid parameter module staging payload", details: body.error.flatten() });
    }
    try {
      const {
        id,
        manifestPath,
        maxParameters,
        requiredEvalKinds,
        requiredArtifactKinds,
        requireEvalReportHashes,
        verifyDatasetFiles,
        metadata,
      } = body.data;
      const gateOptions = {
        ...(maxParameters ? { maxParameters } : {}),
        ...(requiredEvalKinds ? { requiredEvalKinds: requiredEvalKinds as ParameterModuleStagingEvalKind[] } : {}),
        ...(requiredArtifactKinds ? { requiredArtifactKinds } : {}),
        ...(requireEvalReportHashes !== undefined ? { requireEvalReportHashes } : {}),
        ...(verifyDatasetFiles !== undefined ? { verifyDatasetFiles } : {}),
      };
      const result = await deps.stageParameterModuleFromManifest({
        ...(id ? { id } : {}),
        manifestPath,
        ...(Object.keys(gateOptions).length > 0 ? { gateOptions } : {}),
        ...(metadata ? { metadata: asJsonObject(metadata) } : {}),
      });
      return reply.status(201).send(result);
    } catch (err) {
      return parameterMutationError(reply, err);
    }
  });

  app.get("/learning/parameter-modules/:id", async (request, reply) => {
    if (!deps.getParameterModule) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid parameter module id", details: parsed.error.flatten() });
    }
    const module = await deps.getParameterModule(parsed.data.id);
    if (!module) return reply.status(404).send({ error: "parameter module not found" });
    return module;
  });

  app.post("/learning/parameter-modules/:id/promote", async (request, reply) => {
    if (!deps.promoteParameterModule) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const params = idParamsSchema.safeParse(request.params);
    const body = promoteParameterModuleBodySchema.safeParse(request.body ?? {});
    if (!params.success) {
      return reply.status(400).send({ error: "invalid parameter module id", details: params.error.flatten() });
    }
    if (!body.success) {
      return reply.status(400).send({ error: "invalid parameter module promotion payload", details: body.error.flatten() });
    }
    try {
      return await deps.promoteParameterModule(params.data.id, body.data);
    } catch (err) {
      return parameterMutationError(reply, err);
    }
  });

  app.post("/learning/parameter-modules/:id/retire", async (request, reply) => {
    if (!deps.retireParameterModule) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid parameter module id", details: params.error.flatten() });
    }
    try {
      return await deps.retireParameterModule(params.data.id);
    } catch (err) {
      return parameterMutationError(reply, err);
    }
  });
}

function learningMutationError(reply: FastifyReply, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(message)) return reply.status(404).send({ error: "learning item not found" });
  if (/not allowed|rejected|not approved|high-confidence/i.test(message)) {
    return reply.status(409).send({ error: "learning item cannot be queued", reason: message });
  }
  throw err;
}

function parameterMutationError(reply: FastifyReply, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(message)) return reply.status(404).send({ error: "parameter module not found" });
  if (/already exists|not staged|cannot be promoted|passing gates|staging gate failed|staging manifest/i.test(message)) {
    return reply.status(409).send({ error: "parameter module cannot be changed", reason: message });
  }
  throw err;
}

function asJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (json && typeof json === "object" && !Array.isArray(json)) return json as JsonObject;
  return {};
}
