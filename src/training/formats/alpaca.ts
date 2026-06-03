/**
 * Alpaca-format record: {instruction, input, output}. Kept for
 * compatibility with Alpaca-style fine-tuning configs.
 */

export interface AlpacaRecord {
  instruction: string;
  input: string;
  output: string;
}

export interface AlpacaSourceExample {
  systemPrompt: string;
  userMessage: string;
  assistantResponse: string;
}

export function toAlpacaRecord(example: AlpacaSourceExample): AlpacaRecord {
  return {
    instruction: example.systemPrompt,
    input: example.userMessage,
    output: example.assistantResponse,
  };
}
