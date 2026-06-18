import { readFile } from "node:fs/promises";
import { logger } from "../src/config/logger";
import { initDatabase, closeDatabase } from "../src/database/prisma";
import { LiveLearningRepository } from "../src/database/repositories/LiveLearningRepository";
import { ParameterGrowthDatasetBuilder } from "../src/training/parameter/ParameterGrowthDatasetBuilder";
import type { ParameterGrowthGateThresholds } from "../src/training/parameter/ParameterGrowthPlanGate";
import type { ParameterGrowthPlan } from "../src/training/parameter/ParameterGrowthPlanner";

interface Args {
  plan: string;
  outDir: string;
  gateThresholds: Partial<ParameterGrowthGateThresholds>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = await initDatabase(logger);
  if (!prisma) {
    // eslint-disable-next-line no-console
    console.error("Database unavailable - start Postgres and run migrations before building parameter-growth data.");
    process.exit(1);
  }

  const plan = JSON.parse(await readFile(args.plan, "utf8")) as ParameterGrowthPlan;
  const builder = new ParameterGrowthDatasetBuilder(new LiveLearningRepository(prisma));
  const result = await builder.build(plan, {
    outDir: args.outDir,
    gateThresholds: args.gateThresholds,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ manifestPath: result.manifestPath, files: result.manifest.files }, null, 2));
  await closeDatabase();
}

function parseArgs(argv: string[]): Args {
  let plan = "training/plans/parameter-growth/latest.json";
  let outDir = "training/data/parameter-growth";
  const gateThresholds: Partial<ParameterGrowthGateThresholds> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--plan") plan = requireValue(argv[++index], arg);
    else if (arg === "--out-dir") outDir = requireValue(argv[++index], arg);
    else if (arg === "--allow-risk-review") gateThresholds.requireRiskReview = false;
    else if (arg === "--min-ready-batches") gateThresholds.minReadyBatches = parseInteger(argv[++index], arg);
    else if (arg === "--min-records-per-ready-batch") gateThresholds.minRecordsPerReadyBatch = parseInteger(argv[++index], arg);
    else if (arg === "--max-estimated-new-parameters") gateThresholds.maxEstimatedNewParameters = parseInteger(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { plan, outDir, gateThresholds };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseInteger(value: string | undefined, flag: string): number {
  const raw = requireValue(value, flag);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

void main().catch(async (err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  await closeDatabase();
  process.exitCode = 1;
});
