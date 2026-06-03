import type { FastifyInstance } from "fastify";
import type { ExportSummary } from "../../training/DatasetExporter";

export interface TrainingRouteDeps {
  exportAll: ((outDir: string) => Promise<ExportSummary>) | null;
}

export function registerTrainingRoutes(app: FastifyInstance, deps: TrainingRouteDeps): void {
  app.post("/training/export", async (request, reply) => {
    if (!deps.exportAll) {
      return reply.status(503).send({ error: "training export unavailable (database not connected)" });
    }
    const { outDir } = (request.body ?? {}) as { outDir?: string };
    const summary = await deps.exportAll(outDir ?? "exports/training");
    return summary;
  });
}
