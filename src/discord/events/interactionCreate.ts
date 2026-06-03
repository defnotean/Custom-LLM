import type { Interaction } from "discord.js";
import type { Logger } from "pino";

/**
 * Slash-command handler — PLACEHOLDER.
 *
 * Status: scaffolded only. The prefix command set (`!ai ...`) and mention
 * conversation are the supported interfaces today. Implementing slash
 * commands properly requires:
 *  1. a registration script (PUT applications/{id}/commands, guild-scoped in
 *     dev via DISCORD_GUILD_ID),
 *  2. deferReply() within 3s + followUp() for LLM-latency responses,
 *  3. routing into the same AgentController/command paths used here.
 * Tracked in docs/ARCHITECTURE.md → "Placeholders & TODOs".
 */
export function createInteractionHandler(options: { logger: Logger }) {
  const { logger } = options;

  return async function onInteractionCreate(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    logger.info({ command: interaction.commandName }, "slash command received (placeholder)");
    await interaction
      .reply({
        content:
          "Slash commands aren't wired up yet — use `!ai help` or just mention me to chat.",
        ephemeral: true,
      })
      .catch(() => undefined);
  };
}
