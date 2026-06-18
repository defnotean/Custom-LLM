import { describe, expect, it } from "vitest";
import { resolveVoicePolicy, VoiceSessionRegistry } from "../src/discord/voice/VoiceSessionPolicy";

describe("voice session policy", () => {
  it("denies voice by default because guild voice must be opt-in", () => {
    const policy = resolveVoicePolicy({ guildId: "guild-1", channelId: "voice-1" });

    expect(policy.allowed).toBe(false);
    expect(policy.reason).toBe("voice-disabled");
    expect(policy.rawAudioRetention).toBe("transient");
    expect(policy.trainingUseRequiresReview).toBe(true);
  });

  it("allows join and TTS in explicitly enabled channels without enabling listening", () => {
    const policy = resolveVoicePolicy({
      guildId: "guild-1",
      channelId: "voice-1",
      requestedMode: "speak",
      settings: {
        enabled: true,
        allowChannels: ["voice-1"],
        ttsEnabled: true,
      },
    });

    expect(policy.allowed).toBe(true);
    expect(policy.canJoin).toBe(true);
    expect(policy.canSpeak).toBe(true);
    expect(policy.canListen).toBe(false);
    expect(policy.canTranscribe).toBe(false);
    expect(policy.canQueueForTrainingReview).toBe(false);
  });

  it("requires explicit listen and transcription opt-in before retaining transcripts", () => {
    const policy = resolveVoicePolicy({
      guildId: "guild-1",
      channelId: "voice-2",
      requestedMode: "transcribe",
      settings: {
        enabled: true,
        allowChannels: ["voice-2"],
        listenEnabled: true,
        transcriptionEnabled: true,
        retainTranscripts: true,
        retainSummaries: true,
        allowTrainingUse: true,
        requireWakeWord: true,
      },
    });

    expect(policy).toMatchObject({
      allowed: true,
      canListen: true,
      canTranscribe: true,
      canRetainTranscript: true,
      canRetainSummary: true,
      canQueueForTrainingReview: true,
      requireWakeWord: true,
      rawAudioRetention: "transient",
      trainingUseRequiresReview: true,
    });
  });

  it("rejects channels outside the guild allowlist", () => {
    const policy = resolveVoicePolicy({
      guildId: "guild-1",
      channelId: "voice-2",
      settings: { enabled: true, allowChannels: ["voice-1"] },
    });

    expect(policy.allowed).toBe(false);
    expect(policy.reason).toBe("voice-channel-not-allowed");
  });

  it("records and stops active voice sessions without retaining audio", () => {
    const registry = new VoiceSessionRegistry();
    const result = registry.start({
      guildId: "guild-1",
      channelId: "voice-1",
      startedByUserId: "user-1",
      now: new Date("2026-06-18T12:00:00.000Z"),
      settings: { enabled: true, allowChannels: ["voice-1"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected voice session to start");
    expect(result.session.startedAt).toBe("2026-06-18T12:00:00.000Z");
    expect(result.session.policy.rawAudioRetention).toBe("transient");
    expect(registry.get("guild-1")).toMatchObject({ channelId: "voice-1" });
    expect(registry.stop("guild-1")).toMatchObject({ channelId: "voice-1" });
    expect(registry.get("guild-1")).toBeNull();
  });
});
