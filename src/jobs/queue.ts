import type { Logger } from "pino";
import { toErrorMessage } from "../utils/errors";

/**
 * Background job scaffold — minimal but real.
 *
 * InProcessJobQueue runs delayed and repeating jobs on a setInterval tick
 * inside the bot process. The interface is intentionally shaped so a
 * Redis-backed implementation (BullMQ) can replace it without touching
 * worker code — that upgrade (durability, retries, cross-process workers)
 * is the documented production path in docs/DEPLOYMENT.md.
 */

export type JobHandler<T = unknown> = (payload: T) => Promise<void>;

export interface JobQueue {
  process<T>(name: string, handler: JobHandler<T>): void;
  /** Run once after `delayMs`. */
  schedule<T>(name: string, payload: T, delayMs: number): void;
  /** Run every `intervalMs` (first run after one interval). */
  every<T>(name: string, payload: T, intervalMs: number): void;
  start(): void;
  stop(): void;
}

interface ScheduledJob {
  name: string;
  payload: unknown;
  runAt: number;
  repeatMs?: number;
}

export class InProcessJobQueue implements JobQueue {
  private readonly handlers = new Map<string, JobHandler<never>>();
  private jobs: ScheduledJob[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly logger: Logger,
    private readonly tickMs = 1000,
  ) {}

  process<T>(name: string, handler: JobHandler<T>): void {
    if (this.handlers.has(name)) {
      throw new Error(`Job handler "${name}" already registered`);
    }
    this.handlers.set(name, handler as JobHandler<never>);
  }

  schedule<T>(name: string, payload: T, delayMs: number): void {
    this.jobs.push({ name, payload, runAt: Date.now() + delayMs });
  }

  every<T>(name: string, payload: T, intervalMs: number): void {
    this.jobs.push({ name, payload, runAt: Date.now() + intervalMs, repeatMs: intervalMs });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // Don't keep the process alive just for the queue.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return; // no overlapping ticks
    this.running = true;
    try {
      const now = Date.now();
      const due = this.jobs.filter((j) => j.runAt <= now);
      this.jobs = this.jobs.filter((j) => j.runAt > now);

      for (const job of due) {
        const handler = this.handlers.get(job.name);
        if (!handler) {
          this.logger.warn({ job: job.name }, "no handler for due job — dropped");
          continue;
        }
        try {
          await (handler as JobHandler<unknown>)(job.payload);
        } catch (err) {
          this.logger.error({ job: job.name, err: toErrorMessage(err) }, "job failed");
        }
        if (job.repeatMs) {
          this.jobs.push({ ...job, runAt: Date.now() + job.repeatMs });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
