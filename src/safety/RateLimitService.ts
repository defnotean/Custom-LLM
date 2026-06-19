/**
 * Sliding-window per-user rate limiting. Defaults: 8 messages per 20s per
 * user. The store is pluggable so one-process dev can stay in memory while
 * scaled Discord deployments can use Redis-backed state.
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimitOptions {
  maxEvents?: number;
  windowMs?: number;
  store?: RateLimitStore;
  now?: () => number;
}

export interface RateLimitStore {
  checkAndRecord(key: string, options: RateLimitStoreCheckOptions): Promise<RateLimitResult>;
}

export interface RateLimitStoreCheckOptions {
  maxEvents: number;
  windowMs: number;
  nowMs: number;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly events = new Map<string, number[]>();

  async checkAndRecord(key: string, options: RateLimitStoreCheckOptions): Promise<RateLimitResult> {
    const cutoff = options.nowMs - options.windowMs;
    const list = (this.events.get(key) ?? []).filter((t) => t > cutoff);

    if (list.length >= options.maxEvents) {
      const oldest = list[0] ?? options.nowMs;
      this.events.set(key, list);
      return { allowed: false, retryAfterMs: Math.max(0, oldest + options.windowMs - options.nowMs) };
    }

    list.push(options.nowMs);
    this.events.set(key, list);

    // Bound memory across many users.
    if (this.events.size > 50_000) {
      for (const [k, v] of this.events) {
        if (v.every((t) => t <= cutoff)) this.events.delete(k);
      }
    }
    return { allowed: true, retryAfterMs: 0 };
  }
}

export class RateLimitService {
  private readonly maxEvents: number;
  private readonly windowMs: number;
  private readonly store: RateLimitStore;
  private readonly now: () => number;

  constructor(options?: RateLimitOptions) {
    this.maxEvents = options?.maxEvents ?? 8;
    this.windowMs = options?.windowMs ?? 20_000;
    this.store = options?.store ?? new InMemoryRateLimitStore();
    this.now = options?.now ?? (() => Date.now());
  }

  async check(key: string): Promise<RateLimitResult> {
    return this.store.checkAndRecord(key, {
      maxEvents: this.maxEvents,
      windowMs: this.windowMs,
      nowMs: this.now(),
    });
  }
}
