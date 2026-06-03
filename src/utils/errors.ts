/** Typed application errors + helpers for consistent error handling. */

export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CONFIG_ERROR", message, options);
  }
}

export class LLMProviderError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("LLM_PROVIDER_ERROR", message, options);
  }
}

export class ToolExecutionError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("TOOL_EXECUTION_ERROR", message, options);
  }
}

/** Extract a safe human-readable message from any thrown value. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Run a promise with a timeout; rejects with AppError("TIMEOUT") on expiry. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AppError("TIMEOUT", `${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
