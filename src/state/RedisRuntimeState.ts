import type { Logger } from "pino";
import { createClient, type RedisClientType } from "redis";
import type { RateLimitResult, RateLimitStore, RateLimitStoreCheckOptions } from "../safety/RateLimitService";
import type { CooldownStore } from "../tools/ToolCooldownService";
import { toErrorMessage } from "../utils/errors";

export interface RedisRuntimeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit?(): Promise<unknown>;
}

export interface RedisRuntimeState {
  client: RedisRuntimeClient;
  cooldownStore: RedisCooldownStore;
  rateLimitStore: RedisRateLimitStore;
  close(): Promise<void>;
}

export interface RedisRuntimeStateOptions {
  url: string;
  keyPrefix?: string;
  connectTimeoutMs?: number;
  logger?: Logger;
}

const DEFAULT_KEY_PREFIX = "irene";

export async function connectRedisRuntimeState(options: RedisRuntimeStateOptions): Promise<RedisRuntimeState> {
  const client = createClient({
    url: options.url,
    socket: { connectTimeout: options.connectTimeoutMs },
  }) as RedisClientType;
  client.on("error", (err) => {
    options.logger?.warn({ err: toErrorMessage(err) }, "redis runtime state client error");
  });
  await client.connect();

  const runtimeClient = client as unknown as RedisRuntimeClient;
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  return {
    client: runtimeClient,
    cooldownStore: new RedisCooldownStore(runtimeClient, { keyPrefix }),
    rateLimitStore: new RedisRateLimitStore(runtimeClient, { keyPrefix }),
    close: async () => {
      await runtimeClient.quit?.();
    },
  };
}

export class RedisCooldownStore implements CooldownStore {
  private readonly keyPrefix: string;
  private readonly now: () => number;

  constructor(
    private readonly client: RedisRuntimeClient,
    options?: { keyPrefix?: string; now?: () => number },
  ) {
    this.keyPrefix = options?.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.now = options?.now ?? (() => Date.now());
  }

  async getExpiry(key: string): Promise<number | null> {
    const raw = await this.client.get(this.key(key));
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= this.now()) return null;
    return parsed;
  }

  async setExpiry(key: string, expiresAtMs: number): Promise<void> {
    const ttlMs = Math.max(1, expiresAtMs - this.now());
    await this.client.set(this.key(key), String(expiresAtMs), { PX: ttlMs });
  }

  private key(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }
}

export class RedisRateLimitStore implements RateLimitStore {
  private readonly keyPrefix: string;

  constructor(
    private readonly client: RedisRuntimeClient,
    options?: { keyPrefix?: string },
  ) {
    this.keyPrefix = options?.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  async checkAndRecord(key: string, options: RateLimitStoreCheckOptions): Promise<RateLimitResult> {
    const member = `${options.nowMs}:${Math.random().toString(36).slice(2)}`;
    const raw = await this.client.eval(RATE_LIMIT_SCRIPT, {
      keys: [this.key(key)],
      arguments: [
        String(options.nowMs),
        String(options.windowMs),
        String(options.maxEvents),
        member,
      ],
    });
    const result = normalizeRedisEvalArray(raw);
    const allowed = result[0] === 1;
    return {
      allowed,
      retryAfterMs: allowed ? 0 : Math.max(0, result[1] ?? options.windowMs),
    };
  }

  private key(key: string): string {
    return `${this.keyPrefix}:rate:${key}`;
  }
}

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_events = tonumber(ARGV[3])
local member = ARGV[4]
local cutoff = now - window

redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)
local count = redis.call("ZCARD", key)

if count >= max_events then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local oldest_score = now
  if oldest[2] then
    oldest_score = tonumber(oldest[2])
  end
  redis.call("PEXPIRE", key, window)
  return {0, math.max(0, oldest_score + window - now), count}
end

redis.call("ZADD", key, now, member)
redis.call("PEXPIRE", key, window)
return {1, 0, count + 1}
`;

function normalizeRedisEvalArray(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("Redis rate-limit script returned a non-array result");
  return value.map((item) => {
    const parsed = Number(item);
    if (!Number.isFinite(parsed)) throw new Error("Redis rate-limit script returned a non-numeric result");
    return parsed;
  });
}
