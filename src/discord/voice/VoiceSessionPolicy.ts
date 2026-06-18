export type VoiceRequestMode = "join" | "speak" | "listen" | "transcribe";
export type RawAudioRetention = "transient";

export interface GuildVoiceSettings {
  enabled?: boolean;
  allowChannels?: string[];
  ttsEnabled?: boolean;
  listenEnabled?: boolean;
  transcriptionEnabled?: boolean;
  retainTranscripts?: boolean;
  retainSummaries?: boolean;
  allowTrainingUse?: boolean;
  requireWakeWord?: boolean;
  visibleIndicator?: boolean;
  maxSessionMinutes?: number;
}

export interface ResolveVoicePolicyInput {
  guildId?: string | null;
  channelId: string;
  settings?: GuildVoiceSettings | null;
  requestedMode?: VoiceRequestMode;
}

export interface ResolvedVoicePolicy {
  allowed: boolean;
  reason: string;
  canJoin: boolean;
  canSpeak: boolean;
  canListen: boolean;
  canTranscribe: boolean;
  canRetainTranscript: boolean;
  canRetainSummary: boolean;
  canQueueForTrainingReview: boolean;
  trainingUseRequiresReview: true;
  rawAudioRetention: RawAudioRetention;
  visibleIndicator: boolean;
  requireWakeWord: boolean;
  maxSessionMinutes: number;
}

export interface VoiceSession {
  guildId: string;
  channelId: string;
  startedByUserId: string;
  startedAt: string;
  policy: ResolvedVoicePolicy;
}

export interface StartVoiceSessionInput extends ResolveVoicePolicyInput {
  guildId: string;
  startedByUserId: string;
  now?: Date;
}

export type StartVoiceSessionResult =
  | { ok: true; session: VoiceSession }
  | { ok: false; policy: ResolvedVoicePolicy };

const DEFAULT_MAX_SESSION_MINUTES = 60;

export function resolveVoicePolicy(input: ResolveVoicePolicyInput): ResolvedVoicePolicy {
  const settings = input.settings ?? {};
  const voiceEnabled = settings.enabled === true;
  const channelAllowed = isVoiceChannelAllowed(input.channelId, settings.allowChannels);
  const baseAllowed = Boolean(input.guildId) && voiceEnabled && channelAllowed;
  const canJoin = baseAllowed;
  const canSpeak = canJoin && settings.ttsEnabled !== false;
  const canListen = canJoin && settings.listenEnabled === true;
  const canTranscribe = canListen && settings.transcriptionEnabled === true;
  const canRetainTranscript = canTranscribe && settings.retainTranscripts === true;
  const canRetainSummary = canTranscribe && settings.retainSummaries === true;
  const canQueueForTrainingReview = canTranscribe && settings.allowTrainingUse === true;
  const policy: ResolvedVoicePolicy = {
    allowed: modeAllowed(input.requestedMode ?? "join", {
      canJoin,
      canSpeak,
      canListen,
      canTranscribe,
    }),
    reason: "voice-policy-ok",
    canJoin,
    canSpeak,
    canListen,
    canTranscribe,
    canRetainTranscript,
    canRetainSummary,
    canQueueForTrainingReview,
    trainingUseRequiresReview: true,
    rawAudioRetention: "transient",
    visibleIndicator: settings.visibleIndicator !== false,
    requireWakeWord: settings.requireWakeWord === true,
    maxSessionMinutes: normalizeMaxSessionMinutes(settings.maxSessionMinutes),
  };

  if (!input.guildId) return { ...policy, allowed: false, reason: "voice-requires-guild" };
  if (!voiceEnabled) return { ...policy, allowed: false, reason: "voice-disabled" };
  if (!channelAllowed) return { ...policy, allowed: false, reason: "voice-channel-not-allowed" };
  if (!policy.allowed) return { ...policy, reason: `voice-${input.requestedMode ?? "join"}-not-enabled` };
  return policy;
}

export class VoiceSessionRegistry {
  private readonly sessions = new Map<string, VoiceSession>();

  start(input: StartVoiceSessionInput): StartVoiceSessionResult {
    const policy = resolveVoicePolicy(input);
    if (!policy.allowed) return { ok: false, policy };

    const session: VoiceSession = {
      guildId: input.guildId,
      channelId: input.channelId,
      startedByUserId: input.startedByUserId,
      startedAt: (input.now ?? new Date()).toISOString(),
      policy,
    };
    this.sessions.set(input.guildId, session);
    return { ok: true, session };
  }

  stop(guildId: string): VoiceSession | null {
    const session = this.sessions.get(guildId) ?? null;
    this.sessions.delete(guildId);
    return session;
  }

  get(guildId: string): VoiceSession | null {
    return this.sessions.get(guildId) ?? null;
  }

  list(): VoiceSession[] {
    return [...this.sessions.values()];
  }
}

function isVoiceChannelAllowed(channelId: string, allowChannels?: string[]): boolean {
  if (!allowChannels || allowChannels.length === 0) return true;
  return allowChannels.includes(channelId);
}

function modeAllowed(
  mode: VoiceRequestMode,
  capability: Pick<ResolvedVoicePolicy, "canJoin" | "canSpeak" | "canListen" | "canTranscribe">,
): boolean {
  switch (mode) {
    case "join":
      return capability.canJoin;
    case "speak":
      return capability.canSpeak;
    case "listen":
      return capability.canListen;
    case "transcribe":
      return capability.canTranscribe;
  }
}

function normalizeMaxSessionMinutes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_SESSION_MINUTES;
  return Math.max(1, Math.min(24 * 60, Math.trunc(value)));
}
