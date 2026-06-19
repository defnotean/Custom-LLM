import { EndBehaviorType, type AudioReceiveStreamOptions, type VoiceConnection } from "@discordjs/voice";
import type { Client } from "discord.js";
import type { Logger } from "pino";
import type { AgentReply } from "../../ai/orchestration/AgentController";
import type { GuildSettings } from "../../database/repositories/GuildRepository";
import type { BotMessageContext } from "../../types/discord";
import { toErrorMessage } from "../../utils/errors";
import type { BufferedVoiceAudioInput, VoiceCommandResult } from "./DiscordVoiceService";
import type { VoiceSpeechQueue } from "./VoiceSpeechQueue";
import type { VoiceSession } from "./VoiceSessionPolicy";

export interface VoiceReceiveBridgeConnection {
  receiver: {
    speaking: {
      on(event: "start", listener: (userId: string) => void): unknown;
      off?(event: "start", listener: (userId: string) => void): unknown;
      removeListener?(event: "start", listener: (userId: string) => void): unknown;
    };
    subscribe(userId: string, options?: Partial<AudioReceiveStreamOptions>): VoiceReceiveStream;
  };
}

export interface VoiceReceiveStream {
  on(event: "data", listener: (chunk: Buffer | Uint8Array) => void): this;
  once(event: "end", listener: () => void): this;
  once(event: "error", listener: (err: unknown) => void): this;
  once(event: "close", listener: () => void): this;
  destroy(error?: Error): void;
}

export interface VoiceReceiveBridgeAttachInput {
  guildId: string;
  channelId: string;
  connection: Pick<VoiceConnection, "receiver"> | VoiceReceiveBridgeConnection;
  session: VoiceSession;
}

export interface VoiceReceiveBridgeOptions {
  transcribeBufferedAudio: (ctx: BotMessageContext, input: BufferedVoiceAudioInput) => Promise<VoiceCommandResult>;
  agent: { handleDiscordMessage(ctx: BotMessageContext, options?: { transcript?: string | null }): Promise<AgentReply> };
  speechQueue?: Pick<VoiceSpeechQueue, "enqueue"> | null;
  getGuildSettings?: (guildId: string) => Promise<GuildSettings>;
  preprocessAudio?: VoiceReceiveAudioPreprocessor;
  client?: Client;
  logger?: Logger;
  receiveFormat?: string;
  silenceDurationMs?: number;
  minAudioBytes?: number;
  maxAudioBytes?: number;
  now?: () => Date;
}

export interface VoiceReceiveAudioPreprocessInput {
  guildId: string;
  channelId: string;
  speakerUserId: string;
  audio: Buffer;
  format: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
}

export type VoiceReceiveAudioPreprocessResult =
  | {
      shouldTranscribe: true;
      audio: Buffer;
      format: string;
      durationMs?: number;
      metadata?: Record<string, unknown>;
    }
  | {
      shouldTranscribe: false;
      reason: string;
      metadata?: Record<string, unknown>;
    };

export type VoiceReceiveAudioPreprocessor = (
  input: VoiceReceiveAudioPreprocessInput,
) => Promise<VoiceReceiveAudioPreprocessResult> | VoiceReceiveAudioPreprocessResult;

interface ActiveReceiveSession {
  guildId: string;
  channelId: string;
  session: VoiceSession;
  connection: VoiceReceiveBridgeConnection;
  onStart: (userId: string) => void;
  activeUsers: Set<string>;
}

const DEFAULT_RECEIVE_FORMAT = "discord-opus-packets";
const DEFAULT_SILENCE_MS = 900;
const DEFAULT_MIN_AUDIO_BYTES = 20;
const DEFAULT_MAX_AUDIO_BYTES = 2_000_000;

export class VoiceReceiveBridge {
  private readonly sessions = new Map<string, ActiveReceiveSession>();

  constructor(private readonly options: VoiceReceiveBridgeOptions) {}

  attach(input: VoiceReceiveBridgeAttachInput): void {
    this.detach(input.guildId);
    if (!input.session.policy.canTranscribe) return;

    const connection = input.connection as VoiceReceiveBridgeConnection;
    const active: ActiveReceiveSession = {
      guildId: input.guildId,
      channelId: input.channelId,
      session: input.session,
      connection,
      onStart: (userId) => this.handleSpeakingStart(input.guildId, userId),
      activeUsers: new Set(),
    };
    connection.receiver.speaking.on("start", active.onStart);
    this.sessions.set(input.guildId, active);
    this.options.logger?.info({ guildId: input.guildId, channelId: input.channelId }, "voice receive bridge attached");
  }

  detach(guildId: string): void {
    const active = this.sessions.get(guildId);
    if (!active) return;
    active.connection.receiver.speaking.off?.("start", active.onStart);
    active.connection.receiver.speaking.removeListener?.("start", active.onStart);
    active.activeUsers.clear();
    this.sessions.delete(guildId);
    this.options.logger?.info({ guildId }, "voice receive bridge detached");
  }

  isAttached(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  private handleSpeakingStart(guildId: string, userId: string): void {
    const active = this.sessions.get(guildId);
    if (!active) return;
    if (this.shouldIgnoreUser(userId)) return;
    if (active.activeUsers.has(userId)) return;
    active.activeUsers.add(userId);

    const startedAt = this.options.now?.() ?? new Date();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;

    let stream: VoiceReceiveStream;
    try {
      stream = active.connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: this.options.silenceDurationMs ?? DEFAULT_SILENCE_MS,
        },
      });
    } catch (err) {
      active.activeUsers.delete(userId);
      this.options.logger?.warn({ err: toErrorMessage(err), guildId, userId }, "voice receive subscribe failed");
      return;
    }

    stream.on("data", (chunk: Buffer | Uint8Array) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > (this.options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES)) {
        tooLarge = true;
        stream.destroy(new Error("voice receive buffer exceeded maxAudioBytes"));
        return;
      }
      chunks.push(buffer);
    });
    stream.once("end", () => {
      void this.processBufferedSpeech(active, userId, chunks, startedAt).catch((err) => {
        active.activeUsers.delete(userId);
        this.options.logger?.warn({ err: toErrorMessage(err), guildId, userId }, "voice receive processing failed");
      });
    });
    stream.once("error", (err) => {
      active.activeUsers.delete(userId);
      this.options.logger?.warn({ err: toErrorMessage(err), guildId, userId }, "voice receive stream failed");
    });
    stream.once("close", () => {
      if (tooLarge) active.activeUsers.delete(userId);
    });
  }

  private async processBufferedSpeech(
    active: ActiveReceiveSession,
    speakerUserId: string,
    chunks: Buffer[],
    startedAt: Date,
  ): Promise<void> {
    active.activeUsers.delete(speakerUserId);
    const audio = Buffer.concat(chunks);
    if (audio.length < (this.options.minAudioBytes ?? DEFAULT_MIN_AUDIO_BYTES)) {
      this.options.logger?.debug({ guildId: active.guildId, speakerUserId, bytes: audio.length }, "voice buffer too small");
      return;
    }

    const finishedAt = this.options.now?.() ?? new Date();
    const rawFormat = this.options.receiveFormat ?? DEFAULT_RECEIVE_FORMAT;
    const rawDurationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const preprocessed = await (this.options.preprocessAudio ?? defaultVoiceReceivePreprocessor)({
      guildId: active.guildId,
      channelId: active.channelId,
      speakerUserId,
      audio,
      format: rawFormat,
      startedAt,
      finishedAt,
      durationMs: rawDurationMs,
    });
    if (!preprocessed.shouldTranscribe) {
      this.options.logger?.debug(
        { guildId: active.guildId, speakerUserId, reason: preprocessed.reason, metadata: preprocessed.metadata },
        "voice receive preprocessing skipped transcript",
      );
      return;
    }

    const ctx = await this.buildVoiceContext(active, speakerUserId, "");
    const transcriptResult = await this.options.transcribeBufferedAudio(ctx, {
      audio: preprocessed.audio,
      format: preprocessed.format,
      speakerUserId,
      durationMs: preprocessed.durationMs ?? rawDurationMs,
      metadata: {
        voiceReceive: {
          rawFormat,
          processedFormat: preprocessed.format,
          rawBytes: audio.length,
          processedBytes: preprocessed.audio.length,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
        },
        ...(preprocessed.metadata ?? {}),
      },
    });
    if (!transcriptResult.ok || !transcriptResult.transcript?.text.trim()) {
      this.options.logger?.debug(
        { guildId: active.guildId, speakerUserId, reason: transcriptResult.message },
        "voice transcript skipped",
      );
      return;
    }

    const transcript = transcriptResult.transcript.text.trim();
    const routedCtx = await this.buildVoiceContext(active, speakerUserId, transcript);
    const reply = await this.options.agent.handleDiscordMessage(routedCtx, {
      transcript: `[voice:${speakerUserId}] ${transcript}`,
    });

    if (active.session.policy.canSpeak && this.options.speechQueue && reply.content.trim()) {
      const enqueued = this.options.speechQueue.enqueue({
        guildId: active.guildId,
        channelId: active.channelId,
        requestedByUserId: speakerUserId,
        text: reply.content,
      });
      if (!enqueued.ok) {
        this.options.logger?.warn(
          { guildId: active.guildId, speakerUserId, reason: enqueued.message },
          "voice transcript reply could not be queued",
        );
      }
    }
  }

  private async buildVoiceContext(
    active: ActiveReceiveSession,
    speakerUserId: string,
    content: string,
  ): Promise<BotMessageContext> {
    const user = this.options.client?.users.cache.get(speakerUserId);
    const guildSettings = this.options.getGuildSettings ? await this.options.getGuildSettings(active.guildId) : undefined;
    const timestamp = (this.options.now?.() ?? new Date()).getTime();
    return {
      guildId: active.guildId,
      guildName: null,
      channelId: active.channelId,
      channelName: "voice",
      userId: speakerUserId,
      username: user?.username ?? `voice-user-${speakerUserId}`,
      displayName: user?.globalName ?? user?.username ?? null,
      messageId: `voice-${active.guildId}-${active.channelId}-${speakerUserId}-${timestamp}`,
      content,
      isDM: false,
      mentionsBot: false,
      memberPermissions: ["SEND_MESSAGES"],
      ...(guildSettings ? { guildSettings } : {}),
    };
  }

  private shouldIgnoreUser(userId: string): boolean {
    return Boolean(this.options.client?.user?.id && this.options.client.user.id === userId);
  }
}

function defaultVoiceReceivePreprocessor(input: VoiceReceiveAudioPreprocessInput): VoiceReceiveAudioPreprocessResult {
  return {
    shouldTranscribe: true,
    audio: input.audio,
    format: input.format,
    durationMs: input.durationMs,
    metadata: {
      preprocessing: "pass-through",
      vad: "not-configured",
      decoder: "external-stt-provider",
    },
  };
}
