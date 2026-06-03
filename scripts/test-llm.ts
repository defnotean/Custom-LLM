import { env } from "../src/config/env";
import { logger } from "../src/config/logger";
import { buildLLMRouterFromEnv } from "../src/ai/llm/LLMRouter";
import { toErrorMessage } from "../src/utils/errors";

/**
 * Smoke-test the configured LLM endpoint:  npm run test-llm
 * Verifies chat completion (and embeddings if EMBEDDING_PROVIDER != hashing).
 */
async function main(): Promise<void> {
  const llm = buildLLMRouterFromEnv(env, logger);
  // eslint-disable-next-line no-console
  console.log(`Testing LLM: ${llm.info.name} @ ${llm.info.baseUrl} (model: ${llm.info.model})`);

  try {
    const res = await llm.generateChatCompletion({
      messages: [
        { role: "system", content: "You reply with exactly one word." },
        { role: "user", content: "Reply with the single word: pong" },
      ],
      temperature: 0,
      maxTokens: 10,
    });
    // eslint-disable-next-line no-console
    console.log(
      `✔ chat completion ok — "${res.content.trim()}" (${res.latencyMs}ms, model ${res.model}, finish ${res.finishReason})`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`✘ chat completion FAILED: ${toErrorMessage(err)}`);
    // eslint-disable-next-line no-console
    console.error("  Is your local server running? See docs/LOCAL_LLM_SETUP.md");
    process.exit(1);
  }

  if (env.EMBEDDING_PROVIDER !== "hashing") {
    const { OpenAICompatibleEmbeddingProvider } = await import("../src/memory/EmbeddingProvider");
    const embeddings = new OpenAICompatibleEmbeddingProvider({
      baseUrl: env.EMBEDDING_BASE_URL,
      model: env.EMBEDDING_MODEL,
    });
    try {
      const [vec] = await embeddings.embed(["embedding smoke test"]);
      // eslint-disable-next-line no-console
      console.log(`✔ embeddings ok — ${vec?.length ?? 0} dimensions (${env.EMBEDDING_MODEL})`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`⚠ embeddings failed (memory will fall back): ${toErrorMessage(err)}`);
    }
  }

  process.exit(0);
}

void main();
