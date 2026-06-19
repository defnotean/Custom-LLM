import { describe, expect, it } from "vitest";
import { LLMMemoryExtractor } from "../src/memory/MemoryExtractor";
import { MockLLMProvider, testLogger } from "./helpers";

const ctx = { userId: "u1", guildId: "g1", channelId: "c1" };

describe("LLMMemoryExtractor", () => {
  it("asks for JSON and normalizes fenced memory actions", async () => {
    const llm = new MockLLMProvider([
      '```json\n{"actions":[{"action":"add","content":"I prefer concise updates.","scope":"user","confidence":0.9,"importance":4}]}\n```',
    ]);
    const extractor = new LLMMemoryExtractor(llm, testLogger);

    const decisions = await extractor.extract({
      ctx,
      userMessage: "please keep updates concise",
      assistantResponse: "got it",
    });

    expect(decisions).toEqual([
      {
        action: "ADD",
        content: "I prefer concise updates.",
        scope: "USER",
        confidence: 0.9,
        importance: 4,
      },
    ]);
    expect(llm.requests[0]?.responseFormat).toBe("json");
    expect(llm.requests[0]?.metadata).toMatchObject({ memoryExtraction: true });
    expect(llm.requests[0]?.messages[0]?.content).toContain("ADD|UPDATE|DELETE|NOOP");
  });

  it("filters actions below the configured confidence floor", async () => {
    const llm = new MockLLMProvider([
      JSON.stringify({
        actions: [
          { action: "ADD", content: "I prefer tea.", confidence: 0.5 },
          { action: "ADD", content: "I prefer coffee.", confidence: 0.8 },
        ],
      }),
    ]);
    const extractor = new LLMMemoryExtractor(llm, testLogger, { minConfidence: 0.75 });

    const decisions = await extractor.extract({
      ctx,
      userMessage: "drink prefs",
      assistantResponse: "noted",
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.content).toBe("I prefer coffee.");
  });

  it("accepts a single action object as a shorthand response", async () => {
    const llm = new MockLLMProvider([
      JSON.stringify({ action: "NOOP", reason: "one-off joke", confidence: 1 }),
    ]);
    const extractor = new LLMMemoryExtractor(llm, testLogger);

    const decisions = await extractor.extract({
      ctx,
      userMessage: "lol nice",
      assistantResponse: "same",
    });

    expect(decisions).toEqual([{ action: "NOOP", confidence: 1, reason: "one-off joke" }]);
  });

  it("rejects malformed extractor output", async () => {
    const llm = new MockLLMProvider(["not json"]);
    const extractor = new LLMMemoryExtractor(llm, testLogger);

    await expect(
      extractor.extract({
        ctx,
        userMessage: "remember this",
        assistantResponse: "ok",
      }),
    ).rejects.toThrow(/parseable JSON/);
  });
});
