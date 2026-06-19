/** JSON-safe value types used for tool results, logs, and exports. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Convert an arbitrary value into a JSON-safe value (drops functions, cycles throw). */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

export interface HealthPayload {
  status: "ok" | "degraded";
  uptimeSec: number;
  discord: { configured: boolean; connected: boolean };
  llm: { provider: string; model: string; baseUrl: string };
  database: { available: boolean };
  runtimeState: { store: "memory" | "redis"; redisConnected: boolean };
  memory: { enabled: boolean; store: string };
}

export interface LearningStatsPayload {
  learnedItems: number;
  candidateItems: number;
  approvedItems: number;
  queuedItems: number;
  trainedItems: number;
  parameterModules: number;
  activeParameterModules: number;
  stagedParameterModules: number;
  totalSystemParams: number;
  stagedParams: number;
  activeParamsPerRequest: number;
}

export interface StatsPayload {
  uptimeSec: number;
  registry: { tools: number; categories: string[] };
  llm: { provider: string; model: string };
  learning?: ({ enabled: false } | ({ enabled: true } & LearningStatsPayload));
  db: {
    available: boolean;
    conversations?: number;
    toolLogs?: number;
    trainingExamples?: number;
    memories?: number;
  };
}
