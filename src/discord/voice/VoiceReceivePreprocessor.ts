import type {
  VoiceReceiveAudioPreprocessInput,
  VoiceReceiveAudioPreprocessResult,
} from "./VoiceReceiveBridge";

export interface HttpVoiceReceivePreprocessorOptions {
  endpointUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpVoiceReceivePreprocessor {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpVoiceReceivePreprocessorOptions) {
    if (!options.endpointUrl) throw new Error("VOICE_RECEIVE_PREPROCESS_ENDPOINT is required");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call(input: VoiceReceiveAudioPreprocessInput): Promise<VoiceReceiveAudioPreprocessResult> {
    const response = await this.fetchImpl(this.options.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        audioBase64: input.audio.toString("base64"),
        format: input.format,
        guildId: input.guildId,
        channelId: input.channelId,
        speakerUserId: input.speakerUserId,
        startedAt: input.startedAt.toISOString(),
        finishedAt: input.finishedAt.toISOString(),
        durationMs: input.durationMs,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      throw new Error(`voice preprocessing endpoint failed: HTTP ${response.status} ${stringifyBody(body)}`.trim());
    }
    return normalizePreprocessResult(body, input);
  }
}

export function normalizePreprocessResult(
  body: unknown,
  input: Pick<VoiceReceiveAudioPreprocessInput, "audio" | "format" | "durationMs">,
): VoiceReceiveAudioPreprocessResult {
  if (!body || typeof body !== "object") {
    throw new Error("voice preprocessing endpoint returned a non-JSON result");
  }
  const json = body as Record<string, unknown>;
  if (json.shouldTranscribe === false) {
    return {
      shouldTranscribe: false,
      reason: typeof json.reason === "string" && json.reason.trim() ? json.reason.trim() : "preprocessor-skipped",
      metadata: normalizeMetadata(json.metadata),
    };
  }

  const audioBase64 = typeof json.audioBase64 === "string" && json.audioBase64.trim() ? json.audioBase64 : null;
  const audio = audioBase64 ? Buffer.from(audioBase64, "base64") : input.audio;
  if (audio.length === 0) throw new Error("voice preprocessing endpoint returned empty audio");
  const format = typeof json.format === "string" && json.format.trim() ? json.format.trim() : input.format;
  return {
    shouldTranscribe: true,
    audio,
    format,
    durationMs: typeof json.durationMs === "number" && Number.isFinite(json.durationMs) ? json.durationMs : input.durationMs,
    metadata: normalizeMetadata(json.metadata),
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringifyBody(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return String(body).slice(0, 300);
  }
}
