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
import type {
  ApplyParameterModuleHotloadInput,
  ParameterModuleHotloadApplyReport,
} from "../../learning/ParameterModuleHotloadService";
import {
  PARAMETER_MODULE_STAGING_EVAL_KINDS,
  type ParameterModuleStagingEvalKind,
} from "../../training/parameter/ParameterModuleStagingGate";
import {
  applyParameterGrowthPlanGate,
  type ParameterGrowthGateResult,
  type ParameterGrowthGateThresholds,
} from "../../training/parameter/ParameterGrowthPlanGate";
import type {
  ParameterGrowthPlan,
  ParameterGrowthPlannerOptions,
  WrittenParameterGrowthPlan,
} from "../../training/parameter/ParameterGrowthPlanner";
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
  buildParameterGrowthPlan?: ((options?: ParameterGrowthPlannerOptions) => Promise<ParameterGrowthPlan>) | null;
  writeParameterGrowthPlan?: ((
    outDir: string,
    options?: ParameterGrowthPlannerOptions,
  ) => Promise<WrittenParameterGrowthPlan>) | null;
  applyParameterHotloadManifest?: ((
    input: ApplyParameterModuleHotloadInput,
  ) => Promise<ParameterModuleHotloadApplyReport>) | null;
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
const trainableGrowthKindSettingsSchema = z
  .object({
    adapter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    router: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    specialist: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    expert: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

const listQuerySchema = z.object({
  kind: kindSchema.optional(),
  reviewStatus: reviewStatusSchema.optional(),
  trainingStatus: trainingStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const batchFilterSchema = z
  .object({
    kind: kindSchema.optional(),
    reviewStatus: reviewStatusSchema.optional(),
    trainingStatus: trainingStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

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

const batchReviewBodySchema = z
  .object({
    ids: z.array(z.string().trim().min(1).max(256)).min(1).max(200).optional(),
    filter: batchFilterSchema.optional(),
    reviewStatus: reviewStatusSchema.optional(),
    reviewerId: z.string().trim().min(1).max(256).nullable().optional(),
    reviewReason: z.string().trim().max(2_000).nullable().optional(),
    queue: z.boolean().optional(),
    datasetId: z.string().trim().min(1).max(256).optional(),
    queueReason: z.string().trim().max(2_000).optional(),
    force: z.boolean().optional(),
    autoQueueConfidence: z.number().min(0).max(1).optional(),
    dryRun: z.boolean().optional(),
    execute: z.boolean().optional(),
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

const applyParameterHotloadBodySchema = z
  .object({
    manifestPath: z.string().trim().min(1).max(2_048),
    dryRun: z.boolean().optional(),
    requestId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

const parameterGrowthPlanBodySchema = z
  .object({
    outDir: z.string().trim().min(1).max(2_048).optional(),
    limit: z.number().int().min(1).max(5_000).optional(),
    minItems: z.number().int().positive().max(5_000).optional(),
    minItemsByKind: trainableGrowthKindSettingsSchema.optional(),
    parameterBudgets: trainableGrowthKindSettingsSchema.optional(),
    gate: z
      .object({
        minReadyBatches: z.number().int().nonnegative().max(1_000).optional(),
        minRecordsPerReadyBatch: z.number().int().nonnegative().max(10_000).optional(),
        maxEstimatedNewParameters: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        allowRiskReview: z.boolean().optional(),
        requiredGates: z.array(z.string().trim().min(1).max(128)).min(1).max(50).optional(),
      })
      .strict()
      .optional(),
    execute: z.boolean().optional(),
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

  app.post("/learning/items/batch-review", async (request, reply) => {
    const body = batchReviewBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: "invalid batch review payload", details: body.error.flatten() });
    }
    if (!body.data.ids && !body.data.filter) {
      return reply.status(400).send({ error: "batch review requires ids or filter" });
    }
    if (!body.data.reviewStatus && !body.data.queue) {
      return reply.status(400).send({ error: "batch review requires reviewStatus or queue=true" });
    }
    if (body.data.ids && !deps.getLearnedItem) {
      return reply.status(503).send({ error: "live learning item lookup disabled" });
    }
    if (!body.data.ids && !deps.listLearnedItems) {
      return reply.status(503).send({ error: "live learning persistence disabled" });
    }
    const dryRun = body.data.execute ? false : body.data.dryRun ?? true;
    if (!dryRun && body.data.reviewStatus && !deps.markReviewed) {
      return reply.status(503).send({ error: "live learning review disabled" });
    }
    if (!dryRun && body.data.queue && !deps.queueForTraining) {
      return reply.status(503).send({ error: "live learning training queue disabled" });
    }

    const selected = await selectBatchReviewItems(deps, body.data.ids, body.data.filter);
    const report = await applyBatchReview({
      items: selected.items,
      missingIds: selected.missingIds,
      input: body.data,
      dryRun,
      markReviewed: deps.markReviewed ?? null,
      queueForTraining: deps.queueForTraining ?? null,
    });
    return report;
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

  app.post("/learning/parameter-growth/plan", async (request, reply) => {
    const body = parameterGrowthPlanBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: "invalid parameter growth plan payload", details: body.error.flatten() });
    }
    const execute = body.data.execute ?? false;
    if (execute && !deps.writeParameterGrowthPlan) {
      return reply.status(503).send({ error: "parameter growth plan writer disabled" });
    }
    if (!execute && !deps.buildParameterGrowthPlan) {
      return reply.status(503).send({ error: "parameter growth planner disabled" });
    }

    const plannerOptions = toParameterGrowthPlannerOptions(body.data);
    const written = execute
      ? await deps.writeParameterGrowthPlan!(body.data.outDir ?? "training/plans/parameter-growth", plannerOptions)
      : undefined;
    const plan = written?.plan ?? (await deps.buildParameterGrowthPlan!(plannerOptions));
    const gateReport = applyParameterGrowthPlanGate({ plan, thresholds: toParameterGrowthGateThresholds(body.data.gate) });
    return {
      runtimeContract: "parameter-growth-plan-run-v1",
      status: execute ? "written" : "planned",
      generatedAt: new Date().toISOString(),
      dryRun: !execute,
      ...(written ? { path: written.path, latestPath: written.latestPath } : {}),
      plan,
      gateReport,
      nextActions: parameterGrowthPlanNextActions(plan, gateReport, Boolean(written)),
    };
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

  app.post("/learning/parameter-hotload/apply", async (request, reply) => {
    if (!deps.applyParameterHotloadManifest) {
      return reply.status(503).send({ error: "parameter hotload service disabled" });
    }
    const body = applyParameterHotloadBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: "invalid parameter hotload payload", details: body.error.flatten() });
    }
    try {
      const result = await deps.applyParameterHotloadManifest(body.data);
      const statusCode = result.status === "blocked" || result.status === "failed" ? 409 : 200;
      return reply.status(statusCode).send(result);
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

type BatchReviewInput = z.infer<typeof batchReviewBodySchema>;
type BatchReviewFilter = z.infer<typeof batchFilterSchema>;

interface BatchReviewSelection {
  items: LearnedItem[];
  missingIds: string[];
}

interface BatchReviewMutation {
  id: string;
  status?: LearningReviewStatus;
  trainingStatus?: TrainingPromotionStatus;
}

interface BatchReviewSkip {
  id: string;
  operation: "review" | "queue";
  reason: string;
}

interface BatchReviewError {
  id: string;
  operation: "review" | "queue";
  reason: string;
}

async function selectBatchReviewItems(
  deps: LearningRouteDeps,
  ids: string[] | undefined,
  filter: BatchReviewFilter | undefined,
): Promise<BatchReviewSelection> {
  if (ids) {
    const items: LearnedItem[] = [];
    const missingIds: string[] = [];
    for (const id of unique(ids)) {
      const item = await deps.getLearnedItem!(id);
      if (item) items.push(item);
      else missingIds.push(id);
    }
    return { items, missingIds };
  }
  return { items: await deps.listLearnedItems!(filter), missingIds: [] };
}

async function applyBatchReview(options: {
  items: LearnedItem[];
  missingIds: string[];
  input: BatchReviewInput;
  dryRun: boolean;
  markReviewed: LearningRouteDeps["markReviewed"];
  queueForTraining: LearningRouteDeps["queueForTraining"];
}): Promise<{
  runtimeContract: "learning-batch-review-v1";
  status: "dry_run" | "applied" | "partial" | "blocked" | "empty";
  generatedAt: string;
  dryRun: boolean;
  selector: { ids?: string[]; filter?: BatchReviewFilter };
  requested: {
    reviewStatus?: LearningReviewStatus;
    queue: boolean;
    datasetId?: string;
    force: boolean;
    autoQueueConfidence: number;
  };
  summary: {
    matched: number;
    missing: number;
    reviewed: number;
    queued: number;
    skipped: number;
    errors: number;
  };
  matchedItemIds: string[];
  missingIds: string[];
  reviewed: BatchReviewMutation[];
  queued: BatchReviewMutation[];
  skipped: BatchReviewSkip[];
  errors: BatchReviewError[];
}> {
  const reviewed: BatchReviewMutation[] = [];
  const queued: BatchReviewMutation[] = [];
  const skipped: BatchReviewSkip[] = options.missingIds.map((id) => ({
    id,
    operation: "review",
    reason: "learning item not found",
  }));
  const errors: BatchReviewError[] = [];
  const autoQueueConfidence = options.input.autoQueueConfidence ?? 0.92;

  for (const initialItem of options.items) {
    let item = initialItem;
    let reviewFailed = false;
    if (options.input.reviewStatus) {
      if (options.dryRun) {
        reviewed.push({ id: item.id, status: options.input.reviewStatus });
        item = { ...item, reviewStatus: options.input.reviewStatus };
      } else {
        try {
          item = await options.markReviewed!(item.id, options.input.reviewStatus, {
            reviewerId: options.input.reviewerId ?? null,
            reason: options.input.reviewReason ?? null,
          });
          reviewed.push({ id: item.id, status: item.reviewStatus });
        } catch (err) {
          reviewFailed = true;
          errors.push({ id: item.id, operation: "review", reason: errorMessage(err) });
        }
      }
    }

    if (!options.input.queue || reviewFailed) continue;

    const queueSkipReason = queueSkipReasonFor(item, {
      force: options.input.force ?? false,
      autoQueueConfidence,
    });
    if (queueSkipReason) {
      skipped.push({ id: item.id, operation: "queue", reason: queueSkipReason });
      continue;
    }

    if (options.dryRun) {
      queued.push({ id: item.id, trainingStatus: "queued" });
      continue;
    }

    try {
      const queuedItem = await options.queueForTraining!(item.id, {
        ...(options.input.datasetId ? { datasetId: options.input.datasetId } : {}),
        ...(options.input.queueReason ? { reason: options.input.queueReason } : {}),
        ...(options.input.force !== undefined ? { force: options.input.force } : {}),
        ...(options.input.autoQueueConfidence !== undefined ? { autoQueueConfidence } : {}),
      });
      queued.push({ id: queuedItem.id, trainingStatus: queuedItem.training.status });
    } catch (err) {
      errors.push({ id: item.id, operation: "queue", reason: errorMessage(err) });
    }
  }

  const matched = options.items.length;
  const mutating = reviewed.length + queued.length;
  const blocked = matched > 0 && mutating === 0 && skipped.length + errors.length > 0;
  const status =
    matched === 0 && options.missingIds.length === 0
      ? "empty"
      : options.dryRun
        ? "dry_run"
        : blocked
          ? "blocked"
          : skipped.length > 0 || errors.length > 0
            ? "partial"
            : "applied";
  return {
    runtimeContract: "learning-batch-review-v1",
    status,
    generatedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    selector: {
      ...(options.input.ids ? { ids: unique(options.input.ids) } : {}),
      ...(options.input.filter ? { filter: options.input.filter } : {}),
    },
    requested: {
      ...(options.input.reviewStatus ? { reviewStatus: options.input.reviewStatus } : {}),
      queue: options.input.queue ?? false,
      ...(options.input.datasetId ? { datasetId: options.input.datasetId } : {}),
      force: options.input.force ?? false,
      autoQueueConfidence,
    },
    summary: {
      matched,
      missing: options.missingIds.length,
      reviewed: reviewed.length,
      queued: queued.length,
      skipped: skipped.length,
      errors: errors.length,
    },
    matchedItemIds: options.items.map((item) => item.id),
    missingIds: options.missingIds,
    reviewed,
    queued,
    skipped,
    errors,
  };
}

function queueSkipReasonFor(
  item: LearnedItem,
  options: { force: boolean; autoQueueConfidence: number },
): string | null {
  if (!item.retention.canTrain && !options.force) return "retention policy does not allow training";
  if (item.reviewStatus === "rejected") return "learning item was rejected";
  if (!options.force && item.reviewStatus !== "approved" && item.confidence < options.autoQueueConfidence) {
    return "learning item is not approved or high-confidence enough for training";
  }
  return null;
}

type ParameterGrowthPlanBody = z.infer<typeof parameterGrowthPlanBodySchema>;
type ParameterGrowthGateBody = NonNullable<ParameterGrowthPlanBody["gate"]>;

function toParameterGrowthPlannerOptions(input: ParameterGrowthPlanBody): ParameterGrowthPlannerOptions {
  const minItemsByKind = input.minItems
    ? {
        adapter: input.minItems,
        router: input.minItems,
        specialist: input.minItems,
        expert: input.minItems,
      }
    : stripUndefined(input.minItemsByKind);
  return {
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(minItemsByKind ? { minItemsByKind } : {}),
    ...(input.parameterBudgets ? { parameterBudgets: stripUndefined(input.parameterBudgets) } : {}),
  };
}

function toParameterGrowthGateThresholds(input: ParameterGrowthGateBody | undefined): Partial<ParameterGrowthGateThresholds> {
  if (!input) return {};
  return {
    ...(input.minReadyBatches !== undefined ? { minReadyBatches: input.minReadyBatches } : {}),
    ...(input.minRecordsPerReadyBatch !== undefined ? { minRecordsPerReadyBatch: input.minRecordsPerReadyBatch } : {}),
    ...(input.maxEstimatedNewParameters !== undefined ? { maxEstimatedNewParameters: input.maxEstimatedNewParameters } : {}),
    ...(input.allowRiskReview !== undefined ? { requireRiskReview: !input.allowRiskReview } : {}),
    ...(input.requiredGates ? { requiredGateRequirements: input.requiredGates } : {}),
  };
}

function parameterGrowthPlanNextActions(
  plan: ParameterGrowthPlan,
  gateReport: ParameterGrowthGateResult,
  written: boolean,
): string[] {
  if (gateReport.status !== "pass") {
    return [
      "review gate failures before building parameter-growth datasets",
      "batch-review and queue more approved trainable learned items if the plan needs more data",
    ];
  }
  return written
    ? [
        "run npm run build:parameter-growth-data against the written latest plan",
        "run npm run check:parameter-growth-data before dispatching trainer compute",
      ]
    : [
        "rerun with execute:true to write the parameter-growth plan",
        "then build and check parameter-growth data before trainer dispatch",
      ];
}

function stripUndefined<T extends Record<string, unknown>>(value: T | undefined): Partial<T> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, Exclude<T[keyof T], undefined>] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) as Partial<T> : undefined;
}

function parameterMutationError(reply: FastifyReply, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(message)) return reply.status(404).send({ error: "parameter module not found" });
  if (
    /already exists|not staged|cannot be promoted|passing gates|staging gate failed|staging manifest|hotload loader/i.test(message)
  ) {
    return reply.status(409).send({ error: "parameter module cannot be changed", reason: message });
  }
  throw err;
}

function asJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (json && typeof json === "object" && !Array.isArray(json)) return json as JsonObject;
  return {};
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
