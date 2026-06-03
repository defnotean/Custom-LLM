import type { Logger } from "pino";
import type { InteractionTrace, TrainingSink, TrainingSinkResult } from "../types/ai";
import { toJsonValue, type JsonObject } from "../types/common";
import { toErrorMessage } from "../utils/errors";
import type { ConversationRepository } from "../database/repositories/ConversationRepository";
import type { TrainingExampleRepository } from "../database/repositories/TrainingExampleRepository";
import type { UserRepository } from "../database/repositories/UserRepository";
import { EvaluationAgent } from "../ai/orchestration/EvaluationAgent";

/**
 * Captures every interaction as (a) a Conversation row and (b) a
 * TrainingExample row in the format matching what happened:
 *  - plain replies        → CHATML
 *  - tool-call turns      → TOOL_CALLING_JSONL
 *
 * The stored inputJson/outputJson keep the FULL fidelity trace (prompt
 * version + text, retrieved memories, candidate tools, raw + parsed output,
 * tool result, errors, latency) so future dataset builds can re-derive any
 * format and filter by quality. Parse failures are logged too — they're
 * negative examples for format-following.
 *
 * Privacy note: traces contain user message content. Run exports through
 * the review/redaction step described in docs/TRAINING_DATA.md before
 * training, and honor deletion requests.
 */
export class TrainingDataLogger implements TrainingSink {
  private readonly evaluation = new EvaluationAgent();

  constructor(
    private readonly deps: {
      conversations: ConversationRepository | null;
      examples: TrainingExampleRepository | null;
      users: UserRepository | null;
      logger: Logger;
      enabled: boolean;
    },
  ) {}

  async logInteraction(trace: InteractionTrace): Promise<TrainingSinkResult> {
    if (!this.deps.enabled) return {};
    const result: TrainingSinkResult = {};

    // Best-effort profile upsert (ignore failures).
    if (this.deps.users) {
      await this.deps.users
        .ensure(trace.userId, trace.username, null)
        .catch((err: unknown) =>
          this.deps.logger.debug({ err: toErrorMessage(err) }, "user upsert failed"),
        );
    }

    if (this.deps.conversations) {
      try {
        result.conversationId = await this.deps.conversations.create({
          guildId: trace.guildId,
          channelId: trace.channelId,
          userId: trace.userId,
          discordMessageId: trace.discordMessageId,
          userMessage: trace.userMessage,
          assistantResponse: trace.finalResponse,
          metadataJson: toJsonValue({
            systemPromptVersion: trace.systemPromptVersion,
            candidateTools: trace.candidateToolNames,
            toolCall: trace.toolCall ?? null,
            toolSuccess: trace.toolSuccess ?? null,
            parseOk: trace.parseOk ?? null,
            errors: trace.errors,
            llmLatencyMs: trace.llmLatencyMs ?? null,
            totalLatencyMs: trace.totalLatencyMs ?? null,
            model: trace.model ?? null,
          }),
        });
      } catch (err) {
        this.deps.logger.warn({ err: toErrorMessage(err) }, "conversation logging failed");
      }
    }

    if (this.deps.examples) {
      try {
        const isToolTurn = Boolean(trace.toolCall);
        const inputJson: JsonObject = {
          systemPromptVersion: trace.systemPromptVersion,
          systemPrompt: trace.systemPrompt,
          userMessage: trace.userMessage,
          transcript: trace.transcript ?? null,
          memoriesRetrieved: toJsonValue(trace.memoriesRetrieved),
          candidateTools: toJsonValue(trace.candidateToolNames),
          likelyNeedsTool: trace.likelyNeedsTool,
          routerReasoning: trace.routerReasoning ?? null,
          guildId: trace.guildId,
          channelId: trace.channelId,
          userId: trace.userId,
        };
        const outputJson: JsonObject = {
          rawModelOutput: trace.rawModelOutput ?? null,
          parseOk: trace.parseOk ?? null,
          parsedAction: toJsonValue(trace.parsedAction ?? null),
          toolCall: toJsonValue(trace.toolCall ?? null),
          toolResult: toJsonValue(trace.toolResult ?? null),
          toolSuccess: trace.toolSuccess ?? null,
          toolDenied: trace.toolDenied ?? null,
          finalResponse: trace.finalResponse,
          errors: toJsonValue(trace.errors),
          llmLatencyMs: trace.llmLatencyMs ?? null,
          totalLatencyMs: trace.totalLatencyMs ?? null,
          model: trace.model ?? null,
        };

        result.trainingExampleId = await this.deps.examples.create({
          source: isToolTurn ? "TOOL_CALL" : "CONVERSATION",
          format: isToolTurn ? "TOOL_CALLING_JSONL" : "CHATML",
          inputJson,
          outputJson,
          qualityScore: this.evaluation.scoreInteraction(trace),
          metadataJson: { traceId: trace.id, createdAt: trace.createdAt },
        });
      } catch (err) {
        this.deps.logger.warn({ err: toErrorMessage(err) }, "training example logging failed");
      }
    }

    return result;
  }
}
