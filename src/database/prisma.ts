import { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { env } from "../config/env";
import { toErrorMessage } from "../utils/errors";

/**
 * Lazy Prisma singleton + availability gate. The bot is designed to boot and
 * chat without a database (persistence features degrade gracefully); every
 * repository checks availability through the handle it was given.
 */

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!client) {
    // Pass the Zod-validated URL explicitly so the env default applies even
    // when DATABASE_URL isn't set in the process environment.
    client = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  }
  return client;
}

/**
 * Try to connect; returns the client on success, null when the DB is
 * unreachable (callers treat null as "persistence disabled").
 */
export async function initDatabase(logger: Logger): Promise<PrismaClient | null> {
  try {
    const prisma = getPrisma();
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    logger.info("database connected");
    return prisma;
  } catch (err) {
    logger.warn(
      { err: toErrorMessage(err) },
      "database unavailable — persistence features disabled (conversations, tool logs, training capture)",
    );
    return null;
  }
}

export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.$disconnect().catch(() => undefined);
    client = null;
  }
}
