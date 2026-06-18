import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
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
  VoiceSessionRegistry,
} from "./VoiceSessionPolicy";
import { type VoiceSpeechQueue } from "./VoiceSpeechQueue";

export interface VoiceCommandResult {
  ok: boolean;
  message: string;
  policy?: ResolvedVoicePolicy;
}

export interface DiscordVoiceServiceOptions {
  settingsStore?: Pick<GuildRepository, "getSettings" | "updateSettings"> | null;
  registry?: VoiceSessionRegistry;
  speechQueue?: VoiceSpeechQueue | null;
  logger?: Logger;
  readyTimeoutMs?: number;
}

export class DiscordVoiceService {
  private readonly settingsStore: Pick<GuildRepository, "getSettings" | "updateSettings"> | null;
  private readonly registry: VoiceSessionRegistry;
  private readonly speechQueue: VoiceSpeechQueue | null;
  private readonly logger?: Logger;
  private readonly readyTimeoutMs: number;

  constructor(options: DiscordVoiceServiceOptions = {}) {
    this.settingsStore = options.settingsStore ?? null;
    this.registry = options.registry ?? new VoiceSessionRegistry();
    this.speechQueue = options.speechQueue ?? null;
    this.logger = options.logger;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
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
      this.registry.start({
        guildId: ctx.guildId,
        channelId: channel.id,
        startedByUserId: ctx.userId,
        settings,
      });
      return {
        ok: true,
        policy,
        message: `Irene joined <#${channel.id}>. Listening/transcription are ${policy.canTranscribe ? "enabled" : "off"}.`,
      };
    } catch (err) {
      getVoiceConnection(ctx.guildId)?.destroy();
      this.registry.stop(ctx.guildId);
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
        message: "TTS playback is not configured yet. Wire a VoiceSpeechQueue backend before using `!ai voice say`.",
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
