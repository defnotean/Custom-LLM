// Vitest global setup — keep test runs quiet and deterministic.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
process.env.EMBEDDING_PROVIDER = "hashing";
process.env.VECTOR_STORE = "memory";
