import type { ChatMessage } from "../../types/ai";

/**
 * ChatML-style JSONL record: {"messages":[{role, content}...]}. The standard
 * input for most SFT pipelines (Axolotl/Unsloth/TRL chat templates).
 */

export interface ChatMLRecord {
  messages: Array<{ role: string; content: string; name?: string }>;
}

export interface ChatMLSourceExample {
  systemPrompt: string;
  userMessage: string;
  assistantResponse: string;
}

export function toChatMLRecord(example: ChatMLSourceExample): ChatMLRecord {
  return {
    messages: [
      { role: "system", content: example.systemPrompt },
      { role: "user", content: example.userMessage },
      { role: "assistant", content: example.assistantResponse },
    ],
  };
}

export function chatMessagesToRecord(messages: ChatMessage[]): ChatMLRecord {
  return {
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    })),
  };
}
