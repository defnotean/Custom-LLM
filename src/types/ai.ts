/**
 * Core AI domain types + the "ports" (minimal interfaces) the orchestration
 * layer depends on. Concrete services (MemoryService, SafetyService,
 * TrainingDataLogger) structurally implement these ports, which keeps the
 * agent layer decoupled and easy to test with fakes.
 */

// ── Chat / LLM ────────────────────────────────────────────────────────────────

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Tool name when role === "tool". */
  name?: string;
}

export interface LLMChatRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** "json" asks the backend for JSON-constrained output where supported. */
  responseFormat?: "json" | "text";
  stop?: string[];
  metadata?: Record<string, unknown>;
}

export interface LLMChatResponse {
  content: string;
  raw: unknown;
  latencyMs: number;
  model: string;
  finishReason: string;
}

export interface LLMProviderInfo {
  name: string;
  model: string;
  baseUrl: string;
}

// ── Assistant structured output ──────────────────────────────────────────────

export type AssistantAction =
  | { type: "message"; content: string }
  | { type: "tool_call"; tool: string; arguments: Record<string, unknown>; reason?: string }
  | {
      type: "confirmation_request";
      content: string;
      pending_tool_call: { tool: string; arguments: Record<string, unknown> };
    }
  | { type: "clarification"; content: string };

// ── Memory ───────────────────────────────────────────────────────────────────

export type MemoryScopeName = "USER" | "GUILD" | "CHANNEL" | "GLOBAL";

export interface MemoryHit {
  id: string;
  content: string;
  scope: MemoryScopeName;
  importance: number;
  score: number;
}

export interface SkillHint {
  id: string;
  content: string;
  source: string;
  confidence: number;
  score: number;
  toolName?: string;
}

export interface ParameterModuleHint {
  id: string;
  name: string;
  kind: string;
  parameters: number;
  activeParameters: number;
  score: number;
  route?: string;
  sourceLearningItemIds: string[];
  sourceSummaries: string[];
}

export interface MemoryQueryContext {
  userId: string;
  guildId: string | null;
  channelId: string;
}

/** What the agent layer needs from a memory system. */
export interface MemoryPort {
  getContextForPrompt(
    ctx: MemoryQueryContext,
    query: string,
    topK?: number,
  ): Promise<{ section: string; hits: MemoryHit[] }>;
  maybeExtractMemoryFromConversation(
    ctx: MemoryQueryContext,
    userMessage: string,
    assistantResponse: string,
  ): Promise<{ stored: boolean; id?: string; reason: string }>;
}

// ── Safety ───────────────────────────────────────────────────────────────────

export interface SafetyVerdict {
  allowed: boolean;
  reason?: string;
  /** Text to send the user when blocked. */
  userReply?: string;
}

/** What the agent layer needs from the safety system. */
export interface SafetyPort {
  precheckMessage(input: {
    userId: string;
    guildId: string | null;
    channelId: string;
    content: string;
  }): Promise<SafetyVerdict>;
  /** Whether a tool execution must be confirmed by the user first. */
  toolRequiresConfirmation(input: {
    riskLevel: string;
    requiresConfirmation: boolean;
  }): boolean;
  refusalMessage(reason: string): string;
}

// ── Training capture ─────────────────────────────────────────────────────────

/**
 * One fully-traced interaction. Everything needed to reconstruct a
 * fine-tuning example later: exact prompt, retrieved memories, candidate
 * tools, raw + parsed model output, tool execution, and the final reply.
 */
export interface InteractionTrace {
  id: string;
  createdAt: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  discordMessageId: string;
  userMessage: string;

  systemPromptVersion: string;
  systemPrompt: string;
  transcript?: string;

  memoriesRetrieved: MemoryHit[];
  skillsRetrieved?: SkillHint[];
  parameterModulesActivated?: ParameterModuleHint[];
  candidateToolNames: string[];
  likelyNeedsTool: boolean;
  routerReasoning?: string;
  routerConfidence?: number;
  specialistRouter?: {
    route: string;
    expert: string;
    confidence: number;
    reason: string;
    model: string;
    matchedRule: string;
    latencyMs?: number;
  };
  behaviorGuardrail?: {
    model: string;
    matchedRule: string;
    latencyMs?: number;
  };

  rawModelOutput?: string;
  parseOk?: boolean;
  parsedAction?: AssistantAction;

  toolCall?: { name: string; arguments: Record<string, unknown>; reason?: string };
  toolResult?: unknown;
  toolSuccess?: boolean;
  toolDenied?: string;

  finalResponse: string;
  errors: string[];
  llmLatencyMs?: number;
  totalLatencyMs?: number;
  model?: string;
}

export interface TrainingSinkResult {
  conversationId?: string;
  trainingExampleId?: string;
}

/** What the agent layer needs from the training logger. */
export interface TrainingSink {
  logInteraction(trace: InteractionTrace): Promise<TrainingSinkResult>;
}
