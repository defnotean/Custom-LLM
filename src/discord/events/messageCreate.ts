import { ChannelType, type Client, type Message } from "discord.js";
import type { Logger } from "pino";
import type { AgentController } from "../../ai/orchestration/AgentController";
import { toErrorMessage } from "../../utils/errors";
import { buildMessageContext, buildRecentTranscript } from "../utils/discordContext";
import { splitMessage } from "../utils/messageSplitter";
import { handleCommand, type CommandServices } from "../commands";

export interface MessageHandlerOptions {
  client: Client;
  agent: AgentController;
  commandServices: CommandServices;
  commandPrefix: string; // e.g. "!ai"
  logger: Logger;
}

/**
 * messageCreate handler.
 *
 * Engagement policy (spam/cost control): the bot responds to
 *  - `!ai ...` prefix commands,
 *  - direct messages,
 *  - messages that @mention it,
 *  - replies to its own messages.
 * Per-guild channel allowlists live in GuildProfile.settingsJson (documented
 * TODO — see docs/ARCHITECTURE.md "Decisions").
 */
export function createMessageHandler(options: MessageHandlerOptions) {
  const { client, agent, commandServices, commandPrefix, logger } = options;

  return async function onMessageCreate(message: Message): Promise<void> {
    try {
      // Ignore bots (including ourselves) and empty/system messages.
      if (message.author.bot) return;
      const content = message.content.trim();
      if (content.length === 0) return;

      const isDM = message.channel.type === ChannelType.DM;
      const isCommand = content.toLowerCase().startsWith(commandPrefix.toLowerCase());
      const mentionsBot = client.user ? message.mentions.users.has(client.user.id) : false;
      const isReplyToBot = await isReplyToOurMessage(message, client);

      if (!isCommand && !isDM && !mentionsBot && !isReplyToBot) return;

      // Strip the prefix / leading mention for downstream processing.
      let stripped = content;
      if (isCommand) {
        stripped = content.slice(commandPrefix.length).trim();
      } else if (mentionsBot && client.user) {
        stripped = content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
        if (stripped.length === 0) stripped = "hey";
      }

      const ctx = buildMessageContext(message, stripped);

      await withTyping(message, async () => {
        const reply = isCommand
          ? await handleCommand(ctx, commandServices)
          : (
              await agent.handleDiscordMessage(ctx, {
                transcript: await buildRecentTranscript(message, client),
              })
            ).content;

        await sendChunked(message, reply);
      });
    } catch (err) {
      logger.error({ err: toErrorMessage(err) }, "messageCreate handler failed");
      await message
        .reply("Something broke on my end — try again in a bit.")
        .catch(() => undefined);
    }
  };
}

/** Keep the typing indicator alive while the handler runs (refresh ~8s). */
async function withTyping(message: Message, fn: () => Promise<void>): Promise<void> {
  const channel = message.channel;
  const canType = "sendTyping" in channel;
  if (canType) await channel.sendTyping().catch(() => undefined);
  const interval = canType
    ? setInterval(() => void channel.sendTyping().catch(() => undefined), 8000)
    : null;
  try {
    await fn();
  } finally {
    if (interval) clearInterval(interval);
  }
}

async function sendChunked(message: Message, content: string): Promise<void> {
  const chunks = splitMessage(content);
  const first = chunks[0];
  if (first === undefined) return;
  await message.reply({ content: first, allowedMentions: { repliedUser: true, parse: [] } });
  for (const chunk of chunks.slice(1)) {
    if ("send" in message.channel) {
      await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }
}

async function isReplyToOurMessage(message: Message, client: Client): Promise<boolean> {
  if (!message.reference?.messageId || !client.user) return false;
  try {
    const referenced = await message.fetchReference();
    return referenced.author.id === client.user.id;
  } catch {
    return false;
  }
}
