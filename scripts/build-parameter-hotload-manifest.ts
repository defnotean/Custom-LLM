import { ParameterModuleHotloadPlanner } from "../src/learning/ParameterModuleHotloadPlanner";
import { initDatabase, closeDatabase } from "../src/database/prisma";
import { LiveLearningRepository } from "../src/database/repositories/LiveLearningRepository";
import { logger } from "../src/config/logger";

interface Args {
  outDir: string;
  limit?: number;
  includeModuleIds?: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = await initDatabase(logger);
  if (!prisma) throw new Error("DATABASE_URL is required to build a parameter hotload manifest");
  try {
    const planner = new ParameterModuleHotloadPlanner(new LiveLearningRepository(prisma));
    const written = await planner.writeManifest(args.outDir, {
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.includeModuleIds ? { includeModuleIds: args.includeModuleIds } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(written, null, 2));
    if (written.manifest.status === "blocked") process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

function parseArgs(argv: string[]): Args {
  let outDir = "training/plans/parameter-hotload";
  let limit: number | undefined;
  let includeModuleIds: string[] | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--out-dir") outDir = requireValue(argv[++index], arg);
    else if (arg === "--limit") limit = parsePositiveInteger(argv[++index], arg);
    else if (arg === "--include-module-ids") includeModuleIds = parseList(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { outDir, ...(limit ? { limit } : {}), ...(includeModuleIds ? { includeModuleIds } : {}) };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseList(value: string | undefined, flag: string): string[] {
  const parsed = requireValue(value, flag)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (parsed.length === 0) throw new Error(`${flag} must include at least one value`);
  return parsed;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
