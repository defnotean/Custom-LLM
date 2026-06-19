import type { Logger } from "pino";
import type { LLMChatRequest, LLMChatResponse, LLMProviderInfo } from "../../types/ai";
import { LLMProviderError, toErrorMessage } from "../../utils/errors";
import type { Env } from "../../config/env";
import { isSubqLongContextMetadata, SUBQ_PROVIDER_ID } from "../architecture/SubquadraticSparseAttentionContract";
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
  private readonly allowDenseLongContextFallback: boolean;

  constructor(providers: LLMProvider[], logger?: Logger, options: LLMRouterOptions = {}) {
    if (providers.length === 0) {
      throw new LLMProviderError("LLMRouter requires at least one provider");
    }
    this.providers = providers;
    this.logger = logger;
    this.allowDenseLongContextFallback = options.allowDenseLongContextFallback ?? false;
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
    for (const provider of this.providersForRequest(request)) {
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

  private providersForRequest(request: LLMChatRequest): LLMProvider[] {
    const metadataPreferredProvider =
      typeof request.metadata?.preferredProvider === "string" ? request.metadata.preferredProvider : undefined;
    const preferredProvider = isSubqLongContextMetadata(request.metadata) ? SUBQ_PROVIDER_ID : metadataPreferredProvider;
    if (!preferredProvider) return this.providers;
    const preferred = this.providers.find((provider) => provider.info.name === preferredProvider);
    const isSubqRequest = preferredProvider === SUBQ_PROVIDER_ID;
    if (!preferred) {
      if (isSubqRequest && !this.allowDenseLongContextFallback) {
        throw new LLMProviderError(
          `SubQ/SSA long-context request requires a configured "${SUBQ_PROVIDER_ID}" provider. Set SUBQ_ENABLED=true with SUBQ_BASE_URL and SUBQ_MODEL, or explicitly set SUBQ_ALLOW_DENSE_FALLBACK=true for development fallback.`,
        );
      }
      this.logger?.warn(
        { preferredProvider },
        "Preferred LLM provider is unavailable; falling back to configured providers",
      );
      return this.providers;
    }
    if (isSubqRequest && !this.allowDenseLongContextFallback) return [preferred];
    return [preferred, ...this.providers.filter((provider) => provider !== preferred)];
  }
}

export interface LLMRouterOptions {
  allowDenseLongContextFallback?: boolean;
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

  if (env.SUBQ_ENABLED) {
    if (!env.SUBQ_BASE_URL || !env.SUBQ_MODEL) {
      logger?.warn("SUBQ_ENABLED=true but SUBQ_BASE_URL or SUBQ_MODEL is missing; SubQ provider disabled");
    } else {
      providers.push(
        new OpenAICompatibleProvider({
          name: SUBQ_PROVIDER_ID,
          baseUrl: env.SUBQ_BASE_URL,
          apiKey: env.SUBQ_API_KEY || env.LLM_API_KEY,
          model: env.SUBQ_MODEL,
          timeoutMs: env.SUBQ_TIMEOUT_MS,
          logger,
        }),
      );
    }
  }

  return new LLMRouter(providers, logger, {
    allowDenseLongContextFallback: env.SUBQ_ALLOW_DENSE_FALLBACK,
  });
}
