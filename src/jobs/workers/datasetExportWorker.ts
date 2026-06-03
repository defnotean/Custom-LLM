import type { Logger } from "pino";
import type { DatasetExporter } from "../../training/DatasetExporter";
import type { JobQueue } from "../queue";

/**
 * Dataset export worker: runs the DatasetExporter on demand (API/command
 * can enqueue) and on a daily schedule when an exporter is available.
 */
export function registerDatasetExportWorker(
  queue: JobQueue,
  deps: { exporter: DatasetExporter | null; logger: Logger },
): void {
  queue.process<{ outDir?: string }>("training:export", async (payload) => {
    if (!deps.exporter) {
      deps.logger.warn("training:export job skipped — exporter unavailable (no database)");
      return;
    }
    const summary = await deps.exporter.exportAll(payload.outDir ?? "exports/training");
    deps.logger.info(
      { total: summary.totalExamples, files: summary.files.length },
      "scheduled training export complete",
    );
  });

  if (deps.exporter) {
    queue.every("training:export", {}, 24 * 60 * 60 * 1000);
  }
}
