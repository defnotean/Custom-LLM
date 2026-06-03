import { describe, expect, it } from "vitest";
import { buildToolRegistry } from "../src/tools";
import { ToolRouter } from "../src/tools/ToolRouter";

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
