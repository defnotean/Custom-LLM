import pino from "pino";
import { getPrisma, closeDatabase } from "../src/database/prisma";
import { runPgVectorMemorySmoke } from "../src/memory/PgVectorMemorySmoke";

interface CliOptions {
  dims: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const prisma = getPrisma();

  try {
    await prisma.$connect();
    const report = await runPgVectorMemorySmoke({
      prisma,
      dims: options.dims,
      logger,
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));

    if (report.status !== "pass") {
      const failures = report.checks
        .filter((check) => check.status === "fail")
        .map((check) => `${check.id}: ${check.summary}`)
        .join("; ");
      throw new Error(`pgvector memory smoke failed: ${failures}`);
    }
  } finally {
    await closeDatabase();
  }
}

function parseArgs(argv: string[]): CliOptions {
  let dims: number | null = null;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dims") dims = parsePositiveInt(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (dims === null) {
    throw new Error("Missing required --dims <embedding-dimensions>; use the same dimension as your memory embedding model");
  }
  return { dims };
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
