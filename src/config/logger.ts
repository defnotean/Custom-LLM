import pino, { type Logger } from "pino";
import { env } from "./env";

/**
 * Structured logging (pino). Pretty-printed in development, raw JSON in
 * production (ship to your aggregator), silent-by-default under tests.
 */

const isTest = env.NODE_ENV === "test" || Boolean(process.env.VITEST);
const usePretty = env.NODE_ENV === "development" && !isTest;

export const logger: Logger = pino({
  level: isTest && !process.env.LOG_LEVEL ? "silent" : env.LOG_LEVEL,
  base: { service: "custom-llm-discord-bot" },
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,service" },
        },
      }
    : {}),
});

export function childLogger(component: string): Logger {
  return logger.child({ component });
}

export type { Logger };
