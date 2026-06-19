export interface PendingToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  expiresAt: number;
  originalUserMessage: string;
}

export interface PendingConfirmationStore {
  get(key: string): Promise<PendingToolCall | null>;
  set(key: string, pending: PendingToolCall, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryPendingConfirmationStore implements PendingConfirmationStore {
  private readonly pending = new Map<string, PendingToolCall>();
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? (() => Date.now());
  }

  async get(key: string): Promise<PendingToolCall | null> {
    const pending = this.pending.get(key);
    if (!pending) return null;
    if (pending.expiresAt < this.now()) {
      this.pending.delete(key);
      return null;
    }
    return pending;
  }

  async set(key: string, pending: PendingToolCall, _ttlMs: number): Promise<void> {
    this.pending.set(key, pending);
  }

  async delete(key: string): Promise<void> {
    this.pending.delete(key);
  }
}
