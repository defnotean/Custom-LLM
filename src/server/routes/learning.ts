import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type {
  LearnedItem,
  LearningKind,
  LearningReviewStatus,
  TrainingPromotionStatus,
} from "../../learning/LiveLearningRegistry";
import type { LearningStatsPayload } from "../../types/common";

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
}

const kindSchema = z.enum(["memory", "skill", "preference", "correction", "eval_failure", "voice_summary", "document"]);
const reviewStatusSchema = z.enum(["candidate", "approved", "rejected"]);
const trainingStatusSchema = z.enum(["not_queued", "queued", "trained", "blocked"]);

const listQuerySchema = z.object({
  kind: kindSchema.optional(),
  reviewStatus: reviewStatusSchema.optional(),
  trainingStatus: trainingStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
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
}

function learningMutationError(reply: FastifyReply, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(message)) return reply.status(404).send({ error: "learning item not found" });
  if (/not allowed|rejected|not approved|high-confidence/i.test(message)) {
    return reply.status(409).send({ error: "learning item cannot be queued", reason: message });
  }
  throw err;
}
