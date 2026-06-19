import { randomUUID } from "node:crypto";
import pino from "pino";
import { env } from "../src/config/env";
import { runQdrantMemorySmoke } from "../src/memory/QdrantMemorySmoke";

interface CliOptions {
  url: string;
  collection: string;
  dims: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const report = await runQdrantMemorySmoke({
    url: options.url,
    collection: options.collection,
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
    throw new Error(`Qdrant memory smoke failed: ${failures}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    url: env.QDRANT_URL,
    collection: `${env.QDRANT_COLLECTION}_smoke_${Date.now()}_${randomUUID().slice(0, 8)}`,
    dims: 64,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--url") options.url = requireValue(argv[++index], arg);
    else if (arg === "--collection") options.collection = requireValue(argv[++index], arg);
    else if (arg === "--dims") options.dims = parsePositiveInt(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
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
