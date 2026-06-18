import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, toolOk } from "../src/tools/ToolDefinition";
import { ToolCooldownService } from "../src/tools/ToolCooldownService";
import { ToolExecutor } from "../src/tools/ToolExecutor";
import { ToolPermissionService } from "../src/tools/ToolPermissionService";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { testLogger, testToolContext } from "./helpers";

function makeExecutor(registry: ToolRegistry): ToolExecutor {
  return new ToolExecutor({
    registry,
    permissions: new ToolPermissionService(),
    cooldowns: new ToolCooldownService(),
    logger: testLogger,
  });
}

describe("ToolExecutor guild policy", () => {
  it("denies tools disabled by guild settings before argument validation", async () => {
    const registry = new ToolRegistry();
    let executed = false;
    registry.registerTool(
      defineTool({
        name: "send_message",
        category: "discord",
        description: "Send a message to a channel",
        riskLevel: "medium",
        requiresConfirmation: false,
        argsSchema: z.object({ channelId: z.string().min(1), content: z.string().min(1) }),
        execute: async () => {
          executed = true;
          return toolOk({ sent: true });
        },
      }),
    );

    const outcome = await makeExecutor(registry).execute(
      "send_message",
      {},
      testToolContext({ disabledTools: ["send_message"] }),
    );

    expect(outcome.status).toBe("denied");
    expect(outcome.denialReason).toBe("disabled");
    expect(outcome.message).toContain("disabled in this server");
    expect(executed).toBe(false);
  });
});
