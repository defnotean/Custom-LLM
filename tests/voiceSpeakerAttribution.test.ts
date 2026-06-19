import { describe, expect, it } from "vitest";
import { assessVoiceSpeakerAttribution } from "../src/discord/voice/VoiceSpeakerAttribution";

const startedAt = new Date("2026-06-19T12:00:00.000Z");
const finishedAt = new Date("2026-06-19T12:00:01.000Z");

describe("assessVoiceSpeakerAttribution", () => {
  it("accepts a single Discord receive speaker with high confidence", () => {
    const result = assessVoiceSpeakerAttribution({
      guildId: "guild-1",
      channelId: "voice-1",
      speakerUserId: "speaker-1",
      startedAt,
      finishedAt,
      maxConcurrentSpeakers: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      speakerUserId: "speaker-1",
      confidence: "high",
      metadata: {
        source: "discord-receiver-speaking-event",
        overlappingSpeakerUserIds: [],
        maxConcurrentSpeakers: 1,
      },
    });
  });

  it("keeps light crosstalk attributable with medium confidence", () => {
    const result = assessVoiceSpeakerAttribution({
      guildId: "guild-1",
      channelId: "voice-1",
      speakerUserId: "speaker-2",
      startedAt,
      finishedAt,
      overlappingSpeakerUserIds: ["speaker-1", "speaker-1"],
      maxConcurrentSpeakers: 2,
    });

    expect(result).toMatchObject({
      ok: true,
      speakerUserId: "speaker-2",
      confidence: "medium",
      metadata: {
        overlappingSpeakerUserIds: ["speaker-1"],
        maxConcurrentSpeakers: 2,
      },
    });
  });

  it("rejects bot audio and overly ambiguous overlap before transcription", () => {
    expect(
      assessVoiceSpeakerAttribution({
        guildId: "guild-1",
        channelId: "voice-1",
        speakerUserId: "bot-1",
        botUserId: "bot-1",
        startedAt,
        finishedAt,
      }),
    ).toMatchObject({ ok: false, reason: "speaker-attribution-bot-speaker" });

    expect(
      assessVoiceSpeakerAttribution({
        guildId: "guild-1",
        channelId: "voice-1",
        speakerUserId: "speaker-1",
        startedAt,
        finishedAt,
        overlappingSpeakerUserIds: ["speaker-2", "speaker-3"],
        maxConcurrentSpeakers: 3,
      }),
    ).toMatchObject({ ok: false, reason: "speaker-attribution-too-ambiguous" });
  });
});
