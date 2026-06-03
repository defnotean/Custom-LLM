import { describe, expect, it } from "vitest";
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
});
