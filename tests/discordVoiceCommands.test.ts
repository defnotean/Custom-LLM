import { describe, expect, it } from "vitest";
import { handleCommand, type CommandServices } from "../src/discord/commands";
import type { BotMessageContext } from "../src/types/discord";
import { testLogger } from "./helpers";

function ctx(content: string): BotMessageContext {
  return {
    guildId: "guild-1",
    guildName: "Guild One",
    channelId: "text-1",
    channelName: "general",
    userId: "user-1",
    username: "tester",
    displayName: "Tester",
    messageId: "message-1",
    content,
    isDM: false,
    mentionsBot: false,
    memberPermissions: ["ADMINISTRATOR"],
  };
}

function services(): CommandServices {
  return {
    registry: null as never,
    executor: null as never,
    buildToolContext: null as never,
    logger: testLogger,
    voice: {
      status: () => ({ ok: true, message: "voice status ok" }),
      describeCurrentPolicy: async () => ({ ok: true, message: "voice policy ok" }),
      enableCurrentChannel: async () => ({ ok: true, message: "voice enabled" }),
      disableGuild: async () => ({ ok: true, message: "voice disabled" }),
      joinCurrentChannel: async () => ({ ok: true, message: "voice joined" }),
      leaveGuild: () => ({ ok: true, message: "voice left" }),
    } as never,
  };
}

describe("voice commands", () => {
  it("routes voice subcommands to the deterministic voice service", async () => {
    await expect(handleCommand(ctx("voice status"), services())).resolves.toBe("voice status ok");
    await expect(handleCommand(ctx("voice policy"), services())).resolves.toBe("voice policy ok");
    await expect(handleCommand(ctx("voice enable"), services())).resolves.toBe("voice enabled");
    await expect(handleCommand(ctx("voice disable"), services())).resolves.toBe("voice disabled");
    await expect(handleCommand(ctx("voice join"), services())).resolves.toBe("voice joined");
    await expect(handleCommand(ctx("voice leave"), services())).resolves.toBe("voice left");
  });

  it("keeps voice unavailable when the service is not wired", async () => {
    const withoutVoice = { ...services(), voice: null };
    await expect(handleCommand(ctx("voice status"), withoutVoice)).resolves.toBe("Voice service is unavailable.");
  });
});
