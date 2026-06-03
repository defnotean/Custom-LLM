import type { AssistantAction } from "../../types/ai";
import { extractAndParseJson } from "./jsonRepair";
import { validateAssistantAction } from "./toolCallParser";

export interface ParsedAssistantResponse {
  action: AssistantAction;
  /** True when the model produced valid protocol JSON. */
  parseOk: boolean;
  /** The JSON snippet that was extracted, if any (kept for training logs). */
  extractedJson?: string;
  /** Why parsing/validation failed, if it did. */
  parseError?: string;
}

/**
 * Parse raw LLM output into an AssistantAction.
 *
 * Guarantees:
 *  - Never throws.
 *  - Never yields an executable tool_call from invalid/unvalidated JSON —
 *    on any failure it degrades to a plain `message` action so the
 *    downstream pipeline cannot run a tool that wasn't properly requested.
 *  - Parse failures are flagged (`parseOk: false`) so the training logger
 *    can capture them as negative examples.
 */
export function parseAssistantResponse(rawOutput: string): ParsedAssistantResponse {
  const raw = (rawOutput ?? "").trim();

  if (raw.length === 0) {
    return {
      action: { type: "message", content: "(the model returned an empty response)" },
      parseOk: false,
      parseError: "empty output",
    };
  }

  const extracted = extractAndParseJson(raw);
  if (!extracted) {
    // No JSON at all — treat the whole output as a plain message. This keeps
    // the bot usable with models that ignore the format, while flagging the
    // turn as a formatting failure for training.
    return {
      action: { type: "message", content: raw },
      parseOk: false,
      parseError: "no JSON object found in output",
    };
  }

  const validated = validateAssistantAction(extracted.value);
  if (!validated.ok) {
    return {
      action: { type: "message", content: fallbackContent(extracted.value, raw) },
      parseOk: false,
      extractedJson: extracted.extracted,
      parseError: `invalid action: ${validated.error}`,
    };
  }

  return { action: validated.action, parseOk: true, extractedJson: extracted.extracted };
}

/** Salvage something readable when JSON parsed but failed protocol validation. */
function fallbackContent(value: unknown, raw: string): string {
  if (value && typeof value === "object" && "content" in value) {
    const content = (value as { content?: unknown }).content;
    if (typeof content === "string" && content.trim().length > 0) return content;
  }
  return raw;
}
