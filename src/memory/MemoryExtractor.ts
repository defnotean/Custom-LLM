import { z } from "zod";
import type { Logger } from "pino";
import { extractAndParseJson } from "../ai/parsing/jsonRepair";
import type { LLMProvider } from "../ai/llm/LLMProvider";
import type { MemoryQueryContext, MemoryScopeName } from "../types/ai";

export type MemoryExtractionAction = "ADD" | "UPDATE" | "DELETE" | "NOOP";
export type MemoryExtractionMode = "heuristic" | "llm" | "hybrid";

export interface MemoryExtractionInput {
  ctx: MemoryQueryContext;
  userMessage: string;
  assistantResponse: string;
}

export interface MemoryExtractionDecision {
  action: MemoryExtractionAction;
  content?: string;
  target?: string;
  scope?: Exclude<MemoryScopeName, "GLOBAL">;
  importance?: number;
  confidence?: number;
  reason?: string;
}

export interface MemoryExtractor {
  extract(input: MemoryExtractionInput): Promise<MemoryExtractionDecision[]>;
}

export interface LLMMemoryExtractorOptions {
  minConfidence?: number;
  maxActions?: number;
}

const memoryExtractionDecisionSchema = z
  .object({
    action: z.preprocess(
      (value) => (typeof value === "string" ? value.toUpperCase() : value),
      z.enum(["ADD", "UPDATE", "DELETE", "NOOP"]),
    ),
    content: z.string().min(1).max(2_000).optional(),
    target: z.string().min(1).max(500).optional(),
    scope: z
      .preprocess((value) => (typeof value === "string" ? value.toUpperCase() : value), z.enum(["USER", "GUILD", "CHANNEL"]))
      .optional(),
    importance: z.coerce.number().int().min(1).max(5).optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .passthrough();

const memoryExtractionResponseSchema = z
  .object({
    actions: z.array(memoryExtractionDecisionSchema).max(5),
  })
  .strict();

export class LLMMemoryExtractor implements MemoryExtractor {
  private readonly minConfidence: number;
  private readonly maxActions: number;

  constructor(
    private readonly llm: LLMProvider,
    private readonly logger: Logger,
    options: LLMMemoryExtractorOptions = {},
  ) {
    this.minConfidence = options.minConfidence ?? 0.65;
    this.maxActions = options.maxActions ?? 3;
  }

  async extract(input: MemoryExtractionInput): Promise<MemoryExtractionDecision[]> {
    const response = await this.llm.generateChatCompletion({
      responseFormat: "json",
      temperature: 0,
      maxTokens: 700,
      metadata: { memoryExtraction: true },
      messages: [
        {
          role: "system",
          content: [
            "Extract durable memory updates from the just-finished conversation turn.",
            "Return JSON only: {\"actions\":[{\"action\":\"ADD|UPDATE|DELETE|NOOP\",\"content\":\"...\",\"target\":\"...\",\"scope\":\"USER|GUILD|CHANNEL\",\"importance\":1-5,\"confidence\":0-1,\"reason\":\"...\"}]}",
            "Prefer NOOP unless the user taught a stable preference, identity fact, project fact, server fact, correction, or explicit forget/update request.",
            "Never extract secrets, tokens, passwords, private keys, one-off jokes, transient emotions, or sensitive personal data unless the user explicitly asked Irene to remember it.",
            "For ADD/UPDATE content, write a concise memory sentence from the user's perspective, such as 'I prefer concise answers.'",
            "Use USER for personal preferences, GUILD for server-wide facts, and CHANNEL for channel-specific facts. Do not use GLOBAL.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Context: userId=${input.ctx.userId}; guildId=${input.ctx.guildId ?? "none"}; channelId=${input.ctx.channelId}`,
            `User message: ${input.userMessage}`,
            `Assistant reply: ${input.assistantResponse}`,
          ].join("\n"),
        },
      ],
    });

    const parsed = extractAndParseJson(response.content);
    if (!parsed) {
      throw new Error("memory extractor returned no parseable JSON");
    }

    const normalized = normalizeExtractionPayload(parsed.value);
    const result = memoryExtractionResponseSchema.safeParse(normalized);
    if (!result.success) {
      this.logger.debug({ issues: result.error.issues, extracted: parsed.extracted }, "memory extractor schema rejected output");
      throw new Error("memory extractor returned invalid action schema");
    }

    return result.data.actions
      .slice(0, this.maxActions)
      .filter((decision) => (decision.confidence ?? 1) >= this.minConfidence)
      .map((decision) => ({
        action: decision.action,
        ...(decision.content ? { content: decision.content.trim() } : {}),
        ...(decision.target ? { target: decision.target.trim() } : {}),
        ...(decision.scope ? { scope: decision.scope } : {}),
        ...(decision.importance ? { importance: decision.importance } : {}),
        ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        ...(decision.reason ? { reason: decision.reason.trim() } : {}),
      }));
  }
}

function normalizeExtractionPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if ("actions" in value) return value;
  if ("action" in value) return { actions: [value] };
  return value;
}
