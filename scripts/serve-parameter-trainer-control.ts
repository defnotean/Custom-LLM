import {
  buildParameterTrainerControlServer,
  CommandParameterTrainerBackend,
  InMemoryParameterTrainerControlService,
} from "../src/serving/ParameterTrainerControlServer";

interface Args {
  host: string;
  port: number;
  apiKey?: string;
  backend: "state-only" | "command";
  command?: string;
  commandArgs: string[];
  commandCwd?: string;
  commandTimeoutMs: number;
  requireStagingManifest: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const service = new InMemoryParameterTrainerControlService(
    args.backend === "command"
      ? {
          backend: new CommandParameterTrainerBackend({
            command: requireCommand(args.command),
            args: args.commandArgs,
            ...(args.commandCwd ? { cwd: args.commandCwd } : {}),
            timeoutMs: args.commandTimeoutMs,
            requireStagingManifest: args.requireStagingManifest,
          }),
        }
      : {},
  );
  const app = buildParameterTrainerControlServer({ ...(args.apiKey ? { apiKey: args.apiKey } : {}), service });
  await app.listen({ host: args.host, port: args.port });
  // eslint-disable-next-line no-console
  console.log(`parameter trainer control server listening on http://${args.host}:${args.port} with ${args.backend} backend`);
}

function parseArgs(argv: string[]): Args {
  let host = process.env.PARAMETER_TRAINER_CONTROL_HOST || "127.0.0.1";
  let port = Number(process.env.PARAMETER_TRAINER_CONTROL_PORT || 8090);
  let apiKey = process.env.PARAMETER_TRAINER_API_KEY || undefined;
  let backend = parseBackend(process.env.PARAMETER_TRAINER_BACKEND || "state-only");
  let command = process.env.PARAMETER_TRAINER_COMMAND || undefined;
  const commandArgs = parseArgsJson(process.env.PARAMETER_TRAINER_COMMAND_ARGS_JSON);
  let commandCwd = process.env.PARAMETER_TRAINER_COMMAND_CWD || undefined;
  let commandTimeoutMs = Number(process.env.PARAMETER_TRAINER_COMMAND_TIMEOUT_MS || process.env.PARAMETER_TRAINER_TIMEOUT_MS || 3_600_000);
  let requireStagingManifest = parseBoolean(process.env.PARAMETER_TRAINER_REQUIRE_STAGING_MANIFEST, true);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--host") host = requireValue(argv[++index], arg);
    else if (arg === "--port") port = parsePort(argv[++index], arg);
    else if (arg === "--api-key") apiKey = requireValue(argv[++index], arg);
    else if (arg === "--backend") backend = parseBackend(requireValue(argv[++index], arg));
    else if (arg === "--command") command = requireValue(argv[++index], arg);
    else if (arg === "--arg") commandArgs.push(requireValue(argv[++index], arg));
    else if (arg === "--command-cwd") commandCwd = requireValue(argv[++index], arg);
    else if (arg === "--command-timeout-ms") commandTimeoutMs = parsePositiveInteger(argv[++index], arg);
    else if (arg === "--require-staging-manifest") requireStagingManifest = parseBoolean(requireValue(argv[++index], arg), true);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be 0-65535");
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1) {
    throw new Error("--command-timeout-ms must be a positive integer");
  }
  if (backend === "command" && !command) {
    throw new Error("PARAMETER_TRAINER_COMMAND or --command is required when backend=command");
  }
  return {
    host,
    port,
    ...(apiKey ? { apiKey } : {}),
    backend,
    ...(command ? { command } : {}),
    commandArgs,
    ...(commandCwd ? { commandCwd } : {}),
    commandTimeoutMs,
    requireStagingManifest,
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
  if (value === "state-only" || value === "command") return value;
  throw new Error("--backend must be state-only or command");
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.length === 0) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`invalid boolean value: ${value}`);
}

function parseArgsJson(value: string | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("PARAMETER_TRAINER_COMMAND_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function requireCommand(value: string | undefined): string {
  if (!value) throw new Error("command trainer backend requires PARAMETER_TRAINER_COMMAND or --command");
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
