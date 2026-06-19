import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { PendingToolCall } from "../ai/orchestration/PendingConfirmationStore";
import { RedisJobQueue } from "../jobs/queue";
import { RateLimitService } from "../safety/RateLimitService";
import { ToolCooldownService } from "../tools/ToolCooldownService";
import { toErrorMessage } from "../utils/errors";
import { makeRecentTurn } from "./RecentConversationWindow";
import type { RedisRuntimeClient, RedisRuntimeState } from "./RedisRuntimeState";

export type RedisRuntimeSmokeStatus = "pass" | "fail";

export interface RedisRuntimeSmokeCheck {
  id: string;
  status: RedisRuntimeSmokeStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface RedisRuntimeSmokeReport {
  status: RedisRuntimeSmokeStatus;
  generatedAt: string;
  keyPrefix: string;
  checks: RedisRuntimeSmokeCheck[];
}

export interface RedisRuntimeSmokeOptions {
  runtimeState: Pick<
    RedisRuntimeState,
    "client" | "cooldownStore" | "rateLimitStore" | "pendingConfirmationStore" | "recentConversationWindow"
  >;
  keyPrefix: string;
  logger: Logger;
  timeoutMs?: number;
  jobTickMs?: number;
  jobDelayMs?: number;
  jobRepeatMs?: number;
}

const SMOKE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_JOB_TICK_MS = 25;
const DEFAULT_JOB_DELAY_MS = 50;
const DEFAULT_JOB_REPEAT_MS = 50;

export async function runRedisRuntimeSmoke(options: RedisRuntimeSmokeOptions): Promise<RedisRuntimeSmokeReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jobDelayMs = options.jobDelayMs ?? DEFAULT_JOB_DELAY_MS;
  const jobRepeatMs = options.jobRepeatMs ?? DEFAULT_JOB_REPEAT_MS;
  const checks: RedisRuntimeSmokeCheck[] = [];
  const cleanupKeys = redisSmokeCleanupKeys(options.keyPrefix, jobRepeatMs);
  const queue = new RedisJobQueue({
    client: options.runtimeState.client,
    logger: options.logger,
    keyPrefix: options.keyPrefix,
    tickMs: options.jobTickMs ?? DEFAULT_JOB_TICK_MS,
  });

  await recordCheck(checks, "redis-connectivity", async () => {
    const key = `${options.keyPrefix}:smoke:connectivity`;
    await options.runtimeState.client.set(key, "ok", { PX: SMOKE_TTL_MS });
    const raw = await options.runtimeState.client.get(key);
    if (raw !== "ok") throw new Error("Redis SET/GET round-trip returned an unexpected value");
    return "Redis SET/GET round-trip succeeded";
  });

  await recordCheck(checks, "redis-cooldown-state", async () => {
    const cooldowns = new ToolCooldownService(options.runtimeState.cooldownStore);
    const first = await cooldowns.check("redis_smoke_tool", "redis-smoke-user");
    if (!first.allowed) throw new Error("fresh cooldown key was unexpectedly blocked");
    await cooldowns.markUsed("redis_smoke_tool", "redis-smoke-user", 60);
    const second = await cooldowns.check("redis_smoke_tool", "redis-smoke-user");
    if (second.allowed || second.remainingMs <= 0) {
      throw new Error("cooldown state did not block repeat use");
    }
    return "Redis-backed tool cooldown blocked repeat use";
  });

  await recordCheck(checks, "redis-rate-limit-state", async () => {
    const rateLimit = new RateLimitService({
      maxEvents: 1,
      windowMs: SMOKE_TTL_MS,
      store: options.runtimeState.rateLimitStore,
    });
    const first = await rateLimit.check("redis-smoke-user");
    const second = await rateLimit.check("redis-smoke-user");
    if (!first.allowed) throw new Error("first rate-limit event was unexpectedly blocked");
    if (second.allowed || second.retryAfterMs <= 0) {
      throw new Error("rate-limit state did not block the second event");
    }
    return "Redis-backed sliding-window rate limit blocked the second event";
  });

  await recordCheck(checks, "redis-pending-confirmation-state", async () => {
    const key = "redis-smoke-channel:redis-smoke-user";
    const pending: PendingToolCall = {
      tool: "redis_smoke_tool",
      arguments: { nonce: "pending" },
      expiresAt: Date.now() + SMOKE_TTL_MS,
      originalUserMessage: "run the redis smoke tool",
    };
    await options.runtimeState.pendingConfirmationStore.set(key, pending, SMOKE_TTL_MS);
    const stored = await options.runtimeState.pendingConfirmationStore.get(key);
    if (!stored || stored.tool !== pending.tool || stored.originalUserMessage !== pending.originalUserMessage) {
      throw new Error("pending confirmation was not restored from Redis");
    }
    await options.runtimeState.pendingConfirmationStore.delete(key);
    const deleted = await options.runtimeState.pendingConfirmationStore.get(key);
    if (deleted !== null) throw new Error("pending confirmation delete did not clear Redis state");
    return "Redis-backed pending confirmation stored, restored, and deleted JSON state";
  });

  await recordCheck(checks, "redis-recent-conversation-window", async () => {
    await options.runtimeState.recentConversationWindow.append("redis-smoke-channel", [
      makeRecentTurn({
        id: "redis-smoke-user-turn",
        role: "user",
        channelId: "redis-smoke-channel",
        userId: "redis-smoke-user",
        username: "SmokeUser",
        content: "remember this shared Redis window",
      }),
      makeRecentTurn({
        id: "redis-smoke-assistant-turn",
        role: "assistant",
        channelId: "redis-smoke-channel",
        username: "Irene",
        content: "I can read it from another runtime replica.",
      }),
    ]);
    const transcript = await options.runtimeState.recentConversationWindow.transcript("redis-smoke-channel", 4);
    if (!transcript?.includes("[SmokeUser]: remember this shared Redis window")) {
      throw new Error("recent conversation window did not restore the user turn");
    }
    if (!transcript.includes("[you (the assistant)]: I can read it from another runtime replica.")) {
      throw new Error("recent conversation window did not restore the assistant turn");
    }
    return "Redis-backed recent conversation window stored and restored a user/assistant turn";
  });

  await recordCheck(checks, "redis-job-queue-state", async () => {
    let scheduledRuns = 0;
    let recurringRuns = 0;
    queue.process("redis-smoke-once", async (payload) => {
      if (!isSmokePayload(payload, "once")) throw new Error("scheduled job payload mismatch");
      scheduledRuns += 1;
    });
    queue.process("redis-smoke-repeat", async (payload) => {
      if (!isSmokePayload(payload, "repeat")) throw new Error("recurring job payload mismatch");
      recurringRuns += 1;
    });
    queue.start();
    queue.schedule("redis-smoke-once", SMOKE_ONCE_PAYLOAD, jobDelayMs);
    queue.every("redis-smoke-repeat", SMOKE_REPEAT_PAYLOAD, jobRepeatMs);
    await waitFor(() => scheduledRuns === 1 && recurringRuns >= 2, timeoutMs, Math.max(5, jobRepeatMs / 2));
    if (scheduledRuns !== 1) throw new Error(`scheduled job ran ${scheduledRuns} times`);
    return "Redis-backed scheduled and recurring jobs executed through the shared queue";
  });

  queue.stop();

  await recordCheck(checks, "redis-smoke-cleanup", async () => {
    await cleanupRedisSmokeKeys(options.runtimeState.client, cleanupKeys);
    return `Deleted ${cleanupKeys.length} known smoke keys`;
  });

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    keyPrefix: options.keyPrefix,
    checks,
  };
}

async function recordCheck(
  checks: RedisRuntimeSmokeCheck[],
  id: string,
  run: () => Promise<string>,
): Promise<void> {
  try {
    checks.push({ id, status: "pass", summary: await run() });
  } catch (err) {
    checks.push({ id, status: "fail", summary: toErrorMessage(err) });
  }
}

async function cleanupRedisSmokeKeys(client: RedisRuntimeClient, keys: string[]): Promise<void> {
  for (const key of keys) await client.del(key);
}

function redisSmokeCleanupKeys(keyPrefix: string, jobRepeatMs: number): string[] {
  return [
    `${keyPrefix}:smoke:connectivity`,
    `${keyPrefix}:cooldown:redis_smoke_tool:redis-smoke-user`,
    `${keyPrefix}:rate:redis-smoke-user`,
    `${keyPrefix}:pending-confirmation:redis-smoke-channel:redis-smoke-user`,
    `${keyPrefix}:recent-conversation:redis-smoke-channel`,
    `${keyPrefix}:jobs:scheduled`,
    `${keyPrefix}:jobs:repeat:${repeatKey("redis-smoke-repeat", SMOKE_REPEAT_PAYLOAD, jobRepeatMs)}`,
  ];
}

const SMOKE_ONCE_PAYLOAD = { nonce: "once" };
const SMOKE_REPEAT_PAYLOAD = { nonce: "repeat" };

function repeatKey<T>(name: string, payload: T, intervalMs: number): string {
  return createHash("sha256").update(JSON.stringify({ name, payload, intervalMs })).digest("hex");
}

function isSmokePayload(value: unknown, nonce: string): value is { nonce: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "nonce" in value
    ? (value as { nonce?: unknown }).nonce === nonce
    : false;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
