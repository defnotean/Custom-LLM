/**
 * Sliding-window per-user rate limiting (in-process). Defaults: 8 messages
 * per 20s per user. For multi-process deployments swap the store for Redis —
 * the interface is process-local by design until then (documented TODO).
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimitOptions {
  maxEvents?: number;
  windowMs?: number;
}

export class RateLimitService {
  private readonly maxEvents: number;
  private readonly windowMs: number;
  private readonly events = new Map<string, number[]>();

  constructor(options?: RateLimitOptions) {
    this.maxEvents = options?.maxEvents ?? 8;
    this.windowMs = options?.windowMs ?? 20_000;
  }

  check(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const list = (this.events.get(key) ?? []).filter((t) => t > cutoff);

    if (list.length >= this.maxEvents) {
      const oldest = list[0] ?? now;
      this.events.set(key, list);
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }

    list.push(now);
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
