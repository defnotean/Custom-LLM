import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolPermissionService } from "../src/tools/ToolPermissionService";
import { defineTool, toolOk } from "../src/tools/ToolDefinition";
import { toUpperSnake } from "../src/discord/utils/permissions";

const modTool = defineTool({
  name: "mod_tool",
  category: "moderation",
  description: "needs perms",
  riskLevel: "high",
  requiresConfirmation: true,
  requiredDiscordPermissions: ["MODERATE_MEMBERS", "MANAGE_MESSAGES"],
  argsSchema: z.object({}),
  execute: async () => toolOk({}),
});

const openTool = defineTool({
  name: "open_tool",
  category: "utility",
  description: "no perms needed",
  riskLevel: "low",
  requiresConfirmation: false,
  argsSchema: z.object({}),
  execute: async () => toolOk({}),
});

describe("ToolPermissionService", () => {
  const service = new ToolPermissionService();

  it("allows tools without permission requirements", () => {
    expect(service.check(openTool, [])).toEqual({ allowed: true, missing: [] });
  });

  it("denies when permissions are missing and reports which", () => {
    const result = service.check(modTool, ["MODERATE_MEMBERS"]);
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual(["MANAGE_MESSAGES"]);
  });

  it("allows when all permissions are held", () => {
    expect(service.check(modTool, ["MODERATE_MEMBERS", "MANAGE_MESSAGES"]).allowed).toBe(true);
  });

  it("ADMINISTRATOR bypasses requirements", () => {
    expect(service.check(modTool, ["ADMINISTRATOR"]).allowed).toBe(true);
  });

  it("is case-insensitive on held permissions", () => {
    expect(service.check(modTool, ["moderate_members", "manage_messages"]).allowed).toBe(true);
  });
});

describe("toUpperSnake", () => {
  it("converts discord.js PascalCase permission names", () => {
    expect(toUpperSnake("ModerateMembers")).toBe("MODERATE_MEMBERS");
    expect(toUpperSnake("ManageMessages")).toBe("MANAGE_MESSAGES");
    expect(toUpperSnake("Administrator")).toBe("ADMINISTRATOR");
    expect(toUpperSnake("ViewAuditLog")).toBe("VIEW_AUDIT_LOG");
  });
});
