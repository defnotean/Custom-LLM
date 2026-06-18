import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExportSummary } from "../../training/DatasetExporter";

export interface TrainingRouteDeps {
  exportAll: ((outDir: string) => Promise<ExportSummary>) | null;
  recordFeedbackPreference?: ((input: FeedbackPreferenceInput) => Promise<string>) | null;
}

export interface FeedbackPreferenceInput {
  conversationId: string;
  userId?: string | null;
  rating?: number | null;
  feedbackText?: string | null;
  preferredResponse: string;
  rejectedResponse: string;
  reviewed?: boolean;
  metadataJson?: Record<string, unknown>;
}

const feedbackPreferenceSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(256),
    userId: z.string().trim().min(1).max(256).nullable().optional(),
    rating: z.number().int().min(-1).max(1).nullable().optional(),
    feedbackText: z.string().trim().max(4_000).nullable().optional(),
    preferredResponse: z.string().trim().min(1).max(20_000),
    rejectedResponse: z.string().trim().min(1).max(20_000),
    reviewed: z.boolean().optional(),
    metadataJson: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((body) => body.preferredResponse !== body.rejectedResponse, {
    message: "preferredResponse and rejectedResponse must differ",
    path: ["rejectedResponse"],
  });

export function registerTrainingRoutes(app: FastifyInstance, deps: TrainingRouteDeps): void {
  app.post("/training/export", async (request, reply) => {
    if (!deps.exportAll) {
      return reply.status(503).send({ error: "training export unavailable (database not connected)" });
    }
    const { outDir } = (request.body ?? {}) as { outDir?: string };
    const summary = await deps.exportAll(outDir ?? "exports/training");
    return summary;
  });

  app.post("/training/feedback/preference", async (request, reply) => {
    if (!deps.recordFeedbackPreference) {
      return reply.status(503).send({ error: "feedback persistence unavailable (database not connected)" });
    }

    const parsed = feedbackPreferenceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid feedback preference", details: parsed.error.flatten() });
    }

    try {
      const id = await deps.recordFeedbackPreference(parsed.data);
      return reply.status(201).send({ id, reviewed: parsed.data.reviewed ?? false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/conversation not found/i.test(message)) return reply.status(404).send({ error: "conversation not found" });
      throw err;
    }
  });
}
