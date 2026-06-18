import { randomUUID } from "crypto";

export interface VoiceSpeechJob {
  id: string;
  guildId: string;
  channelId: string;
  requestedByUserId: string;
  text: string;
  createdAt: string;
}

export interface VoiceSpeechPlayer {
  play(job: VoiceSpeechJob): Promise<void>;
  stopGuild?(guildId: string): Promise<void> | void;
}

export interface VoiceSpeechQueueOptions {
  maxTextChars?: number;
  maxQueueDepth?: number;
  cooldownMs?: number;
  now?: () => number;
  makeId?: () => string;
  onPlaybackError?: (job: VoiceSpeechJob, err: unknown) => void;
}

export type VoiceSpeechQueueResult =
  | { ok: true; job: VoiceSpeechJob; position: number }
  | { ok: false; reason: "empty_text" | "text_too_long" | "queue_full" | "cooldown"; message: string };

export interface VoiceSpeechQueueStatus {
  activeJobId: string | null;
  activeText: string | null;
  queued: number;
}

export class VoiceSpeechQueue {
  private readonly player: VoiceSpeechPlayer;
  private readonly maxTextChars: number;
  private readonly maxQueueDepth: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly onPlaybackError?: (job: VoiceSpeechJob, err: unknown) => void;
  private readonly queues = new Map<string, VoiceSpeechJob[]>();
  private readonly active = new Map<string, VoiceSpeechJob>();
  private readonly lastAcceptedAt = new Map<string, number>();

  constructor(player: VoiceSpeechPlayer, options: VoiceSpeechQueueOptions = {}) {
    this.player = player;
    this.maxTextChars = options.maxTextChars ?? 600;
    this.maxQueueDepth = options.maxQueueDepth ?? 3;
    this.cooldownMs = options.cooldownMs ?? 3_000;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? randomUUID;
    this.onPlaybackError = options.onPlaybackError;
  }

  enqueue(input: Omit<VoiceSpeechJob, "id" | "createdAt">): VoiceSpeechQueueResult {
    const text = input.text.trim();
    if (!text) {
      return { ok: false, reason: "empty_text", message: "Nothing to say." };
    }
    if (text.length > this.maxTextChars) {
      return {
        ok: false,
        reason: "text_too_long",
        message: `TTS text is too long (${text.length}/${this.maxTextChars} characters).`,
      };
    }

    const nowMs = this.now();
    const lastAcceptedAt = this.lastAcceptedAt.get(input.guildId);
    if (lastAcceptedAt !== undefined && nowMs - lastAcceptedAt < this.cooldownMs) {
      const waitMs = this.cooldownMs - (nowMs - lastAcceptedAt);
      return {
        ok: false,
        reason: "cooldown",
        message: `Voice speech is cooling down; try again in ${Math.ceil(waitMs / 1000)}s.`,
      };
    }

    const queue = this.queues.get(input.guildId) ?? [];
    const queuedOrActive = queue.length + (this.active.has(input.guildId) ? 1 : 0);
    if (queuedOrActive >= this.maxQueueDepth) {
      return {
        ok: false,
        reason: "queue_full",
        message: `Voice speech queue is full (${this.maxQueueDepth} items).`,
      };
    }

    const job: VoiceSpeechJob = {
      ...input,
      text,
      id: this.makeId(),
      createdAt: new Date(nowMs).toISOString(),
    };
    queue.push(job);
    this.queues.set(input.guildId, queue);
    this.lastAcceptedAt.set(input.guildId, nowMs);
    const position = queuedOrActive + 1;
    void this.drain(input.guildId);
    return { ok: true, job, position };
  }

  async stopGuild(guildId: string): Promise<void> {
    this.queues.delete(guildId);
    this.active.delete(guildId);
    await this.player.stopGuild?.(guildId);
  }

  status(guildId: string): VoiceSpeechQueueStatus {
    const active = this.active.get(guildId) ?? null;
    return {
      activeJobId: active?.id ?? null,
      activeText: active?.text ?? null,
      queued: this.queues.get(guildId)?.length ?? 0,
    };
  }

  private async drain(guildId: string): Promise<void> {
    if (this.active.has(guildId)) return;

    while (true) {
      const queue = this.queues.get(guildId) ?? [];
      const job = queue.shift();
      if (!job) {
        this.queues.delete(guildId);
        return;
      }
      this.queues.set(guildId, queue);
      this.active.set(guildId, job);
      try {
        await this.player.play(job);
      } catch (err) {
        this.onPlaybackError?.(job, err);
      } finally {
        this.active.delete(guildId);
      }
    }
  }
}
