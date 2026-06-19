import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../src/ai/llm/OpenAICompatibleProvider";
import { OllamaProvider } from "../src/ai/llm/OllamaProvider";
import { LLMRouter } from "../src/ai/llm/LLMRouter";
import { MockLLMProvider, testLogger } from "./helpers";
import type { LLMChatRequest, LLMChatResponse } from "../src/types/ai";
import type { LLMProvider } from "../src/ai/llm/LLMProvider";

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("OpenAICompatibleProvider", () => {
  it("calls /chat/completions and parses the response", async () => {
    let captured: { url?: string; body?: Record<string, unknown> } = {};
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://fake:1234/v1/",
      model: "test-model",
      fetchImpl: fakeFetch((url, init) => {
        captured = { url, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
        return {
          status: 200,
          body: {
            model: "test-model",
            choices: [{ message: { role: "assistant", content: "hello!" }, finish_reason: "stop" }],
          },
        };
      }),
    });

    const res = await provider.generateChatCompletion({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      maxTokens: 50,
    });

    expect(captured.url).toBe("http://fake:1234/v1/chat/completions");
    expect(captured.body).toMatchObject({ model: "test-model", temperature: 0.2, max_tokens: 50 });
    expect(res.content).toBe("hello!");
    expect(res.finishReason).toBe("stop");
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps tool-role messages to labeled user messages for compatibility", async () => {
    let messages: Array<{ role: string; content: string }> = [];
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://fake/v1",
      model: "m",
      fetchImpl: fakeFetch((_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        messages = body.messages;
        return {
          status: 200,
          body: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
        };
      }),
    });
    await provider.generateChatCompletion({
      messages: [{ role: "tool", name: "ping", content: '{"ok":true}' }],
    });
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("[tool result for ping]");
  });

  it("throws a typed error on HTTP failure", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://fake/v1",
      model: "m",
      fetchImpl: fakeFetch(() => ({ status: 500, body: { error: "boom" } })),
    });
    await expect(
      provider.generateChatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/500/);
  });
});

describe("OllamaProvider", () => {
  it("calls /api/chat with native format", async () => {
    let captured: { url?: string; body?: Record<string, unknown> } = {};
    const provider = new OllamaProvider({
      baseUrl: "http://fake:11434",
      model: "qwen",
      fetchImpl: fakeFetch((url, init) => {
        captured = { url, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
        return {
          status: 200,
          body: { model: "qwen", message: { role: "assistant", content: "pong" }, done_reason: "stop" },
        };
      }),
    });
    const res = await provider.generateChatCompletion({
      messages: [{ role: "user", content: "ping" }],
      responseFormat: "json",
    });
    expect(captured.url).toBe("http://fake:11434/api/chat");
    expect(captured.body).toMatchObject({ format: "json", stream: false });
    expect(res.content).toBe("pong");
  });
});

describe("LLMRouter", () => {
  it("falls back to the next provider on failure", async () => {
    const failing = new OpenAICompatibleProvider({
      baseUrl: "http://fake/v1",
      model: "bad",
      fetchImpl: fakeFetch(() => ({ status: 503, body: {} })),
    });
    const working = new MockLLMProvider(['{"type":"message","content":"fallback works"}']);
    const router = new LLMRouter([failing, working], testLogger);

    const res = await router.generateChatCompletion({ messages: [{ role: "user", content: "hi" }] });
    expect(res.content).toContain("fallback works");
  });

  it("throws when all providers fail", async () => {
    const failing = new OpenAICompatibleProvider({
      baseUrl: "http://fake/v1",
      model: "bad",
      fetchImpl: fakeFetch(() => ({ status: 503, body: {} })),
    });
    const router = new LLMRouter([failing], testLogger);
    await expect(
      router.generateChatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/All LLM providers failed/);
  });

  it("prefers the SubQ provider for long-context requests", async () => {
    const local = new NamedMockProvider("openai-compatible", "local-model", "local response");
    const subq = new NamedMockProvider("subq", "subq-model", "subq response");
    const router = new LLMRouter([local, subq], testLogger);

    const res = await router.generateChatCompletion({
      messages: [{ role: "user", content: "reason over the whole repo" }],
      metadata: { longContext: true },
    });

    expect(res.content).toBe("subq response");
    expect(local.requests).toHaveLength(0);
    expect(subq.requests).toHaveLength(1);
  });

  it("requires a configured SubQ provider for long-context requests by default", async () => {
    const local = new NamedMockProvider("openai-compatible", "local-model", "local response");
    const router = new LLMRouter([local], testLogger);

    await expect(
      router.generateChatCompletion({
        messages: [{ role: "user", content: "reason over the whole repo" }],
        metadata: { longContext: true },
      }),
    ).rejects.toThrow(/requires a configured "subq" provider/);
    expect(local.requests).toHaveLength(0);
  });

  it("does not silently fall back to dense providers when strict SubQ fails", async () => {
    const local = new NamedMockProvider("openai-compatible", "local-model", "local response");
    const subq = new FailingNamedProvider("subq", "subq-model");
    const router = new LLMRouter([local, subq], testLogger);

    await expect(
      router.generateChatCompletion({
        messages: [{ role: "user", content: "reason over the whole repo" }],
        metadata: { longContext: true },
      }),
    ).rejects.toThrow(/All LLM providers failed/);
    expect(subq.requests).toHaveLength(1);
    expect(local.requests).toHaveLength(0);
  });

  it("allows dense long-context fallback only when explicitly configured", async () => {
    const local = new NamedMockProvider("openai-compatible", "local-model", "local response");
    const subq = new FailingNamedProvider("subq", "subq-model");
    const router = new LLMRouter([local, subq], testLogger, {
      allowDenseLongContextFallback: true,
    });

    const res = await router.generateChatCompletion({
      messages: [{ role: "user", content: "reason over the whole repo" }],
      metadata: { longContext: true },
    });

    expect(res.content).toBe("local response");
    expect(subq.requests).toHaveLength(1);
    expect(local.requests).toHaveLength(1);
  });
});

class NamedMockProvider implements LLMProvider {
  readonly info;
  readonly requests: LLMChatRequest[] = [];
  private readonly response: string;

  constructor(name: string, model: string, response: string) {
    this.info = { name, model, baseUrl: `${name}://` };
    this.response = response;
  }

  async generateChatCompletion(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(request);
    return { content: this.response, raw: { mock: true }, latencyMs: 1, model: this.info.model, finishReason: "stop" };
  }
}

class FailingNamedProvider implements LLMProvider {
  readonly info;
  readonly requests: LLMChatRequest[] = [];

  constructor(name: string, model: string) {
    this.info = { name, model, baseUrl: `${name}://` };
  }

  async generateChatCompletion(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(request);
    throw new Error("provider unavailable");
  }
}
