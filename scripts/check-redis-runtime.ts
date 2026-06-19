import { randomUUID } from "node:crypto";
import pino from "pino";
import { env } from "../src/config/env";
import { connectRedisRuntimeState } from "../src/state/RedisRuntimeState";
import { runRedisRuntimeSmoke } from "../src/state/RedisRuntimeSmoke";

interface CliOptions {
  url: string;
  keyPrefix: string;
  timeoutMs: number;
  connectTimeoutMs: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const runtimeState = await connectRedisRuntimeState({
    url: options.url,
    keyPrefix: options.keyPrefix,
    connectTimeoutMs: options.connectTimeoutMs,
    logger,
  });

  try {
    const report = await runRedisRuntimeSmoke({
      runtimeState,
      keyPrefix: options.keyPrefix,
      timeoutMs: options.timeoutMs,
      logger,
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "pass") {
      const failures = report.checks
        .filter((check) => check.status === "fail")
        .map((check) => `${check.id}: ${check.summary}`)
        .join("; ");
      throw new Error(`Redis runtime smoke failed: ${failures}`);
    }
  } finally {
    await runtimeState.close();
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    url: env.REDIS_URL,
    keyPrefix: `${env.REDIS_KEY_PREFIX}:smoke:${Date.now()}:${randomUUID().slice(0, 8)}`,
    timeoutMs: 5_000,
    connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--url") options.url = requireValue(argv[++index], arg);
    else if (arg === "--key-prefix") options.keyPrefix = requireValue(argv[++index], arg);
    else if (arg === "--timeout-ms") options.timeoutMs = parsePositiveInt(argv[++index], arg);
    else if (arg === "--connect-timeout-ms") options.connectTimeoutMs = parsePositiveInt(argv[++index], arg);
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
