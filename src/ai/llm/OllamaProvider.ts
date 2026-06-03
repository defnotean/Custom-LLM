import { z } from "zod";
import type { Logger } from "pino";
import type { LLMChatRequest, LLMChatResponse, LLMProviderInfo } from "../../types/ai";
import { LLMProviderError, toErrorMessage } from "../../utils/errors";
import type { LLMProvider } from "./LLMProvider";

/** Provider for Ollama's native /api/chat endpoint. */

const ollamaResponseSchema = z.object({
  model: z.string().optional(),
  message: z.object({
    role: z.string().optional(),
    content: z.string().default(""),
  }),
  done_reason: z.string().optional(),
  done: z.boolean().optional(),
});

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export class OllamaProvider implements LLMProvider {
  readonly info: LLMProviderInfo;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.info = { name: "ollama", model: this.model, baseUrl: this.baseUrl };
  }

  async generateChatCompletion(request: LLMChatRequest): Promise<LLMChatResponse> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      // Ollama supports system/user/assistant/tool roles natively.
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      ...(request.responseFormat === "json" ? { format: "json" } : {}),
      options: {
        temperature: request.temperature ?? 0.7,
        ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
        ...(request.stop && request.stop.length > 0 ? { stop: request.stop } : {}),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LLMProviderError(
        `Ollama unreachable at ${this.baseUrl}: ${toErrorMessage(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMProviderError(`Ollama returned ${res.status}: ${text.slice(0, 500)}`);
    }

    const raw: unknown = await res.json().catch((err: unknown) => {
      throw new LLMProviderError(`Ollama returned non-JSON body: ${toErrorMessage(err)}`);
    });

    const parsed = ollamaResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMProviderError(
        `Unexpected Ollama response shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
    }

    return {
      content: parsed.data.message.content,
      raw,
      latencyMs: Date.now() - started,
      model: parsed.data.model ?? request.model ?? this.model,
      finishReason: parsed.data.done_reason ?? (parsed.data.done ? "stop" : "unknown"),
    };
  }
}
