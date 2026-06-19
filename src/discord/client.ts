import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import type { Logger } from "pino";
import { ConfigError } from "../utils/errors";
import { applyDiscordPresence, type DiscordPresenceOptions } from "./presence";

/**
 * Discord client factory. Requires the privileged MessageContent intent —
 * enable it in the developer portal (docs/DISCORD_SETUP.md).
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Partials.Channel is required to receive DMs.
    partials: [Partials.Channel, Partials.Message],
  });
}

export async function startDiscordClient(
  client: Client,
  token: string,
  logger: Logger,
  presence?: DiscordPresenceOptions,
): Promise<void> {
  if (!token) {
    throw new ConfigError(
      "DISCORD_TOKEN is empty — set it in .env (see docs/DISCORD_SETUP.md)",
    );
  }

  client.once(Events.ClientReady, (ready) => {
    if (presence) applyDiscordPresence(ready, presence, logger);
    logger.info(
      { user: ready.user.tag, guilds: ready.guilds.cache.size },
      "discord client ready",
    );
  });

  client.on(Events.Error, (err) => logger.error({ err: err.message }, "discord client error"));
  client.on(Events.Warn, (msg) => logger.warn({ msg }, "discord client warning"));

  await client.login(token);
}
