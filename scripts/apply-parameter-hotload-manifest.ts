import { writeFile } from "node:fs/promises";
import { env } from "../src/config/env";
import {
  HttpParameterModuleHotloadLoader,
  ParameterModuleHotloadService,
} from "../src/learning/ParameterModuleHotloadService";

interface Args {
  manifest: string;
  endpointUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  dryRun: boolean;
  requestId?: string;
  out?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.endpointUrl) {
    throw new Error("PARAMETER_HOTLOAD_ENDPOINT or --endpoint-url is required unless --dry-run is set");
  }
  const loader = args.endpointUrl
    ? new HttpParameterModuleHotloadLoader({
        endpointUrl: args.endpointUrl,
        ...(args.apiKey ? { apiKey: args.apiKey } : {}),
        timeoutMs: args.timeoutMs,
      })
    : undefined;
  const report = await new ParameterModuleHotloadService(loader).apply({
    manifestPath: args.manifest,
    dryRun: args.dryRun,
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
  let endpointUrl = env.PARAMETER_HOTLOAD_ENDPOINT || undefined;
  let apiKey = env.PARAMETER_HOTLOAD_API_KEY || undefined;
  let timeoutMs = env.PARAMETER_HOTLOAD_TIMEOUT_MS;
  let dryRun = false;
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
    else if (arg === "--dry-run") dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    manifest,
    timeoutMs,
    dryRun,
    ...(endpointUrl ? { endpointUrl } : {}),
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

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
