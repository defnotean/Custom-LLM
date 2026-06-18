import { Readable } from "stream";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  NoSubscriberBehavior,
  StreamType,
  type AudioPlayer,
  type AudioResource,
  type CreateAudioResourceOptions,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Logger } from "pino";
import { AppError, toErrorMessage, withTimeout } from "../../utils/errors";
import type { VoiceSpeechJob, VoiceSpeechPlayer } from "./VoiceSpeechQueue";

export type VoiceTtsStreamTypeName = "arbitrary" | "ogg/opus" | "opus" | "raw";

export interface TtsAudio {
  data: Buffer;
  contentType: string;
}

export interface TtsProvider {
  synthesize(job: VoiceSpeechJob): Promise<TtsAudio>;
}

export interface HttpTtsProviderOptions {
  endpointUrl: string;
  apiKey?: string;
  voice?: string;
  format?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpTtsProvider implements TtsProvider {
  private readonly endpointUrl: string;
  private readonly apiKey?: string;
  private readonly voice: string;
  private readonly format: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTtsProviderOptions) {
    this.endpointUrl = options.endpointUrl;
    this.apiKey = options.apiKey || undefined;
    this.voice = options.voice ?? "irene";
    this.format = options.format ?? "ogg-opus";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(job: VoiceSpeechJob): Promise<TtsAudio> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "audio/*, application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          text: job.text,
          voice: this.voice,
          format: this.format,
          metadata: {
            jobId: job.id,
            guildId: job.guildId,
            channelId: job.channelId,
            requestedByUserId: job.requestedByUserId,
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new AppError("VOICE_TTS_ERROR", `TTS request failed: ${toErrorMessage(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new AppError(
        "VOICE_TTS_ERROR",
        `TTS endpoint failed with HTTP ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const data = contentType.includes("application/json")
      ? parseJsonAudio(await response.text())
      : Buffer.from(await response.arrayBuffer());

    if (data.length === 0) throw new AppError("VOICE_TTS_ERROR", "TTS endpoint returned empty audio");
    return { data, contentType };
  }
}

export interface DiscordVoiceSpeechPlayerOptions {
  tts: TtsProvider;
  streamType?: VoiceTtsStreamTypeName;
  playbackTimeoutMs?: number;
  logger?: Logger;
  getConnection?: (guildId: string) => Pick<VoiceConnection, "subscribe"> | undefined;
  createPlayer?: () => AudioPlayer;
  createResource?: (
    input: Readable,
    options: CreateAudioResourceOptions<VoiceSpeechJob> & { metadata: VoiceSpeechJob },
  ) => AudioResource<VoiceSpeechJob>;
}

export class DiscordVoiceSpeechPlayer implements VoiceSpeechPlayer {
  private readonly tts: TtsProvider;
  private readonly streamType: StreamType;
  private readonly playbackTimeoutMs: number;
  private readonly logger?: Logger;
  private readonly getConnection: (guildId: string) => Pick<VoiceConnection, "subscribe"> | undefined;
  private readonly createPlayer: () => AudioPlayer;
  private readonly createResource: (
    input: Readable,
    options: CreateAudioResourceOptions<VoiceSpeechJob> & { metadata: VoiceSpeechJob },
  ) => AudioResource<VoiceSpeechJob>;
  private readonly players = new Map<string, AudioPlayer>();

  constructor(options: DiscordVoiceSpeechPlayerOptions) {
    this.tts = options.tts;
    this.streamType = mapStreamType(options.streamType ?? "arbitrary");
    this.playbackTimeoutMs = options.playbackTimeoutMs ?? 120_000;
    this.logger = options.logger;
    this.getConnection = options.getConnection ?? getVoiceConnection;
    this.createPlayer =
      options.createPlayer ??
      (() =>
        createAudioPlayer({
          behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
        }));
    this.createResource = options.createResource ?? createAudioResource;
  }

  async play(job: VoiceSpeechJob): Promise<void> {
    const connection = this.getConnection(job.guildId);
    if (!connection) throw new AppError("VOICE_NOT_CONNECTED", "Irene is not connected to voice for this server");

    const audio = await this.tts.synthesize(job);
    const player = this.createPlayer();
    this.players.set(job.guildId, player);
    connection.subscribe(player);

    const resource = this.createResource(Readable.from([audio.data]), {
      inputType: this.streamType,
      metadata: job,
    });
    const done = waitForPlayerIdle(player, this.playbackTimeoutMs);
    player.play(resource);
    this.logger?.debug(
      { guildId: job.guildId, jobId: job.id, contentType: audio.contentType },
      "voice speech playback started",
    );
    await done;
  }

  stopGuild(guildId: string): void {
    const player = this.players.get(guildId);
    player?.stop(true);
    this.players.delete(guildId);
  }
}

function parseJsonAudio(text: string): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AppError("VOICE_TTS_ERROR", "TTS endpoint returned invalid JSON audio payload", { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || !("audioBase64" in parsed)) {
    throw new AppError("VOICE_TTS_ERROR", "TTS JSON payload must include audioBase64");
  }
  const audioBase64 = (parsed as { audioBase64?: unknown }).audioBase64;
  if (typeof audioBase64 !== "string" || audioBase64.trim().length === 0) {
    throw new AppError("VOICE_TTS_ERROR", "TTS JSON payload has empty audioBase64");
  }
  return Buffer.from(audioBase64, "base64");
}

function mapStreamType(type: VoiceTtsStreamTypeName): StreamType {
  switch (type) {
    case "arbitrary":
      return StreamType.Arbitrary;
    case "ogg/opus":
      return StreamType.OggOpus;
    case "opus":
      return StreamType.Opus;
    case "raw":
      return StreamType.Raw;
  }
}

function waitForPlayerIdle(player: AudioPlayer, timeoutMs: number): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        player.off(AudioPlayerStatus.Idle, onIdle);
        player.off("error", onError);
      };
      player.once(AudioPlayerStatus.Idle, onIdle);
      player.once("error", onError);
    }),
    timeoutMs,
    "voice speech playback",
  );
}
