export function nowIso(): string {
  return new Date().toISOString();
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Milliseconds elapsed since a `performance.now()`/`Date.now()` start mark. */
export function elapsedMs(startMs: number): number {
  return Math.round(Date.now() - startMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function msToHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
