import type { LLMChatRequest, LLMChatResponse, LLMProviderInfo } from "../../types/ai";

/**
 * Provider abstraction. Implementations: OpenAICompatibleProvider (vLLM,
 * LM Studio, Ollama's /v1, any /v1/chat/completions server) and
 * OllamaProvider (native /api/chat). LLMRouter composes providers with
 * fallback and itself implements this interface.
 */
export interface LLMProvider {
  readonly info: LLMProviderInfo;
  generateChatCompletion(request: LLMChatRequest): Promise<LLMChatResponse>;
}
