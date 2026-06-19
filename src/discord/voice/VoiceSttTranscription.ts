export interface VoiceTranscriptionRequest {
  guildId: string;
  channelId: string;
  speakerUserId?: string;
  requestedByUserId?: string;
  audio: Buffer;
  format: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface VoiceTranscriptionResult {
  text: string;
  confidence?: number;
  language?: string;
  durationMs?: number;
  raw?: unknown;
}

export interface SttProvider {
  transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult>;
}

export interface HttpSttProviderOptions {
  endpointUrl: string;
  apiKey?: string;
  model?: string;
  language?: string;
  format?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpSttProvider implements SttProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpSttProviderOptions) {
    if (!options.endpointUrl) throw new Error("VOICE_STT_ENDPOINT is required");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    if (request.audio.length === 0) throw new Error("audio buffer is empty");
    const response = await this.fetchImpl(this.options.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        audioBase64: request.audio.toString("base64"),
        format: request.format || this.options.format || "ogg-opus",
        ...(this.options.model ? { model: this.options.model } : {}),
        language: request.language ?? this.options.language ?? "auto",
        metadata: {
          guildId: request.guildId,
          channelId: request.channelId,
          ...(request.speakerUserId ? { speakerUserId: request.speakerUserId } : {}),
          ...(request.requestedByUserId ? { requestedByUserId: request.requestedByUserId } : {}),
          ...(request.metadata ?? {}),
        },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      throw new Error(`STT endpoint failed: HTTP ${response.status} ${stringifyBody(body)}`.trim());
    }
    return normalizeTranscript(body);
  }
}

function normalizeTranscript(body: unknown): VoiceTranscriptionResult {
  if (!body || typeof body !== "object") throw new Error("STT endpoint returned a non-JSON transcript");
  const json = body as Record<string, unknown>;
  const text = typeof json.text === "string" ? json.text.trim() : "";
  if (!text) throw new Error("STT endpoint returned an empty transcript");
  return {
    text,
    ...(typeof json.confidence === "number" ? { confidence: json.confidence } : {}),
    ...(typeof json.language === "string" ? { language: json.language } : {}),
    ...(typeof json.durationMs === "number" ? { durationMs: json.durationMs } : {}),
    raw: body,
  };
}

function stringifyBody(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return String(body).slice(0, 300);
  }
}
