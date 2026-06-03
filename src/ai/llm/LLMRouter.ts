import type { Logger } from "pino";
import type { LLMChatRequest, LLMChatResponse, LLMProviderInfo } from "../../types/ai";
import { LLMProviderError, toErrorMessage } from "../../utils/errors";
import type { Env } from "../../config/env";
import type { LLMProvider } from "./LLMProvider";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { OllamaProvider } from "./OllamaProvider";

/**
 * Routes requests across an ordered list of providers (primary first,
 * fallbacks after). Itself implements LLMProvider so the agent layer doesn't
 * care whether it talks to one backend or several.
 *
 * Future extension point: per-request routing (cheap model for casual chat,
 * stronger model for tool/planning turns) — see docs/ARCHITECTURE.md.
 */
export class LLMRouter implements LLMProvider {
  private readonly providers: LLMProvider[];
  private readonly logger: Logger | undefined;

  constructor(providers: LLMProvider[], logger?: Logger) {
    if (providers.length === 0) {
      throw new LLMProviderError("LLMRouter requires at least one provider");
    }
    this.providers = providers;
    this.logger = logger;
  }

  get info(): LLMProviderInfo {
    const primary = this.providers[0];
    // Constructor guarantees at least one provider.
    return primary ? primary.info : { name: "none", model: "none", baseUrl: "" };
  }

  listProviders(): LLMProviderInfo[] {
    return this.providers.map((p) => p.info);
  }

  async generateChatCompletion(request: LLMChatRequest): Promise<LLMChatResponse> {
    const errors: string[] = [];
    for (const provider of this.providers) {
      try {
        return await provider.generateChatCompletion(request);
      } catch (err) {
        const msg = `${provider.info.name}(${provider.info.model}): ${toErrorMessage(err)}`;
        errors.push(msg);
        this.logger?.warn({ provider: provider.info.name, err: toErrorMessage(err) },
          "LLM provider failed, trying next");
      }
    }
    throw new LLMProviderError(`All LLM providers failed:\n${errors.join("\n")}`);
  }
}

/** Build the router from environment config. */
export function buildLLMRouterFromEnv(env: Env, logger?: Logger): LLMRouter {
  const providers: LLMProvider[] = [];

  if (env.LLM_PROVIDER === "ollama") {
    providers.push(
      new OllamaProvider({ baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_MODEL, logger }),
    );
  } else {
    providers.push(
      new OpenAICompatibleProvider({
        baseUrl: env.LLM_BASE_URL,
        apiKey: env.LLM_API_KEY,
        model: env.LLM_MODEL,
        logger,
      }),
    );
  }

  return new LLMRouter(providers, logger);
}
