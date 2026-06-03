import pino from "pino";
import type { LLMChatRequest, LLMChatResponse } from "../src/types/ai";
import type { LLMProvider } from "../src/ai/llm/LLMProvider";
import type { ToolExecutionContext } from "../src/tools/ToolDefinition";

export const testLogger = pino({ level: "silent" });

/** Scripted LLM provider: returns queued responses in order. */
export class MockLLMProvider implements LLMProvider {
  readonly info = { name: "mock", model: "mock-model", baseUrl: "mock://" };
  readonly requests: LLMChatRequest[] = [];
  private readonly queue: string[];

  constructor(responses: string[]) {
    this.queue = [...responses];
  }

  async generateChatCompletion(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(request);
    const content = this.queue.shift();
    if (content === undefined) throw new Error("MockLLMProvider: queue exhausted");
    return { content, raw: { mock: true }, latencyMs: 1, model: "mock-model", finishReason: "stop" };
  }
}

export function testToolContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    memberPermissions: [],
    logger: testLogger,
    db: null,
    memory: null,
    ...overrides,
  };
}
