import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOT_NAME,
  DEFAULT_BOT_PRONOUNS,
  SYSTEM_PROMPT_VERSION,
  buildSystemPrompt,
} from "../src/ai/prompts/systemPrompt";

describe("systemPrompt", () => {
  it("hardcodes the she/her persona and strict JSON protocol", () => {
    const prompt = buildSystemPrompt({ botName: "Irene", isDM: true });
    expect(SYSTEM_PROMPT_VERSION).toBe("v1.2.0");
    expect(DEFAULT_BOT_NAME).toBe("Irene");
    expect(DEFAULT_BOT_PRONOUNS).toBe("she/her");
    expect(prompt).toContain("You present as she/her");
    expect(prompt).toContain("Do not describe yourself as he/him");
    expect(prompt).toContain("You have a consistent affective persona");
    expect(prompt).toContain("Do not add generic filter/refusal language to allowed requests");
    expect(prompt).toContain("Output format - STRICT");
    expect(prompt).toContain("Respond with ONLY a single valid JSON object");
  });
});
