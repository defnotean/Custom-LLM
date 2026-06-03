import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../src/config/logger";
import { buildToolRegistry } from "../src/tools";
import { ToolExampleGenerator } from "../src/training/synthetic/ToolExampleGenerator";
import { initDatabase, closeDatabase } from "../src/database/prisma";
import { TrainingExampleRepository } from "../src/database/repositories/TrainingExampleRepository";
import { toErrorMessage } from "../src/utils/errors";

/**
 * Generate deterministic synthetic tool examples from the registry:
 *   npm run generate:examples
 * Always writes exports/training/synthetic-tools.jsonl; additionally
 * persists rows to the TrainingExample table when the DB is reachable.
 * No external API calls.
 */
async function main(): Promise<void> {
  const registry = buildToolRegistry();
  const generator = new ToolExampleGenerator(registry);
  const examples = generator.generateAll();

  const outDir = "exports/training";
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, "synthetic-tools.jsonl");
  await writeFile(path, `${examples.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Generated ${examples.length} synthetic examples → ${path}`);

  const prisma = await initDatabase(logger);
  if (prisma) {
    const repo = new TrainingExampleRepository(prisma);
    let inserted = 0;
    for (const example of examples) {
      try {
        await repo.create({
          source: example.source,
          format: example.format,
          inputJson: example.inputJson,
          outputJson: example.outputJson,
          qualityScore: example.qualityScore,
          metadataJson: example.metadataJson,
        });
        inserted++;
      } catch (err) {
        logger.warn({ err: toErrorMessage(err) }, "failed to persist synthetic example");
      }
    }
    // eslint-disable-next-line no-console
    console.log(`Persisted ${inserted}/${examples.length} examples to the TrainingExample table.`);
    await closeDatabase();
  } else {
    // eslint-disable-next-line no-console
    console.log("Database unavailable — JSONL written, DB persistence skipped.");
  }
}

void main();
