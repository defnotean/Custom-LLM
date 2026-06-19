import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisJobQueue } from "../src/jobs/queue";
import type { RedisRuntimeClient } from "../src/state/RedisRuntimeState";
import { testLogger } from "./helpers";

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("RedisJobQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims due scheduled jobs from Redis and runs the registered handler once", async () => {
    let now = 1_000;
    const redis = new FakeRedis();
    const queue = new RedisJobQueue({ client: redis, logger: testLogger, now: () => now });
    const seen: unknown[] = [];
    queue.process("demo", async (payload) => {
      seen.push(payload);
    });

    queue.schedule("demo", { value: 1 }, 100);
    await flushAsyncWork();
    expect(redis.scheduledCount()).toBe(1);

    await tick(queue);
    expect(seen).toEqual([]);

    now = 1_100;
    await tick(queue);
    expect(seen).toEqual([{ value: 1 }]);
    expect(redis.scheduledCount()).toBe(0);
  });

  it("deduplicates recurring schedules and reschedules after each run", async () => {
    let now = 5_000;
    const redis = new FakeRedis();
    const first = new RedisJobQueue({ client: redis, logger: testLogger, now: () => now });
    const second = new RedisJobQueue({ client: redis, logger: testLogger, now: () => now });
    const seen: unknown[] = [];
    first.process("repeat", async (payload) => {
      seen.push(payload);
    });

    first.every("repeat", { cadence: "hourly" }, 1_000);
    second.every("repeat", { cadence: "hourly" }, 1_000);
    await flushAsyncWork();
    expect(redis.scheduledCount()).toBe(1);

    now = 6_000;
    await tick(first);
    expect(seen).toEqual([{ cadence: "hourly" }]);
    expect(redis.scheduledCount()).toBe(1);

    now = 7_000;
    await tick(first);
    expect(seen).toEqual([{ cadence: "hourly" }, { cadence: "hourly" }]);
  });
});

async function tick(queue: RedisJobQueue): Promise<void> {
  await (queue as unknown as { tick(): Promise<void> }).tick();
}

class FakeRedis implements RedisRuntimeClient {
  private readonly strings = new Map<string, string>();
  private readonly zsets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.strings.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    const removedString = this.strings.delete(key);
    const removedSet = this.zsets.delete(key);
    return removedString || removedSet ? 1 : 0;
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    if (script.includes("ZRANGEBYSCORE")) return this.claimDue(options);
    if (script.includes("redis.call(\"GET\", KEYS[2])")) return this.enqueueRecurring(options);
    if (script.includes("ZADD")) return this.enqueue(options);
    throw new Error("unsupported fake redis script");
  }

  scheduledCount(): number {
    let total = 0;
    for (const members of this.zsets.values()) total += members.size;
    return total;
  }

  private enqueue(options: { keys: string[]; arguments: string[] }): number {
    const key = required(options.keys[0], "zset key");
    const runAt = Number(required(options.arguments[0], "score"));
    const member = required(options.arguments[1], "member");
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    zset.set(member, runAt);
    this.zsets.set(key, zset);
    return 1;
  }

  private enqueueRecurring(options: { keys: string[]; arguments: string[] }): number {
    const repeatKey = required(options.keys[1], "repeat key");
    if (this.strings.has(repeatKey)) return 0;
    this.strings.set(repeatKey, "1");
    return this.enqueue(options);
  }

  private claimDue(options: { keys: string[]; arguments: string[] }): string[] {
    const key = required(options.keys[0], "zset key");
    const now = Number(required(options.arguments[0], "now"));
    const limit = Number(required(options.arguments[1], "limit"));
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    const due = [...zset.entries()]
      .filter((entry) => entry[1] <= now)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map((entry) => entry[0]);
    for (const member of due) zset.delete(member);
    this.zsets.set(key, zset);
    return due;
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}
