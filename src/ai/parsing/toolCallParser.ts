import { z } from "zod";
import type { AssistantAction } from "../../types/ai";

/**
 * Zod schemas for the strict assistant output protocol. The model must reply
 * with exactly one of these four JSON shapes (see ai/prompts/systemPrompt.ts).
 */

const argumentsSchema = z.record(z.unknown()).default({});

export const messageActionSchema = z.object({
  type: z.literal("message"),
  content: z.string(),
});

export const toolCallActionSchema = z.object({
  type: z.literal("tool_call"),
  tool: z.string().min(1),
  arguments: argumentsSchema,
  reason: z.string().optional(),
});

export const confirmationRequestActionSchema = z.object({
  type: z.literal("confirmation_request"),
  content: z.string(),
  pending_tool_call: z.object({
    tool: z.string().min(1),
    arguments: argumentsSchema,
  }),
});

export const clarificationActionSchema = z.object({
  type: z.literal("clarification"),
  content: z.string(),
});

export const assistantActionSchema = z.discriminatedUnion("type", [
  messageActionSchema,
  toolCallActionSchema,
  confirmationRequestActionSchema,
  clarificationActionSchema,
]);

/** Validate an already-parsed JSON value against the action protocol. */
export function validateAssistantAction(
  value: unknown,
): { ok: true; action: AssistantAction } | { ok: false; error: string } {
  const result = assistantActionSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: issue ? `${issue.path.join(".") || "root"}: ${issue.message}` : "invalid action",
    };
  }
  return { ok: true, action: result.data };
}
