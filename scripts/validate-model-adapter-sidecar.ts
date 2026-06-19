import { writeFile } from "node:fs/promises";
import {
  DEFAULT_MODEL_ADAPTER_SIDECAR_URL,
  validateModelAdapterSidecar,
} from "../src/serving/ModelAdapterSidecarValidation";

interface Args {
  manifest: string;
  endpointUrl: string;
  apiKey?: string;
  timeoutMs: number;
  execute: boolean;
  rollback: boolean;
  requestId?: string;
  out?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await validateModelAdapterSidecar({
    manifestPath: args.manifest,
    endpointUrl: args.endpointUrl,
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    timeoutMs: args.timeoutMs,
    execute: args.execute,
    rollback: args.rollback,
    ...(args.requestId ? { requestId: args.requestId } : {}),
  });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
  if (report.status === "blocked" || report.status === "failed") process.exitCode = 1;
}

function parseArgs(argv: string[]): Args {
  let manifest = "training/plans/parameter-hotload/latest.json";
  let endpointUrl = process.env.MODEL_ADAPTER_SIDECAR_URL || DEFAULT_MODEL_ADAPTER_SIDECAR_URL;
  let apiKey = process.env.MODEL_ADAPTER_SIDECAR_API_KEY || undefined;
  let timeoutMs = parseEnvPositiveInteger(
    process.env.MODEL_ADAPTER_SIDECAR_TIMEOUT_MS || process.env.MODEL_ADAPTER_TIMEOUT_MS,
    30_000,
  );
  let execute = false;
  let rollback = true;
  let requestId: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--manifest") manifest = requireValue(argv[++index], arg);
    else if (arg === "--endpoint-url") endpointUrl = requireValue(argv[++index], arg);
    else if (arg === "--api-key") apiKey = requireValue(argv[++index], arg);
    else if (arg === "--timeout-ms") timeoutMs = parsePositiveInteger(argv[++index], arg);
    else if (arg === "--request-id") requestId = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--execute") execute = true;
    else if (arg === "--dry-run") execute = false;
    else if (arg === "--skip-rollback") rollback = false;
    else if (arg === "--rollback") rollback = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    manifest,
    endpointUrl,
    timeoutMs,
    execute,
    rollback,
    ...(apiKey ? { apiKey } : {}),
    ...(requestId ? { requestId } : {}),
    ...(out ? { out } : {}),
  };
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

function parseEnvPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
