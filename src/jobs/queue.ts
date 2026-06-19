import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { RedisRuntimeClient } from "../state/RedisRuntimeState";
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

// RedisJobQueue below is the current shared Redis implementation. BullMQ-style
// retry/dead-letter operations can layer on later without changing workers.
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

interface RedisScheduledJob extends ScheduledJob {
  id: string;
  repeatKey?: string;
}

export interface RedisJobQueueOptions {
  client: RedisRuntimeClient;
  logger: Logger;
  keyPrefix?: string;
  tickMs?: number;
  now?: () => number;
}

export class RedisJobQueue implements JobQueue {
  private readonly handlers = new Map<string, JobHandler<never>>();
  private readonly client: RedisRuntimeClient;
  private readonly logger: Logger;
  private readonly keyPrefix: string;
  private readonly tickMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: RedisJobQueueOptions) {
    this.client = options.client;
    this.logger = options.logger;
    this.keyPrefix = options.keyPrefix ?? "irene";
    this.tickMs = options.tickMs ?? 1000;
    this.now = options.now ?? (() => Date.now());
  }

  process<T>(name: string, handler: JobHandler<T>): void {
    if (this.handlers.has(name)) {
      throw new Error(`Job handler "${name}" already registered`);
    }
    this.handlers.set(name, handler as JobHandler<never>);
  }

  schedule<T>(name: string, payload: T, delayMs: number): void {
    void this.enqueue({
      id: `job:${randomUUID()}`,
      name,
      payload,
      runAt: this.now() + delayMs,
    }).catch((err) => this.logger.error({ job: name, err: toErrorMessage(err) }, "failed to enqueue redis job"));
  }

  every<T>(name: string, payload: T, intervalMs: number): void {
    const repeatKey = this.repeatKey(name, payload, intervalMs);
    void this.enqueueRecurring({
      id: `repeat:${repeatKey}`,
      name,
      payload,
      runAt: this.now() + intervalMs,
      repeatMs: intervalMs,
      repeatKey,
    }).catch((err) =>
      this.logger.error({ job: name, err: toErrorMessage(err) }, "failed to enqueue recurring redis job"),
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async enqueue(job: RedisScheduledJob): Promise<void> {
    await this.client.eval(ENQUEUE_JOB_SCRIPT, {
      keys: [this.scheduledKey()],
      arguments: [String(job.runAt), JSON.stringify(job)],
    });
  }

  private async enqueueRecurring(job: RedisScheduledJob): Promise<void> {
    await this.client.eval(ENQUEUE_RECURRING_JOB_SCRIPT, {
      keys: [this.scheduledKey(), this.repeatKeyKey(job.repeatKey ?? job.id)],
      arguments: [String(job.runAt), JSON.stringify(job)],
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const raw = await this.client.eval(CLAIM_DUE_JOBS_SCRIPT, {
        keys: [this.scheduledKey()],
        arguments: [String(this.now()), "50"],
      });
      const jobs = normalizeJobArray(raw);
      for (const job of jobs) {
        await this.runClaimedJob(job);
      }
    } catch (err) {
      this.logger.error({ err: toErrorMessage(err) }, "redis job queue tick failed");
    } finally {
      this.running = false;
    }
  }

  private async runClaimedJob(job: RedisScheduledJob): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      this.logger.warn({ job: job.name }, "no handler for due redis job - dropped");
      if (job.repeatMs) await this.rescheduleRecurring(job);
      return;
    }

    try {
      await (handler as JobHandler<unknown>)(job.payload);
    } catch (err) {
      this.logger.error({ job: job.name, err: toErrorMessage(err) }, "redis job failed");
    }
    if (job.repeatMs) await this.rescheduleRecurring(job);
  }

  private async rescheduleRecurring(job: RedisScheduledJob): Promise<void> {
    if (!job.repeatMs) return;
    await this.enqueue({
      ...job,
      runAt: this.now() + job.repeatMs,
    });
  }

  private scheduledKey(): string {
    return `${this.keyPrefix}:jobs:scheduled`;
  }

  private repeatKeyKey(key: string): string {
    return `${this.keyPrefix}:jobs:repeat:${key}`;
  }

  private repeatKey<T>(name: string, payload: T, intervalMs: number): string {
    return createHash("sha256").update(JSON.stringify({ name, payload, intervalMs })).digest("hex");
  }
}

const ENQUEUE_JOB_SCRIPT = `
redis.call("ZADD", KEYS[1], tonumber(ARGV[1]), ARGV[2])
return 1
`;

const ENQUEUE_RECURRING_JOB_SCRIPT = `
if redis.call("GET", KEYS[2]) then
  return 0
end
redis.call("SET", KEYS[2], "1")
redis.call("ZADD", KEYS[1], tonumber(ARGV[1]), ARGV[2])
return 1
`;

const CLAIM_DUE_JOBS_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local jobs = redis.call("ZRANGEBYSCORE", key, "-inf", now, "LIMIT", 0, limit)
for _, job in ipairs(jobs) do
  redis.call("ZREM", key, job)
end
return jobs
`;

function normalizeJobArray(value: unknown): RedisScheduledJob[] {
  if (!Array.isArray(value)) throw new Error("Redis job claim script returned a non-array result");
  return value.flatMap((item) => {
    if (typeof item !== "string") return [];
    try {
      const parsed = JSON.parse(item) as unknown;
      return isRedisScheduledJob(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function isRedisScheduledJob(value: unknown): value is RedisScheduledJob {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.runAt === "number" &&
    Number.isFinite(value.runAt) &&
    (!("repeatMs" in value) || (typeof value.repeatMs === "number" && Number.isFinite(value.repeatMs))) &&
    (!("repeatKey" in value) || typeof value.repeatKey === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
