export type VoiceSpeakerAttributionConfidence = "high" | "medium";

export interface VoiceSpeakerAttributionInput {
  guildId: string;
  channelId: string;
  speakerUserId: string;
  startedAt: Date;
  finishedAt: Date;
  overlappingSpeakerUserIds?: Iterable<string>;
  maxConcurrentSpeakers?: number;
  maxAllowedConcurrentSpeakers?: number;
  botUserId?: string | null;
}

export type VoiceSpeakerAttributionResult =
  | {
      ok: true;
      speakerUserId: string;
      confidence: VoiceSpeakerAttributionConfidence;
      metadata: VoiceSpeakerAttributionMetadata;
    }
  | {
      ok: false;
      reason: string;
      metadata: VoiceSpeakerAttributionMetadata;
    };

export interface VoiceSpeakerAttributionMetadata {
  source: "discord-receiver-speaking-event";
  guildId: string;
  channelId: string;
  speakerUserId: string;
  confidence: VoiceSpeakerAttributionConfidence | "none";
  overlappingSpeakerUserIds: string[];
  maxConcurrentSpeakers: number;
  maxAllowedConcurrentSpeakers: number;
  startedAt: string;
  finishedAt: string;
}

const DEFAULT_MAX_CONCURRENT_SPEAKERS = 2;

export function assessVoiceSpeakerAttribution(input: VoiceSpeakerAttributionInput): VoiceSpeakerAttributionResult {
  const speakerUserId = input.speakerUserId.trim();
  const overlappingSpeakerUserIds = unique(
    [...(input.overlappingSpeakerUserIds ?? [])]
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value !== speakerUserId && value !== input.botUserId),
  );
  const maxAllowedConcurrentSpeakers = input.maxAllowedConcurrentSpeakers ?? DEFAULT_MAX_CONCURRENT_SPEAKERS;
  const maxConcurrentSpeakers = Math.max(input.maxConcurrentSpeakers ?? 1, overlappingSpeakerUserIds.length + 1);
  const baseMetadata = {
    source: "discord-receiver-speaking-event" as const,
    guildId: input.guildId,
    channelId: input.channelId,
    speakerUserId,
    overlappingSpeakerUserIds,
    maxConcurrentSpeakers,
    maxAllowedConcurrentSpeakers,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
  };

  if (!speakerUserId) {
    return {
      ok: false,
      reason: "speaker-attribution-missing-speaker",
      metadata: { ...baseMetadata, confidence: "none" },
    };
  }

  if (input.botUserId && speakerUserId === input.botUserId) {
    return {
      ok: false,
      reason: "speaker-attribution-bot-speaker",
      metadata: { ...baseMetadata, confidence: "none" },
    };
  }

  if (maxConcurrentSpeakers > maxAllowedConcurrentSpeakers) {
    return {
      ok: false,
      reason: "speaker-attribution-too-ambiguous",
      metadata: { ...baseMetadata, confidence: "none" },
    };
  }

  const confidence: VoiceSpeakerAttributionConfidence =
    overlappingSpeakerUserIds.length === 0 && maxConcurrentSpeakers <= 1 ? "high" : "medium";
  return {
    ok: true,
    speakerUserId,
    confidence,
    metadata: { ...baseMetadata, confidence },
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
