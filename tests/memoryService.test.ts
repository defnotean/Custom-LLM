import { describe, expect, it } from "vitest";
import type { MemoryExtractor } from "../src/memory/MemoryExtractor";
import { MemoryService } from "../src/memory/MemoryService";
import { InMemoryMemoryStore } from "../src/memory/InMemoryMemoryStore";
import { HashingEmbeddingProvider } from "../src/memory/EmbeddingProvider";
import { testLogger } from "./helpers";

function makeService() {
  return new MemoryService(new InMemoryMemoryStore(), new HashingEmbeddingProvider(), testLogger);
}

const ctx = { userId: "u1", guildId: "g1", channelId: "c1" };

describe("MemoryService", () => {
  it("remembers explicit facts and recalls them by similarity", async () => {
    const service = makeService();
    const stored = await service.remember({
      content: "I prefer to be called Lex and my timezone is CET",
      scope: "USER",
      userId: "u1",
      guildId: "g1",
      explicit: true,
    });
    expect(stored.stored).toBe(true);

    const hits = await service.search("what is my timezone", ctx, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("CET");
  });

  it("records successful memory writes as live learning items when configured", async () => {
    const learnedInputs: unknown[] = [];
    const service = new MemoryService(new InMemoryMemoryStore(), new HashingEmbeddingProvider(), testLogger, {
      learning: {
        createLearnedItem: async (input) => {
          learnedInputs.push(input);
          return { id: "learned-1" } as never;
        },
      },
    });

    const stored = await service.remember({
      content: "I prefer concise implementation updates",
      scope: "USER",
      userId: "u1",
      guildId: "g1",
      channelId: "c1",
      explicit: true,
    });

    expect(stored.stored).toBe(true);
    expect(stored.learnedItemId).toBe("learned-1");
    expect(learnedInputs).toHaveLength(1);
    expect(learnedInputs[0]).toMatchObject({
      kind: "memory",
      source: "explicit_memory",
      content: "I prefer concise implementation updates",
      confidence: 1,
      accessPaths: ["memory_rag"],
      provenance: { userId: "u1", guildId: "g1", channelId: "c1", memoryId: stored.id },
      retention: { canRetrieve: true, canTrain: true },
    });
  });

  it("applies policy on non-explicit writes (one-offs rejected)", async () => {
    const service = makeService();
    const result = await service.remember({
      content: "lol nice one",
      scope: "USER",
      userId: "u1",
      explicit: false,
    });
    expect(result.stored).toBe(false);
  });

  it("never stores secrets even explicitly", async () => {
    const service = makeService();
    const result = await service.remember({
      content: "my password: hunter2",
      scope: "USER",
      userId: "u1",
      explicit: true,
    });
    expect(result.stored).toBe(false);
  });

  it("isolates memories between users", async () => {
    const service = makeService();
    await service.remember({
      content: "I main support in league ranked games",
      scope: "USER",
      userId: "u1",
      explicit: true,
    });
    const otherUserHits = await service.search("league ranked main", {
      userId: "u2",
      guildId: "g1",
      channelId: "c1",
    });
    expect(otherUserHits).toHaveLength(0);
  });

  it("enforces ownership on forget (non-admin cannot delete others' memories)", async () => {
    const service = makeService();
    const stored = await service.remember({
      content: "I prefer dark mode in every app",
      scope: "USER",
      userId: "u1",
      explicit: true,
    });
    expect(stored.id).toBeTruthy();
    const id = stored.id ?? "";

    const denied = await service.forget(id, { userId: "u2", isAdmin: false });
    expect(denied.deleted).toBe(false);

    const allowed = await service.forget(id, { userId: "u1", isAdmin: false });
    expect(allowed.deleted).toBe(true);
  });

  it("maybeExtract stores stable preferences from conversation", async () => {
    const service = makeService();
    const result = await service.maybeExtractMemoryFromConversation(
      ctx,
      "I prefer short answers btw",
      "got it, short answers it is",
    );
    expect(result.stored).toBe(true);

    const noStore = await service.maybeExtractMemoryFromConversation(
      ctx,
      "haha yeah totally",
      "fr",
    );
    expect(noStore.stored).toBe(false);
  });

  it("stores LLM-extracted ADD memories instead of the raw user message", async () => {
    const learnedInputs: unknown[] = [];
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, new HashingEmbeddingProvider(), testLogger, {
      extractionMode: "llm",
      extractor: fixedExtractor([
        {
          action: "ADD",
          content: "I prefer concise implementation updates.",
          scope: "USER",
          confidence: 0.91,
          reason: "stable preference",
        },
      ]),
      learning: {
        createLearnedItem: async (input) => {
          learnedInputs.push(input);
          return { id: "learned-extracted" } as never;
        },
      },
    });

    const result = await service.maybeExtractMemoryFromConversation(
      ctx,
      "yeah btw when you update me, short implementation updates are best",
      "got it",
    );

    expect(result.stored).toBe(true);
    const hits = await service.search("concise implementation updates", ctx, 5);
    expect(hits[0]?.content).toBe("I prefer concise implementation updates.");
    expect(hits.some((hit) => hit.content.includes("btw when you update me"))).toBe(false);
    expect(learnedInputs[0]).toMatchObject({
      source: "llm_memory_extractor",
      confidence: 0.91,
      retention: { canRetrieve: true, canTrain: false },
      metadata: {
        extractionAction: "ADD",
        extractionReason: "stable preference",
      },
    });
  });

  it("respects LLM-extracted NOOP decisions without heuristic fallback", async () => {
    const service = new MemoryService(new InMemoryMemoryStore(), new HashingEmbeddingProvider(), testLogger, {
      extractionMode: "hybrid",
      extractor: fixedExtractor([{ action: "NOOP", reason: "not durable" }]),
    });

    const result = await service.maybeExtractMemoryFromConversation(
      ctx,
      "I prefer short answers btw",
      "got it",
    );

    expect(result).toEqual({ stored: false, reason: "not durable" });
    expect(await service.count()).toBe(0);
  });

  it("falls back to heuristic extraction in hybrid mode when the extractor fails", async () => {
    const service = new MemoryService(new InMemoryMemoryStore(), new HashingEmbeddingProvider(), testLogger, {
      extractionMode: "hybrid",
      extractor: {
        async extract() {
          throw new Error("extractor offline");
        },
      },
    });

    const result = await service.maybeExtractMemoryFromConversation(
      ctx,
      "I prefer short answers btw",
      "got it",
    );

    expect(result.stored).toBe(true);
    expect(await service.count()).toBe(1);
  });

  it("applies LLM-extracted DELETE decisions to matching user memories", async () => {
    const service = new MemoryService(new InMemoryMemoryStore(), new HashingEmbeddingProvider(), testLogger, {
      extractionMode: "llm",
      extractor: fixedExtractor([{ action: "DELETE", target: "short answers", reason: "user asked to forget" }]),
    });
    await service.remember({
      content: "I prefer short answers.",
      scope: "USER",
      userId: "u1",
      guildId: "g1",
      channelId: "c1",
      explicit: true,
    });

    const result = await service.maybeExtractMemoryFromConversation(
      ctx,
      "forget that I prefer short answers",
      "forgotten",
    );

    expect(result.stored).toBe(false);
    expect(result.reason).toMatch(/deleted memory/);
    expect(await service.count()).toBe(0);
  });

  it("applies LLM-extracted UPDATE decisions by replacing a matching memory", async () => {
    const service = new MemoryService(new InMemoryMemoryStore(), new HashingEmbeddingProvider(), testLogger, {
      extractionMode: "llm",
      extractor: fixedExtractor([
        {
          action: "UPDATE",
          target: "short answers",
          content: "I prefer detailed implementation notes.",
          reason: "preference correction",
        },
      ]),
    });
    await service.remember({
      content: "I prefer short answers.",
      scope: "USER",
      userId: "u1",
      guildId: "g1",
      channelId: "c1",
      explicit: true,
    });

    const result = await service.maybeExtractMemoryFromConversation(
      ctx,
      "actually don't keep answers short; I want detailed implementation notes",
      "updated",
    );

    expect(result.stored).toBe(true);
    expect(await service.count()).toBe(1);
    const hits = await service.search("detailed implementation notes", ctx, 5);
    expect(hits[0]?.content).toBe("I prefer detailed implementation notes.");
  });
});

function fixedExtractor(decisions: Awaited<ReturnType<MemoryExtractor["extract"]>>): MemoryExtractor {
  return {
    async extract() {
      return decisions;
    },
  };
}
