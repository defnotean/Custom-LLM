import { getPrisma, closeDatabase } from "../src/database/prisma";

/**
 * READ-ONLY database smoke test:  npx tsx scripts/check-db.ts
 *
 * Pings DATABASE_URL and prints row counts for every table. Use it after
 * pointing `.env` at a fresh Postgres and running `npx prisma migrate deploy`
 * to confirm the schema applied and the bot can reach the DB.
 *
 * This script performs NO writes and NO migrations — purely `SELECT count(*)`.
 * It imports the bot's existing Prisma client; it does not change any bot code.
 */

// [model accessor, human label] — matches prisma/schema.prisma.
const TABLES: ReadonlyArray<readonly [string, string]> = [
  ["userProfile", "UserProfile"],
  ["guildProfile", "GuildProfile"],
  ["channelProfile", "ChannelProfile"],
  ["conversation", "Conversation"],
  ["memory", "Memory"],
  ["toolLog", "ToolLog"],
  ["trainingExample", "TrainingExample"],
  ["userFeedback", "UserFeedback"],
  ["toolDefinitionRecord", "ToolDefinitionRecord"],
];

async function main(): Promise<void> {
  const prisma = getPrisma();

  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "Could not reach the database. Check DATABASE_URL in .env, then run " +
        "`npx prisma migrate deploy`.\n" +
        `  ${err instanceof Error ? err.message : String(err)}`,
    );
    await closeDatabase();
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log("Database reachable. Table row counts:\n");

  let missingTables = 0;
  let total = 0;

  for (const [accessor, label] of TABLES) {
    // The model delegates are typed individually; index access needs a cast.
    const delegates = prisma as unknown as Record<string, { count: () => Promise<number> } | undefined>;
    const delegate = delegates[accessor];
    if (!delegate) {
      // Should never happen — accessor names are hard-coded from the schema.
      throw new Error(`Unknown Prisma model accessor: ${accessor}`);
    }
    try {
      const count = await delegate.count();
      total += count;
      // eslint-disable-next-line no-console
      console.log(`  ${label.padEnd(22)} ${count}`);
    } catch {
      missingTables += 1;
      // eslint-disable-next-line no-console
      console.log(`  ${label.padEnd(22)} (missing — run \`npx prisma migrate deploy\`)`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\nTotal rows across tables: ${total}`);

  if (missingTables > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n${missingTables} table(s) are missing. The connection works but the schema ` +
        "is not applied yet — run `npx prisma migrate deploy`.",
    );
    await closeDatabase();
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log("\nSchema looks good. `npm run export:training` will now reach the DB.");
  await closeDatabase();
}

void main();
