import { describe, expect, it } from "vitest";
import { VoiceSpeechQueue, type VoiceSpeechJob } from "../src/discord/voice/VoiceSpeechQueue";

describe("VoiceSpeechQueue", () => {
  it("plays accepted jobs through the injected player", async () => {
    const played: VoiceSpeechJob[] = [];
    let now = Date.parse("2026-06-18T12:00:00.000Z");
    const queue = new VoiceSpeechQueue(
      {
        play: async (job) => {
          played.push(job);
        },
      },
      { now: () => now, makeId: () => "speech-1", cooldownMs: 0 },
    );

    const result = queue.enqueue({
      guildId: "guild-1",
      channelId: "voice-1",
      requestedByUserId: "user-1",
      text: "  deploy is green  ",
    });

    expect(result).toMatchObject({ ok: true, position: 1 });
    await Promise.resolve();
    expect(played).toMatchObject([
      {
        id: "speech-1",
        guildId: "guild-1",
        channelId: "voice-1",
        requestedByUserId: "user-1",
        text: "deploy is green",
        createdAt: "2026-06-18T12:00:00.000Z",
      },
    ]);
    expect(queue.status("guild-1")).toEqual({ activeJobId: null, activeText: null, queued: 0 });
    now += 1;
  });

  it("enforces text length, cooldown, and queue depth", async () => {
    let now = 1000;
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new VoiceSpeechQueue(
      {
        play: async () => {
          await firstDone;
        },
      },
      { now: () => now, makeId: () => `job-${now}`, maxTextChars: 8, maxQueueDepth: 2, cooldownMs: 500 },
    );

    expect(
      queue.enqueue({
        guildId: "guild-1",
        channelId: "voice-1",
        requestedByUserId: "user-1",
        text: "too many chars",
      }),
    ).toMatchObject({ ok: false, reason: "text_too_long" });

    expect(
      queue.enqueue({
        guildId: "guild-1",
        channelId: "voice-1",
        requestedByUserId: "user-1",
        text: "first",
      }),
    ).toMatchObject({ ok: true, position: 1 });

    expect(
      queue.enqueue({
        guildId: "guild-1",
        channelId: "voice-1",
        requestedByUserId: "user-1",
        text: "second",
      }),
    ).toMatchObject({ ok: false, reason: "cooldown" });

    now += 600;
    expect(
      queue.enqueue({
        guildId: "guild-1",
        channelId: "voice-1",
        requestedByUserId: "user-1",
        text: "second",
      }),
    ).toMatchObject({ ok: true, position: 2 });

    now += 600;
    expect(
      queue.enqueue({
        guildId: "guild-1",
        channelId: "voice-1",
        requestedByUserId: "user-1",
        text: "third",
      }),
    ).toMatchObject({ ok: false, reason: "queue_full" });

    releaseFirst();
    await Promise.resolve();
  });

  it("clears queued speech and calls the player stop hook", async () => {
    const stopped: string[] = [];
    const queue = new VoiceSpeechQueue(
      {
        play: async () => undefined,
        stopGuild: async (guildId) => {
          stopped.push(guildId);
        },
      },
      { cooldownMs: 0 },
    );

    queue.enqueue({
      guildId: "guild-1",
      channelId: "voice-1",
      requestedByUserId: "user-1",
      text: "stop this",
    });
    await queue.stopGuild("guild-1");

    expect(stopped).toEqual(["guild-1"]);
    expect(queue.status("guild-1")).toEqual({ activeJobId: null, activeText: null, queued: 0 });
  });

  it("captures playback errors without leaving the queue active", async () => {
    const failures: Array<{ jobId: string; message: string }> = [];
    const queue = new VoiceSpeechQueue(
      {
        play: async () => {
          throw new Error("speaker backend down");
        },
      },
      {
        cooldownMs: 0,
        makeId: () => "speech-fail",
        onPlaybackError: (job, err) => {
          failures.push({ jobId: job.id, message: err instanceof Error ? err.message : String(err) });
        },
      },
    );

    expect(
      queue.enqueue({
        guildId: "guild-1",
        channelId: "voice-1",
        requestedByUserId: "user-1",
        text: "this will fail",
      }),
    ).toMatchObject({ ok: true });
    await Promise.resolve();

    expect(failures).toEqual([{ jobId: "speech-fail", message: "speaker backend down" }]);
    expect(queue.status("guild-1")).toEqual({ activeJobId: null, activeText: null, queued: 0 });
  });
});
