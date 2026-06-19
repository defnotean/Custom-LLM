import { env } from "../src/config/env";
import { registerDiscordSlashCommands } from "../src/discord/slashCommands";

async function main(): Promise<void> {
  const result = await registerDiscordSlashCommands({
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.DISCORD_GUILD_ID || undefined,
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        status: "registered",
        scope: result.scope,
        route: result.route,
        commandCount: result.commandCount,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
