/**
 * Per-user tool cooldowns. Backed by a pluggable store: the in-memory store
 * is the default; a Redis-backed store is the documented upgrade path for
 * multi-process deployments (same interface, swap at composition time).
 */

export interface CooldownStore {
  /** Epoch-ms until which the key is on cooldown, or null. */
  getExpiry(key: string): Promise<number | null>;
  setExpiry(key: string, expiresAtMs: number): Promise<void>;
}

export class InMemoryCooldownStore implements CooldownStore {
  private readonly expiries = new Map<string, number>();

  async getExpiry(key: string): Promise<number | null> {
    const expiry = this.expiries.get(key);
    if (expiry === undefined) return null;
    if (expiry <= Date.now()) {
      this.expiries.delete(key);
      return null;
    }
    return expiry;
  }

  async setExpiry(key: string, expiresAtMs: number): Promise<void> {
    this.expiries.set(key, expiresAtMs);
    // Opportunistic cleanup to bound memory.
    if (this.expiries.size > 10_000) {
      const now = Date.now();
      for (const [k, v] of this.expiries) {
        if (v <= now) this.expiries.delete(k);
      }
    }
  }
}

export interface CooldownCheck {
  allowed: boolean;
  remainingMs: number;
}

export class ToolCooldownService {
  constructor(private readonly store: CooldownStore = new InMemoryCooldownStore()) {}

  private key(toolName: string, userId: string): string {
    return `cooldown:${toolName}:${userId}`;
  }

  async check(toolName: string, userId: string): Promise<CooldownCheck> {
    const expiry = await this.store.getExpiry(this.key(toolName, userId));
    if (expiry === null) return { allowed: true, remainingMs: 0 };
    return { allowed: false, remainingMs: Math.max(0, expiry - Date.now()) };
  }

  async markUsed(toolName: string, userId: string, cooldownSeconds: number): Promise<void> {
    if (cooldownSeconds <= 0) return;
    await this.store.setExpiry(
      this.key(toolName, userId),
      Date.now() + cooldownSeconds * 1000,
    );
  }
}
