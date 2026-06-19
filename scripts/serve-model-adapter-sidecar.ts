import {
  buildModelAdapterSidecarServer,
  ModelAdapterSidecarService,
  OllamaModelAdapterProvider,
  VllmModelAdapterProvider,
  type ModelAdapterProviderKind,
} from "../src/serving/ModelAdapterSidecarServer";

interface Args {
  host: string;
  port: number;
  apiKey?: string;
  provider: ModelAdapterProviderKind;
  modelServerBaseUrl: string;
  modelServerApiKey?: string;
  timeoutMs: number;
  baseModel?: string;
  adapterNamePrefix: string;
  vllmLoadInPlace: boolean;
  ollamaModelNamePrefix: string;
  ollamaDeleteOnRollback: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider =
    args.provider === "vllm"
      ? new VllmModelAdapterProvider({
          baseUrl: args.modelServerBaseUrl,
          ...(args.modelServerApiKey ? { apiKey: args.modelServerApiKey } : {}),
          timeoutMs: args.timeoutMs,
          loadInPlace: args.vllmLoadInPlace,
        })
      : new OllamaModelAdapterProvider({
          baseUrl: args.modelServerBaseUrl,
          baseModel: requireBaseModel(args.baseModel),
          ...(args.modelServerApiKey ? { apiKey: args.modelServerApiKey } : {}),
          timeoutMs: args.timeoutMs,
          modelNamePrefix: args.ollamaModelNamePrefix,
          deleteOnRollback: args.ollamaDeleteOnRollback,
        });
  const service = new ModelAdapterSidecarService({ provider, adapterNamePrefix: args.adapterNamePrefix });
  const app = buildModelAdapterSidecarServer({ ...(args.apiKey ? { apiKey: args.apiKey } : {}), service });
  await app.listen({ host: args.host, port: args.port });
  // eslint-disable-next-line no-console
  console.log(
    `model adapter sidecar listening on http://${args.host}:${args.port}/parameter-modules with ${args.provider} provider`,
  );
}

function parseArgs(argv: string[]): Args {
  let host = process.env.MODEL_ADAPTER_SIDECAR_HOST || "127.0.0.1";
  let port = Number(process.env.MODEL_ADAPTER_SIDECAR_PORT || 9099);
  let apiKey = process.env.MODEL_ADAPTER_SIDECAR_API_KEY || undefined;
  let provider = parseProvider(process.env.MODEL_ADAPTER_PROVIDER || "vllm");
  let modelServerBaseUrl = process.env.MODEL_ADAPTER_SERVER_BASE_URL || defaultBaseUrl(provider);
  let modelServerApiKey = process.env.MODEL_ADAPTER_SERVER_API_KEY || undefined;
  let timeoutMs = Number(process.env.MODEL_ADAPTER_TIMEOUT_MS || 30_000);
  let baseModel = process.env.MODEL_ADAPTER_BASE_MODEL || undefined;
  let adapterNamePrefix = process.env.MODEL_ADAPTER_NAME_PREFIX || "";
  let vllmLoadInPlace = parseBoolean(process.env.MODEL_ADAPTER_VLLM_LOAD_IN_PLACE, true);
  let ollamaModelNamePrefix = process.env.MODEL_ADAPTER_OLLAMA_MODEL_PREFIX || "irene-";
  let ollamaDeleteOnRollback = parseBoolean(process.env.MODEL_ADAPTER_OLLAMA_DELETE_ON_ROLLBACK, false);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--host") host = requireValue(argv[++index], arg);
    else if (arg === "--port") port = parsePort(argv[++index], arg);
    else if (arg === "--api-key") apiKey = requireValue(argv[++index], arg);
    else if (arg === "--provider") {
      provider = parseProvider(requireValue(argv[++index], arg));
      if (!process.env.MODEL_ADAPTER_SERVER_BASE_URL) modelServerBaseUrl = defaultBaseUrl(provider);
    } else if (arg === "--model-server-base-url") modelServerBaseUrl = requireValue(argv[++index], arg);
    else if (arg === "--model-server-api-key") modelServerApiKey = requireValue(argv[++index], arg);
    else if (arg === "--timeout-ms") timeoutMs = parsePositiveInteger(argv[++index], arg);
    else if (arg === "--base-model") baseModel = requireValue(argv[++index], arg);
    else if (arg === "--adapter-name-prefix") adapterNamePrefix = requireValue(argv[++index], arg);
    else if (arg === "--vllm-load-in-place") vllmLoadInPlace = parseBoolean(requireValue(argv[++index], arg), true);
    else if (arg === "--ollama-model-name-prefix") ollamaModelNamePrefix = requireValue(argv[++index], arg);
    else if (arg === "--ollama-delete-on-rollback") ollamaDeleteOnRollback = parseBoolean(requireValue(argv[++index], arg), false);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be 0-65535");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive integer");
  if (provider === "ollama" && !baseModel) {
    throw new Error("MODEL_ADAPTER_BASE_MODEL or --base-model is required when --provider ollama");
  }
  return {
    host,
    port,
    ...(apiKey ? { apiKey } : {}),
    provider,
    modelServerBaseUrl,
    ...(modelServerApiKey ? { modelServerApiKey } : {}),
    timeoutMs,
    ...(baseModel ? { baseModel } : {}),
    adapterNamePrefix,
    vllmLoadInPlace,
    ollamaModelNamePrefix,
    ollamaDeleteOnRollback,
  };
}

function parseProvider(value: string): ModelAdapterProviderKind {
  if (value === "vllm" || value === "ollama") return value;
  throw new Error("--provider must be vllm or ollama");
}

function defaultBaseUrl(provider: ModelAdapterProviderKind): string {
  return provider === "vllm" ? "http://127.0.0.1:8000" : "http://127.0.0.1:11434";
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function requireBaseModel(value: string | undefined): string {
  if (!value) throw new Error("base model is required for the Ollama adapter sidecar provider");
  return value;
}

function parsePort(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`${flag} must be 0-65535`);
  return parsed;
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

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
