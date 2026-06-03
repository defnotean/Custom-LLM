import { logger } from "../src/config/logger";
import { initDatabase, closeDatabase } from "../src/database/prisma";
import { TrainingExampleRepository } from "../src/database/repositories/TrainingExampleRepository";
import { DatasetExporter } from "../src/training/DatasetExporter";

/**
 * Export stored training examples to JSONL:  npm run export:training
 * Writes exports/training/{chatml,alpaca,tool-calling,dpo-placeholder}.jsonl
 */
async function main(): Promise<void> {
  const prisma = await initDatabase(logger);
  if (!prisma) {
    // eslint-disable-next-line no-console
    console.error("Database unavailable — start Postgres (docker compose up -d postgres) and run migrations first.");
    process.exit(1);
  }

  const exporter = new DatasetExporter({
    source: new TrainingExampleRepository(prisma),
    logger,
  });
  const summary = await exporter.exportAll("exports/training");

  // eslint-disable-next-line no-console
  console.log(`Exported ${summary.totalExamples} examples (${summary.skipped} skipped):`);
  for (const file of summary.files) {
    // eslint-disable-next-line no-console
    console.log(`  ${file.path} — ${file.lines} lines`);
  }
  await closeDatabase();
}

void main();
