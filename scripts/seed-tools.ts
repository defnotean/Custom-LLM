import { logger } from "../src/config/logger";
import { buildToolRegistry } from "../src/tools";
import { initDatabase, closeDatabase } from "../src/database/prisma";
import type { ToolRisk } from "@prisma/client";

/**
 * Sync the in-code tool registry into the ToolDefinitionRecord table:
 *   npm run seed:tools
 * The DB records exist for ops visibility (per-guild enable/disable,
 * dashboards) — the in-code registry remains the execution source of truth.
 */
async function main(): Promise<void> {
  const prisma = await initDatabase(logger);
  if (!prisma) {
    // eslint-disable-next-line no-console
    console.error("Database unavailable — start Postgres and run migrations first.");
    process.exit(1);
  }

  const registry = buildToolRegistry();
  const riskMap: Record<string, ToolRisk> = {
    low: "LOW",
    medium: "MEDIUM",
    high: "HIGH",
    critical: "CRITICAL",
  };

  let upserted = 0;
  for (const meta of registry.exportToolMetadata()) {
    await prisma.toolDefinitionRecord.upsert({
      where: { name: meta.name },
      create: {
        name: meta.name,
        category: meta.category,
        description: meta.description,
        schemaJson: meta.argsShape,
        riskLevel: riskMap[meta.riskLevel] ?? "MEDIUM",
        enabled: meta.enabled,
        requiresConfirmation: meta.requiresConfirmation,
        requiredPermissionsJson: meta.requiredDiscordPermissions,
        cooldownSeconds: meta.cooldownSeconds,
      },
      update: {
        category: meta.category,
        description: meta.description,
        schemaJson: meta.argsShape,
        riskLevel: riskMap[meta.riskLevel] ?? "MEDIUM",
        enabled: meta.enabled,
        requiresConfirmation: meta.requiresConfirmation,
        requiredPermissionsJson: meta.requiredDiscordPermissions,
        cooldownSeconds: meta.cooldownSeconds,
      },
    });
    upserted++;
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${upserted} tool definition records.`);
  await closeDatabase();
}

void main();
