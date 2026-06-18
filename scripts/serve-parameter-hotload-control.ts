import { buildParameterHotloadControlServer } from "../src/serving/ParameterHotloadControlServer";

interface Args {
  host: string;
  port: number;
  apiKey?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const app = buildParameterHotloadControlServer({ ...(args.apiKey ? { apiKey: args.apiKey } : {}) });
  await app.listen({ host: args.host, port: args.port });
  // eslint-disable-next-line no-console
  console.log(`parameter hotload control server listening on http://${args.host}:${args.port}`);
}

function parseArgs(argv: string[]): Args {
  let host = process.env.PARAMETER_HOTLOAD_CONTROL_HOST || "127.0.0.1";
  let port = Number(process.env.PARAMETER_HOTLOAD_CONTROL_PORT || 8088);
  let apiKey = process.env.PARAMETER_HOTLOAD_API_KEY || undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--host") host = requireValue(argv[++index], arg);
    else if (arg === "--port") port = parsePort(argv[++index], arg);
    else if (arg === "--api-key") apiKey = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be 0-65535");
  return { host, port, ...(apiKey ? { apiKey } : {}) };
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

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
