import {
  buildParameterHotloadControlServer,
  HttpParameterHotloadBackend,
  InMemoryParameterHotloadControlService,
} from "../src/serving/ParameterHotloadControlServer";

interface Args {
  host: string;
  port: number;
  apiKey?: string;
  backend: "state-only" | "http";
  backendUrl?: string;
  backendApiKey?: string;
  backendTimeoutMs: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const service = new InMemoryParameterHotloadControlService(
    args.backend === "http"
      ? {
          backend: new HttpParameterHotloadBackend({
            endpointUrl: requireBackendUrl(args.backendUrl),
            ...(args.backendApiKey ? { apiKey: args.backendApiKey } : {}),
            timeoutMs: args.backendTimeoutMs,
          }),
        }
      : {},
  );
  const app = buildParameterHotloadControlServer({ ...(args.apiKey ? { apiKey: args.apiKey } : {}), service });
  await app.listen({ host: args.host, port: args.port });
  // eslint-disable-next-line no-console
  console.log(
    `parameter hotload control server listening on http://${args.host}:${args.port} with ${args.backend} backend`,
  );
}

function parseArgs(argv: string[]): Args {
  let host = process.env.PARAMETER_HOTLOAD_CONTROL_HOST || "127.0.0.1";
  let port = Number(process.env.PARAMETER_HOTLOAD_CONTROL_PORT || 8088);
  let apiKey = process.env.PARAMETER_HOTLOAD_API_KEY || undefined;
  let backend = parseBackend(process.env.PARAMETER_HOTLOAD_BACKEND || "state-only");
  let backendUrl = process.env.PARAMETER_HOTLOAD_BACKEND_URL || undefined;
  let backendApiKey = process.env.PARAMETER_HOTLOAD_BACKEND_API_KEY || undefined;
  let backendTimeoutMs = Number(process.env.PARAMETER_HOTLOAD_BACKEND_TIMEOUT_MS || process.env.PARAMETER_HOTLOAD_TIMEOUT_MS || 30_000);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--host") host = requireValue(argv[++index], arg);
    else if (arg === "--port") port = parsePort(argv[++index], arg);
    else if (arg === "--api-key") apiKey = requireValue(argv[++index], arg);
    else if (arg === "--backend") backend = parseBackend(requireValue(argv[++index], arg));
    else if (arg === "--backend-url") backendUrl = requireValue(argv[++index], arg);
    else if (arg === "--backend-api-key") backendApiKey = requireValue(argv[++index], arg);
    else if (arg === "--backend-timeout-ms") backendTimeoutMs = parsePositiveInteger(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be 0-65535");
  if (!Number.isInteger(backendTimeoutMs) || backendTimeoutMs < 1) {
    throw new Error("--backend-timeout-ms must be a positive integer");
  }
  if (backend === "http" && !backendUrl) {
    throw new Error("PARAMETER_HOTLOAD_BACKEND_URL or --backend-url is required when backend=http");
  }
  return {
    host,
    port,
    ...(apiKey ? { apiKey } : {}),
    backend,
    ...(backendUrl ? { backendUrl } : {}),
    ...(backendApiKey ? { backendApiKey } : {}),
    backendTimeoutMs,
  };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePort(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`${flag} must be 0-65535`);
  return parsed;
}

function parseBackend(value: string): Args["backend"] {
  if (value === "state-only" || value === "http") return value;
  throw new Error("--backend must be state-only or http");
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function requireBackendUrl(value: string | undefined): string {
  if (!value) throw new Error("backend=http requires PARAMETER_HOTLOAD_BACKEND_URL or --backend-url");
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
