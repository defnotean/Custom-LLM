import { describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, type EmbeddingProvider } from "../src/memory/EmbeddingProvider";
import { buildToolRegistry } from "../src/tools";
import { EmbeddingToolRetrievalStrategy, ToolRouter } from "../src/tools/ToolRouter";

describe("ToolRouter (keyword strategy)", () => {
  const registry = buildToolRegistry();
  const router = new ToolRouter(registry);

  it("routes moderation requests to moderation tools", async () => {
    const result = await router.route({
      message: "please timeout that user for 10 minutes, they keep spamming",
      guildId: "g1",
      memberPermissions: ["MODERATE_MEMBERS", "MANAGE_MESSAGES"],
    });
    expect(result.likelyNeedsTool).toBe(true);
    expect(result.candidateTools.map((t) => t.name)).toContain("timeout_user");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning.length).toBeGreaterThan(0);
  });

  it("filters out tools the member lacks permissions for", async () => {
    const result = await router.route({
      message: "timeout that spammer for 10 minutes",
      guildId: "g1",
      memberPermissions: [], // no MODERATE_MEMBERS
    });
    expect(result.candidateTools.map((t) => t.name)).not.toContain("timeout_user");
  });

  it("treats casual chat as no-tool", async () => {
    const result = await router.route({
      message: "haha that movie was so good fr",
      guildId: "g1",
      memberPermissions: [],
    });
    expect(result.likelyNeedsTool).toBe(false);
  });

  it("caps candidates at maxTools", async () => {
    const result = await router.route({
      message: "server info channel info time ping stats memory message user",
      guildId: "g1",
      memberPermissions: ["ADMINISTRATOR"],
      maxTools: 3,
    });
    expect(result.candidateTools.length).toBeLessThanOrEqual(3);
  });

  it("matches memory phrasing to memory tools", async () => {
    const result = await router.route({
      message: "remember that my timezone is CET",
      guildId: "g1",
      memberPermissions: [],
    });
    expect(result.likelyNeedsTool).toBe(true);
    expect(result.candidateTools.map((t) => t.name)).toContain("remember_fact");
  });
});

describe("ToolRouter (embedding strategy)", () => {
  const registry = buildToolRegistry();

  it("uses embedding-ranked tool documents without bypassing permission filters", async () => {
    const strategy = new EmbeddingToolRetrievalStrategy(registry, new HashingEmbeddingProvider(512));
    const router = new ToolRouter(registry, { strategy });

    const allowed = await router.route({
      message: "remember that my timezone is CET",
      guildId: "g1",
      memberPermissions: [],
      maxTools: 5,
    });
    expect(allowed.likelyNeedsTool).toBe(true);
    expect(allowed.reasoning).toContain("embedding candidates");
    expect(allowed.candidateTools.map((tool) => tool.name)).toContain("remember_fact");

    const denied = await router.route({
      message: "timeout that spammer for 10 minutes",
      guildId: "g1",
      memberPermissions: [],
      maxTools: 10,
    });
    expect(denied.candidateTools.map((tool) => tool.name)).not.toContain("timeout_user");
  });

  it("falls back to keyword routing if embeddings fail", async () => {
    const failingEmbeddings: EmbeddingProvider = {
      name: "failing-test-embeddings",
      dims: 2,
      embed: async () => {
        throw new Error("embedding service down");
      },
    };
    const strategy = new EmbeddingToolRetrievalStrategy(registry, failingEmbeddings);
    const router = new ToolRouter(registry, { strategy });

    const result = await router.route({
      message: "please timeout that user for 10 minutes, they keep spamming",
      guildId: "g1",
      memberPermissions: ["MODERATE_MEMBERS"],
    });

    expect(result.likelyNeedsTool).toBe(true);
    expect(result.reasoning).toContain("top candidates");
    expect(result.candidateTools.map((tool) => tool.name)).toContain("timeout_user");
  });
});
