import { logger } from "../src/config/logger";
import { initDatabase, closeDatabase } from "../src/database/prisma";
import { LiveLearningRepository } from "../src/database/repositories/LiveLearningRepository";
import { ParameterGrowthPlanner } from "../src/training/parameter/ParameterGrowthPlanner";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = await initDatabase(logger);
  if (!prisma) {
    // eslint-disable-next-line no-console
    console.error("Database unavailable - start Postgres and run migrations before planning parameter growth.");
    process.exit(1);
  }

  const planner = new ParameterGrowthPlanner(new LiveLearningRepository(prisma));
  const written = await planner.writePlan(args.outDir, {
    limit: args.limit,
    ...(args.minItems ? { minItemsByKind: { adapter: args.minItems, router: args.minItems, specialist: args.minItems, expert: args.minItems } } : {}),
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ path: written.path, latestPath: written.latestPath, summary: written.plan.summary }, null, 2));
  await closeDatabase();
}

function parseArgs(argv: string[]): { outDir: string; limit?: number; minItems?: number } {
  let outDir = "training/plans/parameter-growth";
  let limit: number | undefined;
  let minItems: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--out-dir") outDir = requireValue(argv[++index], arg);
    else if (arg === "--limit") limit = parseInteger(argv[++index], arg);
    else if (arg === "--min-items") minItems = parseInteger(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { outDir, ...(limit ? { limit } : {}), ...(minItems ? { minItems } : {}) };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseInteger(value: string | undefined, flag: string): number {
  const raw = requireValue(value, flag);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

void main().catch(async (err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  await closeDatabase();
  process.exitCode = 1;
});
