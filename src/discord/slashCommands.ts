import { REST, Routes, SlashCommandBuilder } from "discord.js";

export const AI_SLASH_COMMAND_NAME = "ai";
export const AI_SLASH_INPUT_OPTION = "input";

export interface RegisterSlashCommandsOptions {
  token: string;
  clientId: string;
  guildId?: string;
  rest?: Pick<REST, "put">;
}

export interface RegisterSlashCommandsResult {
  scope: "guild" | "global";
  route: string;
  commandCount: number;
}

export function buildDiscordSlashCommands(): unknown[] {
  return [
    new SlashCommandBuilder()
      .setName(AI_SLASH_COMMAND_NAME)
      .setDescription("Talk to Irene or run an Irene command")
      .addStringOption((option) =>
        option
          .setName(AI_SLASH_INPUT_OPTION)
          .setDescription("Message or command text, for example: ping, settings show, or hello Irene")
          .setRequired(true)
          .setMaxLength(1800),
      )
      .toJSON(),
  ];
}

export async function registerDiscordSlashCommands(
  options: RegisterSlashCommandsOptions,
): Promise<RegisterSlashCommandsResult> {
  if (!options.token) throw new Error("DISCORD_TOKEN is required to register slash commands");
  if (!options.clientId) throw new Error("DISCORD_CLIENT_ID is required to register slash commands");

  const commands = buildDiscordSlashCommands();
  const rest = options.rest ?? new REST({ version: "10" }).setToken(options.token);
  const route = options.guildId
    ? Routes.applicationGuildCommands(options.clientId, options.guildId)
    : Routes.applicationCommands(options.clientId);

  await rest.put(route, { body: commands });
  return {
    scope: options.guildId ? "guild" : "global",
    route,
    commandCount: commands.length,
  };
}
