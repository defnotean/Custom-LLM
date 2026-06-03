import type { Logger } from "pino";
import type { JobQueue } from "../queue";

/**
 * Memory summarizer worker — PLACEHOLDER (registered, runs, does no writes).
 *
 * Intended behavior (documented TODO, see docs/ARCHITECTURE.md):
 *  1. pull recent Conversation rows per active channel,
 *  2. LLM-summarize into a rolling channel summary (CHANNEL-scope memory),
 *  3. consolidate near-duplicate USER memories (Mem0-style UPDATE/DELETE).
 * Today it logs what it *would* do so the scheduling plumbing is proven
 * without pretending summaries exist.
 */
export function registerMemorySummarizerWorker(
  queue: JobQueue,
  deps: { logger: Logger },
): void {
  queue.process<{ reason: string }>("memory:summarize", async (payload) => {
    deps.logger.info(
      { reason: payload.reason },
      "memory summarizer tick — placeholder (no summarization implemented yet)",
    );
  });

  // Hourly heartbeat keeps the pipeline observable.
  queue.every("memory:summarize", { reason: "scheduled" }, 60 * 60 * 1000);
}
