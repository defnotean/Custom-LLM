import { describe, expect, it } from "vitest";
import { MemoryPolicy } from "../src/memory/MemoryPolicy";

describe("MemoryPolicy", () => {
  const policy = new MemoryPolicy();

  it("stores stable preferences", () => {
    const verdict = policy.evaluate({ content: "I prefer dark mode and tea over coffee" });
    expect(verdict.store).toBe(true);
    expect(verdict.importance).toBeGreaterThanOrEqual(3);
  });

  it("stores server facts", () => {
    expect(policy.evaluate({ content: "our server's game night is every Friday at 8pm" }).store).toBe(true);
  });

  it("does not store casual one-offs", () => {
    expect(policy.evaluate({ content: "lol that was hilarious" }).store).toBe(false);
    expect(policy.evaluate({ content: "good morning" }).store).toBe(false);
    expect(policy.evaluate({ content: "what time is it?" }).store).toBe(false);
  });

  it("does not store random statements without durable-fact signal", () => {
    expect(policy.evaluate({ content: "the weather here got pretty cold today" }).store).toBe(false);
  });

  it("never stores secrets, even on explicit request", () => {
    const cases = [
      "remember my password: hunter2",
      "my api_key is abc123def456ghi789",
      "remember this: sk-abcdefghij1234567890",
    ];
    for (const content of cases) {
      const verdict = policy.evaluate({ content, explicit: true });
      expect(verdict.store).toBe(false);
      expect(verdict.reason).toMatch(/secret|credential/i);
    }
  });

  it("stores PII only when explicitly requested", () => {
    const email = "my email is test@example.com";
    expect(policy.evaluate({ content: email }).store).toBe(false);
    expect(policy.evaluate({ content: email, explicit: true }).store).toBe(true);
  });

  it("stores explicit requests with elevated importance", () => {
    const verdict = policy.evaluate({ content: "the deploy runbook lives in #ops pins", explicit: true });
    expect(verdict.store).toBe(true);
    expect(verdict.importance).toBe(4);
  });

  it("rejects too-short and too-long content", () => {
    expect(policy.evaluate({ content: "ok" }).store).toBe(false);
    expect(policy.evaluate({ content: "x".repeat(2500) }).store).toBe(false);
  });
});
