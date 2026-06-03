import type { Logger } from "pino";
import type { ChatMessage, LLMChatResponse } from "../../types/ai";
import type { LLMProvider } from "../llm/LLMProvider";
import { parseAssistantResponse, type ParsedAssistantResponse } from "../parsing/parseAssistantResponse";

export interface ConversationTurnInput {
  systemPrompt: string;
  /** Recent channel transcript (plain text), if available. */
  transcript?: string | null;
  username: string;
  userMessage: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ConversationTurnResult {
  response: LLMChatResponse;
  parsed: ParsedAssistantResponse;
}

/**
 * Runs a single conversational LLM turn: builds the message array, calls the
 * provider (JSON-constrained where supported), and parses the structured
 * action. Used for both the initial turn and the post-tool follow-up turn.
 */
export class ConversationAgent {
  constructor(
    private readonly llm: LLMProvider,
    private readonly logger: Logger,
  ) {}

  buildMessages(input: ConversationTurnInput): ChatMessage[] {
    const userParts: string[] = [];
    if (input.transcript && input.transcript.trim().length > 0) {
      userParts.push(`Recent conversation in this channel:\n${input.transcript.trim()}`);
    }
    userParts.push(`Current message from ${input.username}:\n${input.userMessage}`);

    return [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: userParts.join("\n\n") },
    ];
  }

  async run(input: ConversationTurnInput): Promise<ConversationTurnResult> {
    const response = await this.llm.generateChatCompletion({
      messages: this.buildMessages(input),
      temperature: input.temperature ?? 0.7,
      maxTokens: input.maxTokens ?? 700,
      responseFormat: "json",
    });
    const parsed = parseAssistantResponse(response.content);
    if (!parsed.parseOk) {
      this.logger.debug({ parseError: parsed.parseError }, "assistant output failed protocol parse");
    }
    return { response, parsed };
  }

  /** Follow-up turn after a tool ran: turn the tool result into a user-facing reply. */
  async runToolFollowUp(input: {
    systemPrompt: string;
    username: string;
    userMessage: string;
    toolName: string;
    toolCallJson: string;
    toolResultJson: string;
  }): Promise<ConversationTurnResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: `Message from ${input.username}:\n${input.userMessage}` },
      { role: "assistant", content: input.toolCallJson },
      { role: "tool", name: input.toolName, content: input.toolResultJson },
      {
        role: "user",
        content:
          `The tool "${input.toolName}" has finished — its real result is above. ` +
          `Write the final reply to the user based ONLY on that result (do not invent details). ` +
          `Respond as JSON: {"type": "message", "content": "..."}`,
      },
    ];
    const response = await this.llm.generateChatCompletion({
      messages,
      temperature: 0.5,
      maxTokens: 500,
      responseFormat: "json",
    });
    return { response, parsed: parseAssistantResponse(response.content) };
  }
}
