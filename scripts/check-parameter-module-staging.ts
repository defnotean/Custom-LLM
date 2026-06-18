import { writeFile } from "node:fs/promises";
import {
  checkParameterModuleStagingManifest,
  PARAMETER_MODULE_STAGING_EVAL_KINDS,
  type ParameterModuleStagingEvalKind,
  type ParameterModuleStagingGateOptions,
} from "../src/training/parameter/ParameterModuleStagingGate";

interface Args {
  manifest: string;
  out?: string;
  options: ParameterModuleStagingGateOptions;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await checkParameterModuleStagingManifest(args.manifest, args.options);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
  if (report.status !== "pass") process.exitCode = 1;
}

function parseArgs(argv: string[]): Args {
  let manifest = "training/runs/parameter-modules/latest/staging-manifest.json";
  let out: string | undefined;
  const options: ParameterModuleStagingGateOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--manifest") manifest = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--max-parameters") options.maxParameters = parsePositiveInteger(argv[++index], arg);
    else if (arg === "--required-evals") options.requiredEvalKinds = parseEvalKinds(argv[++index], arg);
    else if (arg === "--required-artifacts") options.requiredArtifactKinds = parseList(argv[++index], arg);
    else if (arg === "--no-eval-hash-required") options.requireEvalReportHashes = false;
    else if (arg === "--skip-dataset-file-verification") options.verifyDatasetFiles = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { manifest, ...(out ? { out } : {}), options };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const raw = requireValue(value, flag);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseEvalKinds(value: string | undefined, flag: string): ParameterModuleStagingEvalKind[] {
  const allowed = new Set<string>(PARAMETER_MODULE_STAGING_EVAL_KINDS);
  return parseList(value, flag).map((item) => {
    if (!allowed.has(item)) throw new Error(`${flag} contains unknown eval kind: ${item}`);
    return item as ParameterModuleStagingEvalKind;
  });
}

function parseList(value: string | undefined, flag: string): string[] {
  const parsed = requireValue(value, flag)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (parsed.length === 0) throw new Error(`${flag} must include at least one value`);
  return parsed;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
