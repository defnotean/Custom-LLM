import { z } from "zod";
import type { Logger } from "pino";
import type { ChatMessage, LLMChatRequest, LLMChatResponse, LLMProviderInfo } from "../../types/ai";
import { LLMProviderError, toErrorMessage } from "../../utils/errors";
import type { LLMProvider } from "./LLMProvider";

/**
 * Provider for any OpenAI-compatible /v1/chat/completions endpoint:
 * vLLM, LM Studio, llama.cpp server, Ollama (with /v1 path), OpenRouter, etc.
 */

const completionResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string().optional(),
          content: z.string().nullable().optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z.unknown().optional(),
});

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  logger?: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly info: LLMProviderInfo;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? "local";
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.info = { name: "openai-compatible", model: this.model, baseUrl: this.baseUrl };
  }

  async generateChatCompletion(request: LLMChatRequest): Promise<LLMChatResponse> {
    const started = Date.now();
    // First attempt honors responseFormat; some local servers reject
    // response_format, so we retry once without it.
    try {
      return await this.callOnce(request, started, request.responseFormat === "json");
    } catch (err) {
      if (request.responseFormat === "json" && err instanceof LLMProviderError) {
        this.logger?.debug(
          { err: toErrorMessage(err) },
          "retrying chat completion without response_format",
        );
        return this.callOnce(request, started, false);
      }
      throw err;
    }
  }

  private async callOnce(
    request: LLMChatRequest,
    started: number,
    jsonMode: boolean,
  ): Promise<LLMChatResponse> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      messages: request.messages.map((m) => this.mapMessage(m)),
      temperature: request.temperature ?? 0.7,
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.stop && request.stop.length > 0 ? { stop: request.stop } : {}),
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      stream: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LLMProviderError(
        `LLM endpoint unreachable at ${this.baseUrl}: ${toErrorMessage(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMProviderError(
        `LLM endpoint returned ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    const raw: unknown = await res.json().catch((err: unknown) => {
      throw new LLMProviderError(`LLM endpoint returned non-JSON body: ${toErrorMessage(err)}`);
    });

    const parsed = completionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMProviderError(
        `Unexpected completion shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
    }

    const choice = parsed.data.choices[0];
    return {
      content: choice?.message.content ?? "",
      raw,
      latencyMs: Date.now() - started,
      model: parsed.data.model ?? request.model ?? this.model,
      finishReason: choice?.finish_reason ?? "unknown",
    };
  }

  /**
   * Local OpenAI-compatible servers vary in "tool" role support, so tool
   * results are mapped to clearly-labeled user messages for maximum
   * compatibility. (Native tool_call wire format is a future optimization.)
   */
  private mapMessage(m: ChatMessage): { role: string; content: string } {
    if (m.role === "tool") {
      return { role: "user", content: `[tool result${m.name ? ` for ${m.name}` : ""}]\n${m.content}` };
    }
    return { role: m.role, content: m.content };
  }
}
