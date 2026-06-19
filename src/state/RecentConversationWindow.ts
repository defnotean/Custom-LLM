import type { RedisRuntimeClient } from "./RedisRuntimeState";

export type RecentConversationRole = "user" | "assistant";

export interface RecentConversationTurn {
  id: string;
  role: RecentConversationRole;
  channelId: string;
  userId: string | null;
  username: string;
  content: string;
  createdAt: string;
}

export interface RecentConversationWindow {
  append(channelId: string, turns: RecentConversationTurn[]): Promise<void>;
  read(channelId: string, limit?: number): Promise<RecentConversationTurn[]>;
  transcript(channelId: string, limit?: number): Promise<string | null>;
}

export interface RecentConversationWindowOptions {
  maxTurns?: number;
  ttlMs?: number;
  now?: () => Date;
}

const DEFAULT_MAX_TURNS = 32;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const TRANSCRIPT_CONTENT_LIMIT = 280;

export class InMemoryRecentConversationWindow implements RecentConversationWindow {
  private readonly maxTurns: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly channels = new Map<string, { expiresAtMs: number; turns: RecentConversationTurn[] }>();

  constructor(options: RecentConversationWindowOptions = {}) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  async append(channelId: string, turns: RecentConversationTurn[]): Promise<void> {
    const current = await this.read(channelId, this.maxTurns);
    const normalized = [...current, ...turns.map(normalizeTurn)].slice(-this.maxTurns);
    this.channels.set(channelId, {
      expiresAtMs: this.now().getTime() + this.ttlMs,
      turns: normalized,
    });
  }

  async read(channelId: string, limit = DEFAULT_MAX_TURNS): Promise<RecentConversationTurn[]> {
    const entry = this.channels.get(channelId);
    if (!entry) return [];
    if (entry.expiresAtMs <= this.now().getTime()) {
      this.channels.delete(channelId);
      return [];
    }
    return entry.turns.slice(-Math.max(0, limit));
  }

  async transcript(channelId: string, limit = 8): Promise<string | null> {
    return turnsToTranscript(await this.read(channelId, limit));
  }
}

export class RedisRecentConversationWindow implements RecentConversationWindow {
  private readonly keyPrefix: string;
  private readonly maxTurns: number;
  private readonly ttlMs: number;

  constructor(
    private readonly client: RedisRuntimeClient,
    options: RecentConversationWindowOptions & { keyPrefix?: string } = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? "irene";
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async append(channelId: string, turns: RecentConversationTurn[]): Promise<void> {
    const current = await this.read(channelId, this.maxTurns);
    const normalized = [...current, ...turns.map(normalizeTurn)].slice(-this.maxTurns);
    await this.client.set(this.key(channelId), JSON.stringify(normalized), { PX: this.ttlMs });
  }

  async read(channelId: string, limit = DEFAULT_MAX_TURNS): Promise<RecentConversationTurn[]> {
    const key = this.key(channelId);
    const raw = await this.client.get(key);
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      await this.client.del(key);
      return [];
    }
    if (!Array.isArray(parsed)) {
      await this.client.del(key);
      return [];
    }

    const turns = parsed.map(parseTurn).filter((turn): turn is RecentConversationTurn => turn !== null);
    if (turns.length !== parsed.length) {
      if (turns.length === 0) await this.client.del(key);
      else await this.client.set(key, JSON.stringify(turns.slice(-this.maxTurns)), { PX: this.ttlMs });
    }
    return turns.slice(-Math.max(0, limit));
  }

  async transcript(channelId: string, limit = 8): Promise<string | null> {
    return turnsToTranscript(await this.read(channelId, limit));
  }

  private key(channelId: string): string {
    return `${this.keyPrefix}:recent-conversation:${channelId}`;
  }
}

export function makeRecentTurn(input: {
  id: string;
  role: RecentConversationRole;
  channelId: string;
  userId?: string | null;
  username: string;
  content: string;
  createdAt?: Date;
}): RecentConversationTurn {
  return normalizeTurn({
    id: input.id,
    role: input.role,
    channelId: input.channelId,
    userId: input.userId ?? null,
    username: input.username,
    content: input.content,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  });
}

export function turnsToTranscript(turns: RecentConversationTurn[]): string | null {
  const lines = turns
    .map(normalizeTurn)
    .filter((turn) => turn.content.length > 0)
    .map((turn) => {
      const name = turn.role === "assistant" ? "you (the assistant)" : turn.username;
      return `[${name}]: ${truncate(turn.content, TRANSCRIPT_CONTENT_LIMIT)}`;
    });
  return lines.length > 0 ? lines.join("\n") : null;
}

function normalizeTurn(turn: RecentConversationTurn): RecentConversationTurn {
  return {
    id: normalizeWhitespace(turn.id),
    role: turn.role === "assistant" ? "assistant" : "user",
    channelId: normalizeWhitespace(turn.channelId),
    userId: turn.userId === null ? null : normalizeWhitespace(turn.userId ?? ""),
    username: normalizeWhitespace(turn.username) || "unknown",
    content: normalizeWhitespace(turn.content),
    createdAt: normalizeTimestamp(turn.createdAt),
  };
}

function parseTurn(value: unknown): RecentConversationTurn | null {
  if (!isRecord(value)) return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  if (
    typeof value.id !== "string" ||
    typeof value.channelId !== "string" ||
    typeof value.username !== "string" ||
    typeof value.content !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  if (value.userId !== null && typeof value.userId !== "string") return null;
  return normalizeTurn({
    id: value.id,
    role: value.role,
    channelId: value.channelId,
    userId: value.userId,
    username: value.username,
    content: value.content,
    createdAt: value.createdAt,
  });
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
