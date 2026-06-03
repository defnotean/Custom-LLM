import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { defineTool, toolOk } from "../src/tools/ToolDefinition";

function makeTool(name: string, category = "test", description = "A test tool.") {
  return defineTool({
    name,
    category,
    description,
    examples: [`use ${name}`],
    riskLevel: "low",
    requiresConfirmation: false,
    argsSchema: z.object({ value: z.string().min(2) }),
    execute: async (args) => toolOk({ value: args.value }),
  });
}

describe("ToolRegistry", () => {
  it("registers and retrieves tools", () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool("alpha_tool"));
    expect(registry.getTool("alpha_tool")?.name).toBe("alpha_tool");
    expect(registry.size).toBe(1);
  });

  it("rejects duplicate names", () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool("alpha_tool"));
    expect(() => registry.registerTool(makeTool("alpha_tool"))).toThrow(/already registered/);
  });

  it("rejects invalid names", () => {
    const registry = new ToolRegistry();
    expect(() => registry.registerTool(makeTool("Bad-Name"))).toThrow(/snake_case/);
  });

  it("lists by category and excludes disabled tools", () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool("a_one", "cat_a"));
    registry.registerTool({ ...makeTool("a_two", "cat_a"), enabled: false });
    registry.registerTool(makeTool("b_one", "cat_b"));
    expect(registry.listByCategory("cat_a").map((t) => t.name)).toEqual(["a_one"]);
    expect(registry.categories()).toEqual(["cat_a", "cat_b"]);
    expect(registry.listTools()).toHaveLength(2);
    expect(registry.listTools({ includeDisabled: true })).toHaveLength(3);
  });

  it("searches by keyword", () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool("timeout_user", "moderation", "Timeout a user temporarily."));
    registry.registerTool(makeTool("ping", "utility", "Check whether the bot is alive."));
    const hits = registry.searchTools("timeout someone");
    expect(hits[0]?.name).toBe("timeout_user");
  });

  it("validates tool calls: unknown tool, disabled tool, bad args, good args", () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool("alpha_tool"));
    registry.registerTool({ ...makeTool("off_tool"), enabled: false });

    expect(registry.validateToolCall("nope", {})).toMatchObject({ ok: false });
    expect(registry.validateToolCall("off_tool", { value: "ok" })).toMatchObject({ ok: false });

    const bad = registry.validateToolCall("alpha_tool", { value: "x" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/value/);

    const good = registry.validateToolCall("alpha_tool", { value: "hello" });
    expect(good.ok).toBe(true);
  });

  it("renders prompt descriptions for a subset only", () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool("alpha_tool"));
    registry.registerTool(makeTool("beta_tool"));
    const alpha = registry.getTool("alpha_tool");
    expect(alpha).toBeDefined();
    const text = registry.getToolDescriptionsForPrompt(alpha ? [alpha] : []);
    expect(text).toContain("alpha_tool");
    expect(text).not.toContain("beta_tool");
    expect(text).toContain("Arguments schema");
  });

  it("exports metadata with args shape", () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool("alpha_tool"));
    const meta = registry.exportToolMetadata();
    expect(meta[0]).toMatchObject({
      name: "alpha_tool",
      riskLevel: "low",
      argsShape: { value: "string" },
    });
  });
});
