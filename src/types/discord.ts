import type { Message } from "discord.js";
import type { GuildSettings } from "../database/repositories/GuildRepository";

/**
 * Normalized view of an incoming Discord message — everything downstream
 * layers need without coupling them to discord.js internals. Built by
 * src/discord/utils/discordContext.ts.
 */
export interface BotMessageContext {
  guildId: string | null;
  guildName: string | null;
  channelId: string;
  channelName: string | null;
  userId: string;
  username: string;
  displayName: string | null;
  messageId: string;
  /** Message content with the bot mention / prefix stripped. */
  content: string;
  isDM: boolean;
  mentionsBot: boolean;
  /** Normalized UPPER_SNAKE Discord permission names for the member. */
  memberPermissions: readonly string[];
  /** Raw discord.js message — only the discord layer + tools should touch this. */
  guildSettings?: GuildSettings;
  raw?: Message;
}
