/**
 * Tool-calling JSONL: the full multi-turn trajectory including the
 * assistant's tool_call JSON, the tool's result, and the final reply —
 * exactly what we need to fine-tune tool selection + argument filling.
 */

export interface ToolCallingRecord {
  messages: Array<
    | { role: "system" | "user" | "assistant"; content: string }
    | { role: "tool"; name: string; content: string }
  >;
}

export interface ToolCallingSourceExample {
  systemPrompt: string;
  userMessage: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  toolCallReason?: string;
  toolResultJson: string;
  finalResponse: string;
}

export function toToolCallingRecord(example: ToolCallingSourceExample): ToolCallingRecord {
  const toolCall = {
    type: "tool_call" as const,
    tool: example.toolName,
    arguments: example.toolArguments,
    ...(example.toolCallReason ? { reason: example.toolCallReason } : {}),
  };
  return {
    messages: [
      { role: "system", content: example.systemPrompt },
      { role: "user", content: example.userMessage },
      { role: "assistant", content: JSON.stringify(toolCall) },
      { role: "tool", name: example.toolName, content: example.toolResultJson },
      { role: "assistant", content: example.finalResponse },
    ],
  };
}

/** Preference/DPO placeholder record (chosen vs rejected for the same prompt). */
export interface DpoRecord {
  prompt: string;
  chosen: string;
  rejected: string;
}
