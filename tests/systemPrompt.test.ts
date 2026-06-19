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
    expect(SYSTEM_PROMPT_VERSION).toBe("v1.4.1");
    expect(DEFAULT_BOT_NAME).toBe("Irene");
    expect(DEFAULT_BOT_PRONOUNS).toBe("she/her");
    expect(prompt).toContain("You present as she/her");
    expect(prompt).toContain("Do not describe yourself as he/him");
    expect(prompt).toContain("You have a consistent affective persona");
    expect(prompt).toContain("Do not add generic filter/refusal language to allowed requests");
    expect(prompt).toContain("Output format - STRICT");
    expect(prompt).toContain("Respond with ONLY a single valid JSON object");
  });

  it("includes reviewed learned skills when provided", () => {
    const prompt = buildSystemPrompt({
      botName: "Irene",
      isDM: true,
      skillSection: "Relevant learned skills:\n- [skill:1 tool=ping] Use ping for health checks.",
    });

    expect(prompt).toContain("Relevant learned skills");
    expect(prompt).toContain("Use ping for health checks");
  });

  it("includes active parameter module hints when provided", () => {
    const prompt = buildSystemPrompt({
      botName: "Irene",
      isDM: true,
      parameterModuleSection:
        "Active learned parameter modules:\n- [module:1 kind=expert params=775358] tool expert",
    });

    expect(prompt).toContain("Active learned parameter modules");
    expect(prompt).toContain("tool expert");
  });
});
