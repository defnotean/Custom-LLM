import type { Logger } from "pino";
import type { InteractionTrace, TrainingSinkResult } from "../types/ai";
import type { JsonObject, JsonValue } from "../types/common";
import { toJsonValue } from "../types/common";
import { toErrorMessage } from "../utils/errors";
import type {
  LearnedItem,
  LearningAccessPath,
  LearningKind,
  LearningProvenance,
  LearningRetentionPolicy,
  LearningReviewStatus,
} from "./LiveLearningRegistry";

export interface LearnedItemWriter {
  createLearnedItem(input: {
    kind: LearningKind;
    content: string;
    source: string;
    confidence?: number;
    reviewStatus?: LearningReviewStatus;
    accessPaths?: LearningAccessPath[];
    provenance?: LearningProvenance;
    retention?: Partial<LearningRetentionPolicy>;
    metadata?: JsonObject;
  }): Promise<LearnedItem>;
}

export class InteractionLearningCapture {
  constructor(
    private readonly writer: LearnedItemWriter,
    private readonly logger: Logger,
  ) {}

  async captureInteraction(trace: InteractionTrace, training?: TrainingSinkResult): Promise<void> {
    const candidates = this.buildCandidates(trace, training);
    for (const candidate of candidates) {
      try {
        await this.writer.createLearnedItem(candidate);
      } catch (err) {
        this.logger.warn(
          { err: toErrorMessage(err), traceId: trace.id, kind: candidate.kind, source: candidate.source },
          "failed to capture interaction learning item",
        );
      }
    }
  }

  private buildCandidates(
    trace: InteractionTrace,
    training?: TrainingSinkResult,
  ): Array<Parameters<LearnedItemWriter["createLearnedItem"]>[0]> {
    const candidates: Array<Parameters<LearnedItemWriter["createLearnedItem"]>[0]> = [];
    if (trace.toolSuccess === true && trace.toolCall) {
      candidates.push(this.buildSkillCandidate(trace, training));
    }

    if (shouldCaptureFailure(trace)) {
      candidates.push(this.buildFailureCandidate(trace, training));
    }

    return candidates;
  }

  private buildSkillCandidate(
    trace: InteractionTrace,
    training?: TrainingSinkResult,
  ): Parameters<LearnedItemWriter["createLearnedItem"]>[0] {
    const toolName = trace.toolCall?.name ?? "unknown_tool";
    const args = scrubAndTruncate(safeJson(trace.toolCall?.arguments ?? {}), 800);
    const content = [
      "Skill candidate from a successful tool interaction.",
      `Intent: ${scrubAndTruncate(trace.userMessage, 400)}`,
      `Tool: ${toolName}`,
      `Arguments: ${args}`,
      `Result: ${trace.toolSuccess ? "success" : "unknown"}`,
      `Reply style: ${scrubAndTruncate(trace.finalResponse, 400)}`,
    ].join("\n");

    return {
      kind: "skill",
      content,
      source: "tool_success",
      confidence: 0.76,
      reviewStatus: "candidate",
      accessPaths: ["skill_registry"],
      provenance: provenanceFromTrace(trace, training),
      retention: { canRetrieve: true, canTrain: true },
      metadata: {
        toolName,
        toolArguments: scrubJson(trace.toolCall?.arguments ?? {}) as JsonObject,
        candidateTools: toJsonValue(trace.candidateToolNames),
        routerConfidence: trace.routerConfidence ?? null,
        trainingExampleId: training?.trainingExampleId ?? null,
        conversationId: training?.conversationId ?? null,
      },
    };
  }

  private buildFailureCandidate(
    trace: InteractionTrace,
    training?: TrainingSinkResult,
  ): Parameters<LearnedItemWriter["createLearnedItem"]>[0] {
    const failureType = classifyFailure(trace);
    const content = [
      "Eval failure candidate from an interaction that should become a regression case.",
      `Failure type: ${failureType}`,
      `Intent: ${scrubAndTruncate(trace.userMessage, 400)}`,
      `Parsed action: ${scrubAndTruncate(safeJson(trace.parsedAction ?? null), 600)}`,
      `Tool call: ${scrubAndTruncate(safeJson(trace.toolCall ?? null), 600)}`,
      `Errors: ${scrubAndTruncate(trace.errors.join("; ") || "none", 500)}`,
    ].join("\n");

    return {
      kind: "eval_failure",
      content,
      source: failureType,
      confidence: 0.68,
      reviewStatus: "candidate",
      accessPaths: ["training_queue"],
      provenance: provenanceFromTrace(trace, training),
      retention: { canRetrieve: true, canTrain: true },
      metadata: {
        failureType,
        parseOk: trace.parseOk ?? null,
        toolDenied: trace.toolDenied ?? null,
        toolSuccess: trace.toolSuccess ?? null,
        errors: scrubJson(trace.errors),
        candidateTools: toJsonValue(trace.candidateToolNames),
        trainingExampleId: training?.trainingExampleId ?? null,
        conversationId: training?.conversationId ?? null,
      },
    };
  }
}

function shouldCaptureFailure(trace: InteractionTrace): boolean {
  return trace.parseOk === false || Boolean(trace.toolDenied) || trace.toolSuccess === false || trace.errors.length > 0;
}

function classifyFailure(trace: InteractionTrace): string {
  if (trace.errors.some((error) => error.startsWith("safety_block:"))) return "safety_block";
  if (trace.parseOk === false) return "parse_failure";
  if (trace.toolDenied) return `tool_denied:${trace.toolDenied}`;
  if (trace.toolSuccess === false) return "tool_execution_failure";
  if (trace.errors.some((error) => error.startsWith("follow_up_llm:"))) return "follow_up_failure";
  if (trace.errors.length > 0) return "agent_error";
  return "unknown_failure";
}

function provenanceFromTrace(trace: InteractionTrace, training?: TrainingSinkResult): LearningProvenance {
  return {
    userId: trace.userId,
    guildId: trace.guildId,
    channelId: trace.channelId,
    conversationId: training?.conversationId,
    trainingExampleId: training?.trainingExampleId,
    interactionTraceId: trace.id,
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

function scrubAndTruncate(value: string, maxLength: number): string {
  const scrubbed = value
    .replace(/\b(password|passwd|passphrase|api[_ -]?key|secret|token)\b\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]")
    .replace(/\b(bearer|authorization)\s+[a-z0-9._-]{10,}/gi, "$1 [redacted]")
    .replace(/\bsk-[a-z0-9_-]{8,}/gi, "[redacted-key]")
    .replace(/\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/g, "[redacted-discord-token]");
  return scrubbed.length <= maxLength ? scrubbed : `${scrubbed.slice(0, maxLength - 3)}...`;
}

function scrubJson(value: unknown): JsonValue {
  const json = toJsonValue(value);
  if (typeof json === "string") return scrubAndTruncate(json, 2000);
  if (Array.isArray(json)) return json.map((item) => scrubJson(item));
  if (json && typeof json === "object") {
    return Object.fromEntries(Object.entries(json).map(([key, item]) => [key, scrubJson(item)]));
  }
  return json;
}
