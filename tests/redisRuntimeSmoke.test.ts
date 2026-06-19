import { describe, expect, it } from "vitest";
import { runRedisRuntimeSmoke } from "../src/state/RedisRuntimeSmoke";
import {
  RedisCooldownStore,
  RedisPendingConfirmationStore,
  RedisRateLimitStore,
  type RedisRuntimeClient,
} from "../src/state/RedisRuntimeState";
import { testLogger } from "./helpers";

describe("RedisRuntimeSmoke", () => {
  it("passes all runtime-state checks and cleans up known Redis keys", async () => {
    const keyPrefix = "smoke-test";
    const redis = new FakeRedis();
    const report = await runRedisRuntimeSmoke({
      runtimeState: {
        client: redis,
        cooldownStore: new RedisCooldownStore(redis, { keyPrefix }),
        rateLimitStore: new RedisRateLimitStore(redis, { keyPrefix }),
        pendingConfirmationStore: new RedisPendingConfirmationStore(redis, { keyPrefix }),
      },
      keyPrefix,
      logger: testLogger,
      timeoutMs: 1_000,
      jobTickMs: 5,
      jobDelayMs: 5,
      jobRepeatMs: 5,
    });

    expect(report.status).toBe("pass");
    expect(report.checks.map((check) => check.id)).toEqual([
      "redis-connectivity",
      "redis-cooldown-state",
      "redis-rate-limit-state",
      "redis-pending-confirmation-state",
      "redis-job-queue-state",
      "redis-smoke-cleanup",
    ]);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(redis.rawKeys()).toEqual([]);
  });
});

class FakeRedis implements RedisRuntimeClient {
  private readonly strings = new Map<string, { value: string; expiresAtMs: number | null }>();
  private readonly zsets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | null> {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, options?: { PX?: number }): Promise<unknown> {
    this.strings.set(key, {
      value,
      expiresAtMs: options?.PX ? Date.now() + options.PX : null,
    });
    return "OK";
  }

  async del(key: string): Promise<number> {
    const removedString = this.strings.delete(key);
    const removedSet = this.zsets.delete(key);
    return removedString || removedSet ? 1 : 0;
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    if (script.includes("ZREMRANGEBYSCORE")) return this.rateLimit(options);
    if (script.includes("ZRANGEBYSCORE")) return this.claimDue(options);
    if (script.includes('redis.call("GET", KEYS[2])')) return this.enqueueRecurring(options);
    if (script.includes("ZADD")) return this.enqueue(options);
    throw new Error("unsupported fake redis script");
  }

  rawKeys(): string[] {
    return [...this.strings.keys(), ...this.zsets.keys()].sort();
  }

  private rateLimit(options: { keys: string[]; arguments: string[] }): number[] {
    const key = required(options.keys[0], "rate key");
    const now = Number(required(options.arguments[0], "now"));
    const windowMs = Number(required(options.arguments[1], "window"));
    const maxEvents = Number(required(options.arguments[2], "max events"));
    const member = required(options.arguments[3], "member");
    const cutoff = now - windowMs;
    const zset = this.sortedSet(key);
    const active = [...zset.entries()]
      .filter((entry) => entry[1] > cutoff)
      .sort((left, right) => left[1] - right[1]);
    zset.clear();
    for (const [item, score] of active) zset.set(item, score);
    if (active.length >= maxEvents) {
      const oldest = active[0]?.[1] ?? now;
      return [0, Math.max(0, oldest + windowMs - now), active.length];
    }
    zset.set(member, now);
    return [1, 0, active.length + 1];
  }

  private enqueue(options: { keys: string[]; arguments: string[] }): number {
    const key = required(options.keys[0], "scheduled key");
    const runAt = Number(required(options.arguments[0], "runAt"));
    const member = required(options.arguments[1], "job");
    this.sortedSet(key).set(member, runAt);
    return 1;
  }

  private enqueueRecurring(options: { keys: string[]; arguments: string[] }): number {
    const repeatKey = required(options.keys[1], "repeat key");
    if (this.strings.has(repeatKey)) return 0;
    this.strings.set(repeatKey, { value: "1", expiresAtMs: null });
    return this.enqueue(options);
  }

  private claimDue(options: { keys: string[]; arguments: string[] }): string[] {
    const key = required(options.keys[0], "scheduled key");
    const now = Number(required(options.arguments[0], "now"));
    const limit = Number(required(options.arguments[1], "limit"));
    const zset = this.sortedSet(key);
    const due = [...zset.entries()]
      .filter((entry) => entry[1] <= now)
      .sort((left, right) => left[1] - right[1])
      .slice(0, limit)
      .map((entry) => entry[0]);
    for (const member of due) zset.delete(member);
    return due;
  }

  private sortedSet(key: string): Map<string, number> {
    const existing = this.zsets.get(key);
    if (existing) return existing;
    const created = new Map<string, number>();
    this.zsets.set(key, created);
    return created;
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}
