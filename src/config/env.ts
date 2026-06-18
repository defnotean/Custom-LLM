import "dotenv/config";
import { z } from "zod";

/**
 * Zod-validated environment configuration. Every value has a safe default so
 * scripts and tests can run without a full .env; the Discord login and DB
 * connection validate their own requirements at startup.
 */

const booleanString = z
  .string()
  .transform((v) => ["1", "true", "yes", "on"].includes(v.toLowerCase()))
  .or(z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Discord
  DISCORD_TOKEN: z.string().default(""),
  DISCORD_CLIENT_ID: z.string().default(""),
  DISCORD_GUILD_ID: z.string().default(""),
  DISCORD_PRESENCE_STATUS: z.enum(["online", "idle", "dnd", "invisible"]).default("online"),
  DISCORD_PRESENCE_ACTIVITY_TYPE: z
    .enum(["Playing", "Listening", "Watching", "Competing", "Custom"])
    .default("Listening"),
  DISCORD_PRESENCE_ACTIVITY_NAME: z.string().default("for tool calls"),

  // Data spine
  DATABASE_URL: z
    .string()
    .default("postgresql://postgres:postgres@localhost:5432/custom_discord_ai"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // LLM
  LLM_PROVIDER: z.enum(["openai-compatible", "ollama"]).default("openai-compatible"),
  LLM_BASE_URL: z.string().default("http://localhost:11434/v1"),
  LLM_API_KEY: z.string().default("local"),
  LLM_MODEL: z.string().default("qwen2.5:7b-instruct"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("qwen2.5:7b-instruct"),
  SUBQ_ENABLED: booleanString.default("false"),
  SUBQ_BASE_URL: z.string().default(""),
  SUBQ_API_KEY: z.string().default(""),
  SUBQ_MODEL: z.string().default(""),
  SUBQ_TIMEOUT_MS: z.coerce.number().int().min(1).max(3_600_000).default(600_000),

  // Runtime parameter-module hotload control endpoint
  PARAMETER_HOTLOAD_ENDPOINT: z.string().default(""),
  PARAMETER_HOTLOAD_API_KEY: z.string().default(""),
  PARAMETER_HOTLOAD_TIMEOUT_MS: z.coerce.number().int().min(1).max(600_000).default(30_000),

  // External parameter-module trainer dispatch endpoint
  PARAMETER_TRAINER_ENDPOINT: z.string().default(""),
  PARAMETER_TRAINER_API_KEY: z.string().default(""),
  PARAMETER_TRAINER_TIMEOUT_MS: z.coerce.number().int().min(1).max(600_000).default(30_000),

  // Embeddings
  EMBEDDING_PROVIDER: z.enum(["local", "openai-compatible", "hashing"]).default("local"),
  EMBEDDING_BASE_URL: z.string().default("http://localhost:11434/v1"),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),

  // Vector store
  VECTOR_STORE: z.enum(["qdrant", "pgvector", "memory"]).default("qdrant"),
  QDRANT_URL: z.string().default("http://localhost:6333"),
  QDRANT_COLLECTION: z.string().default("discord_ai_memory"),

  // Bot behavior
  BOT_PREFIX: z.string().min(1).default("!"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  MEMORY_ENABLED: booleanString.default("true"),
  TOOL_CALLING_ENABLED: booleanString.default("true"),
  TOOL_ROUTER_STRATEGY: z.enum(["keyword", "embedding"]).default("keyword"),
  TRAINING_LOGGING_ENABLED: booleanString.default("true"),
  SAFETY_ENABLED: booleanString.default("true"),

  // API server
  API_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  API_HOST: z.string().default("0.0.0.0"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // Logger isn't available yet at config-parse time.
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/** The full command prefix, e.g. "!ai". */
export const commandPrefix = `${env.BOT_PREFIX}ai`;
