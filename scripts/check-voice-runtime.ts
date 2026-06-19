import { readFile } from "node:fs/promises";
import pino from "pino";
import { env } from "../src/config/env";
import { HttpVoiceReceivePreprocessor } from "../src/discord/voice/VoiceReceivePreprocessor";
import { runVoiceRuntimeSmoke } from "../src/discord/voice/VoiceRuntimeSmoke";
import { HttpSttProvider } from "../src/discord/voice/VoiceSttTranscription";
import { HttpTtsProvider } from "../src/discord/voice/VoiceTtsPlayback";

interface CliOptions {
  ttsEndpoint: string;
  ttsApiKey: string;
  ttsVoice: string;
  ttsFormat: string;
  ttsTimeoutMs: number;
  ttsText: string;
  sttEndpoint: string;
  sttApiKey: string;
  sttModel: string;
  sttLanguage: string;
  sttTimeoutMs: number;
  preprocessEndpoint: string;
  preprocessApiKey: string;
  preprocessTimeoutMs: number;
  receiveFormat: string;
  audioBase64?: string;
  audioFile?: string;
}

const DEFAULT_SAMPLE_AUDIO = Buffer.from("irene voice runtime smoke audio", "utf8");

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const sampleAudio = await loadSampleAudio(options);
  const tts = options.ttsEndpoint
    ? new HttpTtsProvider({
        endpointUrl: options.ttsEndpoint,
        apiKey: options.ttsApiKey,
        voice: options.ttsVoice,
        format: options.ttsFormat,
        timeoutMs: options.ttsTimeoutMs,
      })
    : null;
  const stt = options.sttEndpoint
    ? new HttpSttProvider({
        endpointUrl: options.sttEndpoint,
        apiKey: options.sttApiKey,
        model: options.sttModel || undefined,
        language: options.sttLanguage,
        format: options.receiveFormat,
        timeoutMs: options.sttTimeoutMs,
      })
    : null;
  const preprocessor = options.preprocessEndpoint
    ? new HttpVoiceReceivePreprocessor({
        endpointUrl: options.preprocessEndpoint,
        apiKey: options.preprocessApiKey,
        timeoutMs: options.preprocessTimeoutMs,
      })
    : null;

  const report = await runVoiceRuntimeSmoke({
    tts,
    stt,
    preprocessor,
    sampleAudio,
    receiveFormat: options.receiveFormat,
    ttsText: options.ttsText,
    logger,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));

  if (report.status !== "pass") {
    const failures = report.checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.id}: ${check.summary}`)
      .join("; ");
    throw new Error(`Voice runtime smoke failed: ${failures}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    ttsEndpoint: env.VOICE_TTS_ENDPOINT,
    ttsApiKey: env.VOICE_TTS_API_KEY,
    ttsVoice: env.VOICE_TTS_VOICE,
    ttsFormat: env.VOICE_TTS_FORMAT,
    ttsTimeoutMs: env.VOICE_TTS_TIMEOUT_MS,
    ttsText: "Irene voice runtime smoke test.",
    sttEndpoint: env.VOICE_STT_ENDPOINT,
    sttApiKey: env.VOICE_STT_API_KEY,
    sttModel: env.VOICE_STT_MODEL,
    sttLanguage: env.VOICE_STT_LANGUAGE,
    sttTimeoutMs: env.VOICE_STT_TIMEOUT_MS,
    preprocessEndpoint: env.VOICE_RECEIVE_PREPROCESS_ENDPOINT,
    preprocessApiKey: env.VOICE_RECEIVE_PREPROCESS_API_KEY,
    preprocessTimeoutMs: env.VOICE_RECEIVE_PREPROCESS_TIMEOUT_MS,
    receiveFormat: env.VOICE_RECEIVE_FORMAT,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--tts-endpoint") options.ttsEndpoint = requireValue(argv[++index], arg);
    else if (arg === "--tts-api-key") options.ttsApiKey = requireValue(argv[++index], arg);
    else if (arg === "--tts-voice") options.ttsVoice = requireValue(argv[++index], arg);
    else if (arg === "--tts-format") options.ttsFormat = requireValue(argv[++index], arg);
    else if (arg === "--tts-timeout-ms") options.ttsTimeoutMs = parsePositiveInt(argv[++index], arg);
    else if (arg === "--tts-text") options.ttsText = requireValue(argv[++index], arg);
    else if (arg === "--stt-endpoint") options.sttEndpoint = requireValue(argv[++index], arg);
    else if (arg === "--stt-api-key") options.sttApiKey = requireValue(argv[++index], arg);
    else if (arg === "--stt-model") options.sttModel = requireValue(argv[++index], arg);
    else if (arg === "--stt-language") options.sttLanguage = requireValue(argv[++index], arg);
    else if (arg === "--stt-timeout-ms") options.sttTimeoutMs = parsePositiveInt(argv[++index], arg);
    else if (arg === "--preprocess-endpoint") options.preprocessEndpoint = requireValue(argv[++index], arg);
    else if (arg === "--preprocess-api-key") options.preprocessApiKey = requireValue(argv[++index], arg);
    else if (arg === "--preprocess-timeout-ms") options.preprocessTimeoutMs = parsePositiveInt(argv[++index], arg);
    else if (arg === "--receive-format") options.receiveFormat = requireValue(argv[++index], arg);
    else if (arg === "--audio-base64") options.audioBase64 = requireValue(argv[++index], arg);
    else if (arg === "--audio-file") options.audioFile = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.audioBase64 && options.audioFile) throw new Error("--audio-base64 and --audio-file are mutually exclusive");
  return options;
}

async function loadSampleAudio(options: Pick<CliOptions, "audioBase64" | "audioFile">): Promise<Buffer> {
  if (options.audioBase64) {
    const buffer = Buffer.from(options.audioBase64, "base64");
    if (buffer.length === 0) throw new Error("--audio-base64 decoded to an empty buffer");
    return buffer;
  }
  if (options.audioFile) {
    const buffer = await readFile(options.audioFile);
    if (buffer.length === 0) throw new Error("--audio-file points to an empty file");
    return buffer;
  }
  return DEFAULT_SAMPLE_AUDIO;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
