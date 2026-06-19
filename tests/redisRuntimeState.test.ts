import { describe, expect, it, vi, afterEach } from "vitest";
import { RateLimitService } from "../src/safety/RateLimitService";
import {
  RedisCooldownStore,
  RedisPendingConfirmationStore,
  RedisRateLimitStore,
  type RedisRuntimeClient,
} from "../src/state/RedisRuntimeState";
import { ToolCooldownService } from "../src/tools/ToolCooldownService";

describe("Redis runtime state stores", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs tool cooldowns with Redis keys and PX expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T00:00:00.000Z"));
    const redis = new FakeRedis();
    const cooldowns = new ToolCooldownService(new RedisCooldownStore(redis, { keyPrefix: "test" }));

    expect((await cooldowns.check("ping", "user-1")).allowed).toBe(true);
    await cooldowns.markUsed("ping", "user-1", 10);

    expect(redis.rawKeys()).toEqual(["test:cooldown:ping:user-1"]);
    const blocked = await cooldowns.check("ping", "user-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remainingMs).toBe(10_000);

    vi.advanceTimersByTime(10_001);
    expect((await cooldowns.check("ping", "user-1")).allowed).toBe(true);
  });

  it("backs message rate limits with a Redis sliding window", async () => {
    let now = 1_000;
    const redis = new FakeRedis(() => now);
    const service = new RateLimitService({
      maxEvents: 2,
      windowMs: 5_000,
      store: new RedisRateLimitStore(redis, { keyPrefix: "test" }),
      now: () => now,
    });

    expect(await service.check("msg:user-1")).toEqual({ allowed: true, retryAfterMs: 0 });
    now += 1_000;
    expect(await service.check("msg:user-1")).toEqual({ allowed: true, retryAfterMs: 0 });
    now += 1_000;

    const blocked = await service.check("msg:user-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(3_000);

    now += 3_001;
    expect(await service.check("msg:user-1")).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("backs pending confirmations with Redis JSON and TTL expiry", async () => {
    let now = 10_000;
    const redis = new FakeRedis(() => now);
    const store = new RedisPendingConfirmationStore(redis, { keyPrefix: "test", now: () => now });

    await store.set(
      "channel-1:user-1",
      {
        tool: "risky_wipe",
        arguments: { reason: "test" },
        expiresAt: now + 120_000,
        originalUserMessage: "wipe everything",
      },
      120_000,
    );

    expect(redis.rawKeys()).toEqual(["test:pending-confirmation:channel-1:user-1"]);
    expect(await store.get("channel-1:user-1")).toMatchObject({
      tool: "risky_wipe",
      arguments: { reason: "test" },
      originalUserMessage: "wipe everything",
    });

    await store.delete("channel-1:user-1");
    expect(await store.get("channel-1:user-1")).toBeNull();

    await store.set(
      "channel-1:user-1",
      {
        tool: "risky_wipe",
        arguments: {},
        expiresAt: now + 1_000,
        originalUserMessage: "wipe everything",
      },
      1_000,
    );
    now += 1_001;
    expect(await store.get("channel-1:user-1")).toBeNull();
  });
});

class FakeRedis implements RedisRuntimeClient {
  private readonly strings = new Map<string, { value: string; expiresAtMs: number | null }>();
  private readonly sortedSets = new Map<string, Array<{ score: number; member: string }>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<string | null> {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.now()) {
      this.strings.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, options?: { PX?: number }): Promise<unknown> {
    this.strings.set(key, {
      value,
      expiresAtMs: options?.PX ? this.now() + options.PX : null,
    });
    return "OK";
  }

  async del(key: string): Promise<number> {
    const existed = this.strings.delete(key);
    this.sortedSets.delete(key);
    return existed ? 1 : 0;
  }

  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    const key = options.keys[0];
    if (!key) throw new Error("missing key");
    const now = Number(options.arguments[0]);
    const windowMs = Number(options.arguments[1]);
    const maxEvents = Number(options.arguments[2]);
    const member = options.arguments[3];
    if (!Number.isFinite(now) || !Number.isFinite(windowMs) || !Number.isFinite(maxEvents) || !member) {
      throw new Error("invalid rate limit args");
    }

    const cutoff = now - windowMs;
    const set = (this.sortedSets.get(key) ?? [])
      .filter((entry) => entry.score > cutoff)
      .sort((a, b) => a.score - b.score);
    if (set.length >= maxEvents) {
      const oldest = set[0]?.score ?? now;
      this.sortedSets.set(key, set);
      return [0, Math.max(0, oldest + windowMs - now), set.length];
    }
    set.push({ score: now, member });
    this.sortedSets.set(key, set);
    return [1, 0, set.length];
  }

  rawKeys(): string[] {
    return [...this.strings.keys()].sort();
  }
}
