import type { RegisteredTool } from "../../tools/ToolDefinition";
import type { ToolRegistry } from "../../tools/ToolRegistry";

/**
 * Renders the tool section of the prompt for a routed candidate subset.
 * Deliberately takes candidates, never the whole registry — see ToolRouter.
 */
export function buildToolPromptSection(
  registry: ToolRegistry,
  candidates: RegisteredTool[],
): string | null {
  if (candidates.length === 0) return null;

  const rendered = registry.getToolDescriptionsForPrompt(candidates);

  return `Available tools for this request (a relevant subset, not everything you can theoretically do):

${rendered}

Tool usage rules:
- Only request tools from this list, with arguments matching the schema exactly.
- One tool call per response. You will receive the result and can then reply.
- If required arguments are missing from the user's request, use "clarification" instead of guessing.
- If a tool is marked "Requires confirmation: true", use "confirmation_request" first.
- If none of these tools fit, just answer with "message".`;
}
