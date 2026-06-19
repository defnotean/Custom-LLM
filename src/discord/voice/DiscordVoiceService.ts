import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import type { Logger } from "pino";
import type { GuildRepository, GuildSettings } from "../../database/repositories/GuildRepository";
import type { BotMessageContext } from "../../types/discord";
import { toErrorMessage } from "../../utils/errors";
import {
  resolveVoicePolicy,
  type GuildVoiceSettings,
  type ResolvedVoicePolicy,
  type VoiceSession,
  VoiceSessionRegistry,
} from "./VoiceSessionPolicy";
import { type VoiceSpeechQueue } from "./VoiceSpeechQueue";
import type { SttProvider, VoiceTranscriptionResult } from "./VoiceSttTranscription";

export interface VoiceCommandResult {
  ok: boolean;
  message: string;
  policy?: ResolvedVoicePolicy;
  transcript?: VoiceTranscriptionResult;
}

export interface DiscordVoiceServiceOptions {
  settingsStore?: Pick<GuildRepository, "getSettings" | "updateSettings"> | null;
  registry?: VoiceSessionRegistry;
  speechQueue?: VoiceSpeechQueue | null;
  sttProvider?: SttProvider | null;
  receiveBridge?: VoiceReceiveBridgePort | null;
  presenceIndicator?: VoicePresenceIndicator | null;
  logger?: Logger;
  readyTimeoutMs?: number;
}

export interface VoiceReceiveBridgePort {
  attach(input: { guildId: string; channelId: string; connection: VoiceConnection; session: VoiceSession }): void;
  detach(guildId: string): void;
}

export interface VoicePresenceIndicator {
  showListening(input: { guildId: string; channelId: string }): unknown;
  clearListening(guildId: string): unknown;
}

export interface BufferedVoiceAudioInput {
  audio: Buffer;
  format: string;
  speakerUserId?: string;
  language?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export class DiscordVoiceService {
  private readonly settingsStore: Pick<GuildRepository, "getSettings" | "updateSettings"> | null;
  private readonly registry: VoiceSessionRegistry;
  private readonly speechQueue: VoiceSpeechQueue | null;
  private readonly sttProvider: SttProvider | null;
  private receiveBridge: VoiceReceiveBridgePort | null;
  private readonly presenceIndicator: VoicePresenceIndicator | null;
  private readonly logger?: Logger;
  private readonly readyTimeoutMs: number;

  constructor(options: DiscordVoiceServiceOptions = {}) {
    this.settingsStore = options.settingsStore ?? null;
    this.registry = options.registry ?? new VoiceSessionRegistry();
    this.speechQueue = options.speechQueue ?? null;
    this.sttProvider = options.sttProvider ?? null;
    this.receiveBridge = options.receiveBridge ?? null;
    this.presenceIndicator = options.presenceIndicator ?? null;
    this.logger = options.logger;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
  }

  setReceiveBridge(receiveBridge: VoiceReceiveBridgePort | null): void {
    this.receiveBridge = receiveBridge;
  }

  async enableCurrentChannel(ctx: BotMessageContext): Promise<VoiceCommandResult> {
    if (!canManageVoice(ctx)) return deniedByPermission();
    if (!ctx.guildId) return { ok: false, message: "Voice policy can only be changed in a server." };
    if (!this.settingsStore) {
      return { ok: false, message: "Voice policy persistence is unavailable because the database is not connected." };
    }

    const channel = getCallerVoiceChannel(ctx);
    if (!channel) return { ok: false, message: "Join the voice channel Irene should use, then run `!ai voice enable`." };

    const settings = await this.settingsStore.getSettings(ctx.guildId);
    const voice = settings.voice ?? {};
    const nextVoice: GuildVoiceSettings = {
      ...voice,
      enabled: true,
      allowChannels: unique([...(voice.allowChannels ?? []), channel.id]),
      ttsEnabled: voice.ttsEnabled ?? true,
      listenEnabled: voice.listenEnabled ?? false,
      transcriptionEnabled: voice.transcriptionEnabled ?? false,
      retainTranscripts: voice.retainTranscripts ?? false,
      retainSummaries: voice.retainSummaries ?? false,
      allowTrainingUse: voice.allowTrainingUse ?? false,
      visibleIndicator: voice.visibleIndicator ?? true,
    };
    await this.settingsStore.updateSettings(ctx.guildId, { ...settings, voice: nextVoice }, ctx.guildName ?? undefined);

    return {
      ok: true,
      message: [
        `Voice enabled for <#${channel.id}>.`,
        "Join/leave is allowed there; listening, transcription, retention, and training use remain off unless explicitly enabled in guild settings.",
      ].join(" "),
      policy: resolveVoicePolicy({ guildId: ctx.guildId, channelId: channel.id, settings: nextVoice }),
    };
  }

  async disableGuild(ctx: BotMessageContext): Promise<VoiceCommandResult> {
    if (!canManageVoice(ctx)) return deniedByPermission();
    if (!ctx.guildId) return { ok: false, message: "Voice policy can only be changed in a server." };
    if (!this.settingsStore) {
      return { ok: false, message: "Voice policy persistence is unavailable because the database is not connected." };
    }

    const settings = await this.settingsStore.getSettings(ctx.guildId);
    await this.settingsStore.updateSettings(
      ctx.guildId,
      { ...settings, voice: { ...(settings.voice ?? {}), enabled: false } },
      ctx.guildName ?? undefined,
    );
    this.leaveGuild(ctx);
    return { ok: true, message: "Voice disabled for this server and any active Irene voice session was closed." };
  }

  async describeCurrentPolicy(ctx: BotMessageContext): Promise<VoiceCommandResult> {
    if (!ctx.guildId) return { ok: false, message: "Voice policy only exists in servers." };
    const channel = getCallerVoiceChannel(ctx);
    const settings = await this.readVoiceSettings(ctx.guildId);
    const policy = resolveVoicePolicy({
      guildId: ctx.guildId,
      channelId: channel?.id ?? ctx.channelId,
      settings,
      requestedMode: "join",
    });

    return {
      ok: policy.allowed,
      policy,
      message: formatPolicy(policy, channel?.id),
    };
  }

  async joinCurrentChannel(ctx: BotMessageContext): Promise<VoiceCommandResult> {
    if (!canManageVoice(ctx)) return deniedByPermission();
    if (!ctx.guildId) return { ok: false, message: "Voice commands only work in servers." };

    const channel = getCallerVoiceChannel(ctx);
    if (!channel) return { ok: false, message: "Join a voice channel first, then run `!ai voice join`." };

    const settings = await this.readVoiceSettings(ctx.guildId);
    const policy = resolveVoicePolicy({
      guildId: ctx.guildId,
      channelId: channel.id,
      settings,
      requestedMode: "join",
    });
    if (!policy.allowed) {
      return {
        ok: false,
        policy,
        message: `Irene cannot join <#${channel.id}>: ${policy.reason}. Run \`!ai voice enable\` from that voice channel first.`,
      };
    }

    try {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: ctx.guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: !policy.canListen,
        selfMute: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, this.readyTimeoutMs);
      const started = this.registry.start({
        guildId: ctx.guildId,
        channelId: channel.id,
        startedByUserId: ctx.userId,
        settings,
      });
      if (started.ok) {
        this.receiveBridge?.attach({ guildId: ctx.guildId, channelId: channel.id, connection, session: started.session });
        this.syncPresenceIndicator(started.session);
      }
      return {
        ok: true,
        policy,
        message: `Irene joined <#${channel.id}>. Listening/transcription are ${policy.canTranscribe ? "enabled" : "off"}.`,
      };
    } catch (err) {
      getVoiceConnection(ctx.guildId)?.destroy();
      this.registry.stop(ctx.guildId);
      this.receiveBridge?.detach(ctx.guildId);
      this.presenceIndicator?.clearListening(ctx.guildId);
      this.logger?.warn({ err: toErrorMessage(err), guildId: ctx.guildId, channelId: channel.id }, "voice join failed");
      return { ok: false, policy, message: `Voice join failed: ${toErrorMessage(err)}` };
    }
  }

  leaveGuild(ctx: BotMessageContext): VoiceCommandResult {
    if (!canManageVoice(ctx)) return deniedByPermission();
    if (!ctx.guildId) return { ok: false, message: "Voice commands only work in servers." };
    const connection = getVoiceConnection(ctx.guildId);
    connection?.destroy();
    void this.speechQueue?.stopGuild(ctx.guildId);
    this.receiveBridge?.detach(ctx.guildId);
    this.presenceIndicator?.clearListening(ctx.guildId);
    const stopped = this.registry.stop(ctx.guildId);
    return {
      ok: true,
      message: stopped || connection ? "Irene left voice for this server." : "Irene is not in voice for this server.",
    };
  }

  async say(ctx: BotMessageContext, text: string): Promise<VoiceCommandResult> {
    if (!canManageVoice(ctx)) return deniedByPermission();
    if (!ctx.guildId) return { ok: false, message: "Voice commands only work in servers." };
    if (!this.speechQueue) {
      return {
        ok: false,
        message: "TTS playback is not configured. Set VOICE_TTS_ENDPOINT before using `!ai voice say`.",
      };
    }

    const activeSession = this.registry.get(ctx.guildId);
    if (!activeSession && !getVoiceConnection(ctx.guildId)) {
      return { ok: false, message: "Irene is not in voice. Run `!ai voice join` first." };
    }

    const channel = getCallerVoiceChannel(ctx);
    const channelId = activeSession?.channelId ?? channel?.id ?? ctx.channelId;
    const settings = await this.readVoiceSettings(ctx.guildId);
    const policy = resolveVoicePolicy({
      guildId: ctx.guildId,
      channelId,
      settings,
      requestedMode: "speak",
    });
    if (!policy.allowed) {
      return { ok: false, policy, message: `Irene cannot speak in voice: ${policy.reason}.` };
    }

    const result = this.speechQueue.enqueue({
      guildId: ctx.guildId,
      channelId,
      requestedByUserId: ctx.userId,
      text,
    });
    if (!result.ok) return { ok: false, policy, message: result.message };
    return {
      ok: true,
      policy,
      message: `Queued voice speech #${result.job.id} at position ${result.position}.`,
    };
  }

  async stopSpeaking(ctx: BotMessageContext): Promise<VoiceCommandResult> {
    if (!canManageVoice(ctx)) return deniedByPermission();
    if (!ctx.guildId) return { ok: false, message: "Voice commands only work in servers." };
    if (!this.speechQueue) return { ok: false, message: "TTS playback is not configured." };
    await this.speechQueue.stopGuild(ctx.guildId);
    return { ok: true, message: "Stopped Irene's queued voice speech for this server." };
  }

  async configureListening(ctx: BotMessageContext, enabled: boolean): Promise<VoiceCommandResult> {
    if (!canManageVoice(ctx)) return deniedByPermission();
    if (!ctx.guildId) return { ok: false, message: "Voice listening policy can only be changed in a server." };
    if (!this.settingsStore) {
      return { ok: false, message: "Voice policy persistence is unavailable because the database is not connected." };
    }
    if (enabled && !this.sttProvider) {
      return { ok: false, message: "STT is not configured. Set VOICE_STT_ENDPOINT before enabling voice listening." };
    }

    const channel = getCallerVoiceChannel(ctx);
    if (enabled && !channel) {
      return { ok: false, message: "Join the voice channel Irene should listen in, then run `!ai voice listen enable`." };
    }

    const settings = await this.settingsStore.getSettings(ctx.guildId);
    const voice = settings.voice ?? {};
    const channelId = channel?.id ?? this.registry.get(ctx.guildId)?.channelId ?? ctx.channelId;
    const nextVoice: GuildVoiceSettings = {
      ...voice,
      enabled: enabled ? true : voice.enabled,
      allowChannels: enabled ? unique([...(voice.allowChannels ?? []), channelId]) : voice.allowChannels,
      ttsEnabled: voice.ttsEnabled ?? true,
      listenEnabled: enabled,
      transcriptionEnabled: enabled,
      retainTranscripts: enabled ? false : voice.retainTranscripts ?? false,
      retainSummaries: enabled ? voice.retainSummaries ?? false : false,
      allowTrainingUse: enabled ? false : voice.allowTrainingUse ?? false,
      visibleIndicator: true,
    };
    await this.settingsStore.updateSettings(ctx.guildId, { ...settings, voice: nextVoice }, ctx.guildName ?? undefined);
    if (!enabled) {
      this.receiveBridge?.detach(ctx.guildId);
      this.presenceIndicator?.clearListening(ctx.guildId);
    }

    const policy = resolveVoicePolicy({
      guildId: ctx.guildId,
      channelId,
      settings: nextVoice,
      requestedMode: enabled ? "transcribe" : "listen",
    });
    return {
      ok: true,
      policy,
      message: enabled
        ? [
            `Voice listening and transcription are enabled for <#${channelId}>.`,
            "Raw audio remains transient. Transcript retention, summaries, and training use remain off until separately reviewed and enabled.",
            "If Irene is already connected, leave and rejoin so Discord updates the self-deafen state.",
          ].join(" ")
        : "Voice listening and transcription are disabled. Raw audio remains transient and transcript retention is off.",
    };
  }

  async listenStatus(ctx: BotMessageContext): Promise<VoiceCommandResult> {
    if (!ctx.guildId) return { ok: false, message: "Voice listening status only exists in servers." };
    const channel = getCallerVoiceChannel(ctx);
    const settings = await this.readVoiceSettings(ctx.guildId);
    const channelId = channel?.id ?? this.registry.get(ctx.guildId)?.channelId ?? ctx.channelId;
    const policy = resolveVoicePolicy({
      guildId: ctx.guildId,
      channelId,
      settings,
      requestedMode: "transcribe",
    });
    return {
      ok: true,
      policy,
      message: [
        `Voice listening status for <#${channelId}>: ${policy.canTranscribe ? "transcription enabled" : "transcription off"}.`,
        `STT backend: ${this.sttProvider ? "configured" : "not configured"}.`,
        `retainTranscript=${policy.canRetainTranscript ? "on" : "off"}`,
        `retainSummary=${policy.canRetainSummary ? "on" : "off"}`,
        `trainingReviewQueue=${policy.canQueueForTrainingReview ? "on" : "off"}`,
        `rawAudio=${policy.rawAudioRetention}`,
        `visibleIndicator=${policy.visibleIndicator ? "on" : "off"}`,
      ].join(" "),
    };
  }

  async transcribeBufferedAudio(ctx: BotMessageContext, input: BufferedVoiceAudioInput): Promise<VoiceCommandResult> {
    if (!ctx.guildId) return { ok: false, message: "Voice transcription only works in servers." };
    if (!this.sttProvider) {
      return { ok: false, message: "STT is not configured. Set VOICE_STT_ENDPOINT before transcribing audio." };
    }

    const activeSession = this.registry.get(ctx.guildId);
    const channel = getCallerVoiceChannel(ctx);
    const channelId = activeSession?.channelId ?? channel?.id ?? ctx.channelId;
    const settings = await this.readVoiceSettings(ctx.guildId);
    const policy = resolveVoicePolicy({
      guildId: ctx.guildId,
      channelId,
      settings,
      requestedMode: "transcribe",
    });
    if (!policy.allowed) {
      return { ok: false, policy, message: `Irene cannot transcribe voice: ${policy.reason}.` };
    }

    const transcript = await this.sttProvider.transcribe({
      guildId: ctx.guildId,
      channelId,
      speakerUserId: input.speakerUserId,
      requestedByUserId: ctx.userId,
      audio: input.audio,
      format: input.format,
      language: input.language,
      metadata: {
        ...(input.metadata ?? {}),
        durationMs: input.durationMs ?? null,
        retention: {
          rawAudio: policy.rawAudioRetention,
          transcript: policy.canRetainTranscript,
          summary: policy.canRetainSummary,
          trainingReviewQueue: policy.canQueueForTrainingReview,
        },
      },
    });
    return {
      ok: true,
      policy,
      transcript,
      message: `Transcribed ${input.durationMs ? `${Math.round(input.durationMs)}ms ` : ""}voice audio with ${transcript.text.length} characters. Retention: rawAudio=${policy.rawAudioRetention}, transcript=${policy.canRetainTranscript ? "on" : "off"}, trainingReviewQueue=${policy.canQueueForTrainingReview ? "on" : "off"}.`,
    };
  }

  status(ctx: BotMessageContext): VoiceCommandResult {
    if (!ctx.guildId) return { ok: false, message: "Voice status only exists in servers." };
    const session = this.registry.get(ctx.guildId);
    const connected = Boolean(getVoiceConnection(ctx.guildId));
    const speech = this.speechQueue?.status(ctx.guildId);
    if (!session && !connected) {
      return {
        ok: true,
        message: speech
          ? `Irene is not in voice for this server. Speech queue: active=${speech.activeJobId ?? "none"} queued=${speech.queued}.`
          : "Irene is not in voice for this server.",
      };
    }
    return {
      ok: true,
      message: [
        `Irene voice status: ${connected ? "connected" : "session-recorded"}.`,
        session ? `Channel: <#${session.channelId}>. Started: ${session.startedAt}.` : null,
        session ? `Listening: ${session.policy.canTranscribe ? "transcription enabled" : "off"}.` : null,
        speech ? `Speech: active=${speech.activeJobId ?? "none"} queued=${speech.queued}.` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join(" "),
    };
  }

  private async readVoiceSettings(guildId: string): Promise<GuildVoiceSettings> {
    if (!this.settingsStore) return {};
    const settings = await this.settingsStore.getSettings(guildId);
    return settings.voice ?? {};
  }

  private syncPresenceIndicator(session: VoiceSession): void {
    if (session.policy.canTranscribe && session.policy.visibleIndicator) {
      this.presenceIndicator?.showListening({ guildId: session.guildId, channelId: session.channelId });
      return;
    }
    this.presenceIndicator?.clearListening(session.guildId);
  }
}

function getCallerVoiceChannel(ctx: BotMessageContext): VoiceBasedChannel | null {
  return ctx.raw?.member?.voice.channel ?? null;
}

function canManageVoice(ctx: BotMessageContext): boolean {
  return ctx.memberPermissions.some((permission) =>
    ["ADMINISTRATOR", "MANAGE_GUILD", "MOVE_MEMBERS"].includes(permission),
  );
}

function deniedByPermission(): VoiceCommandResult {
  return {
    ok: false,
    message: "Only server managers or voice moderators can control Irene voice sessions.",
  };
}

function formatPolicy(policy: ResolvedVoicePolicy, channelId?: string): string {
  return [
    `Voice policy${channelId ? ` for <#${channelId}>` : ""}: ${policy.allowed ? "allowed" : `blocked (${policy.reason})`}.`,
    `speak=${policy.canSpeak ? "on" : "off"}`,
    `listen=${policy.canListen ? "on" : "off"}`,
    `transcribe=${policy.canTranscribe ? "on" : "off"}`,
    `retainTranscript=${policy.canRetainTranscript ? "on" : "off"}`,
    `trainingReviewQueue=${policy.canQueueForTrainingReview ? "on" : "off"}`,
    `rawAudio=${policy.rawAudioRetention}`,
  ].join(" ");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
