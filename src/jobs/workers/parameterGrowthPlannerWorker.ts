import type { Logger } from "pino";
import type { JobQueue } from "../queue";
import type { ParameterGrowthPlanner } from "../../training/parameter/ParameterGrowthPlanner";

export function registerParameterGrowthPlannerWorker(
  queue: JobQueue,
  deps: {
    planner: ParameterGrowthPlanner | null;
    logger: Logger;
    outDir?: string;
    intervalMs?: number;
  },
): void {
  queue.process<{ outDir?: string }>("training:parameter-growth-plan", async (payload) => {
    if (!deps.planner) {
      deps.logger.warn("training:parameter-growth-plan skipped - live learning persistence unavailable");
      return;
    }
    const written = await deps.planner.writePlan(payload.outDir ?? deps.outDir ?? "training/plans/parameter-growth");
    deps.logger.info(
      {
        path: written.path,
        status: written.plan.status,
        readyBatches: written.plan.summary.readyBatches,
        trainableCandidates: written.plan.summary.trainableCandidates,
      },
      "parameter growth plan complete",
    );
  });

  if (deps.planner) {
    queue.every("training:parameter-growth-plan", {}, deps.intervalMs ?? 6 * 60 * 60 * 1000);
  }
}
