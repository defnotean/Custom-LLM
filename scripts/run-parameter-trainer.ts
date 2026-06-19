import { writeFile } from "node:fs/promises";
import type { ParameterModuleKind } from "../src/learning/LiveLearningRegistry";
import {
  parseEvalKind,
  runParameterTrainer,
  type ParameterTrainerRunnerArtifactInput,
  type ParameterTrainerRunnerEvalReportInput,
  type ParameterTrainerRunnerFramework,
  type ParameterTrainerRunnerMode,
} from "../src/training/parameter/ParameterTrainerRunner";

interface Args {
  requestPath: string;
  mode: ParameterTrainerRunnerMode;
  framework: ParameterTrainerRunnerFramework;
  execute: boolean;
  command?: string;
  commandArgs: string[];
  cwd?: string;
  timeoutMs?: number;
  env: Record<string, string>;
  trainingReportPath?: string;
  preflightReportPath?: string;
  artifactDir?: string;
  artifacts: ParameterTrainerRunnerArtifactInput[];
  evalReports: ParameterTrainerRunnerEvalReportInput[];
  moduleKind?: Exclude<ParameterModuleKind, "base_model">;
  parameters?: number;
  activeParameters?: number;
  trainableParameters?: number;
  rollbackTargetId?: string;
  baseModuleId?: string;
  route?: string;
  trainer?: string;
  out?: string;
}

const MODULE_KINDS = ["adapter", "router", "specialist", "expert", "merged_checkpoint", "ensemble_member"] as const;
const RUNNER_MODES = ["plan", "import-artifacts"] as const;
const FRAMEWORKS = ["axolotl", "unsloth", "custom"] as const;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runParameterTrainer({
    requestPath: args.requestPath,
    mode: args.mode,
    framework: args.framework,
    execute: args.execute,
    ...(args.command ? { command: args.command } : {}),
    ...(args.commandArgs.length > 0 ? { commandArgs: args.commandArgs } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    env: args.env,
    ...(args.trainingReportPath ? { trainingReportPath: args.trainingReportPath } : {}),
    ...(args.preflightReportPath ? { preflightReportPath: args.preflightReportPath } : {}),
    ...(args.artifactDir ? { artifactDir: args.artifactDir } : {}),
    artifacts: args.artifacts,
    evalReports: args.evalReports,
    ...(args.moduleKind ? { moduleKind: args.moduleKind } : {}),
    ...(args.parameters !== undefined ? { parameters: args.parameters } : {}),
    ...(args.activeParameters !== undefined ? { activeParameters: args.activeParameters } : {}),
    ...(args.trainableParameters !== undefined ? { trainableParameters: args.trainableParameters } : {}),
    ...(args.rollbackTargetId ? { rollbackTargetId: args.rollbackTargetId } : {}),
    ...(args.baseModuleId ? { baseModuleId: args.baseModuleId } : {}),
    ...(args.route ? { route: args.route } : {}),
    ...(args.trainer ? { trainer: args.trainer } : {}),
  });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
}

function parseArgs(argv: string[]): Args {
  let requestPath = process.env.PARAMETER_TRAINER_REQUEST_PATH ?? "training/runs/parameter-modules/latest/trainer-dispatch-request.json";
  let mode: ParameterTrainerRunnerMode = "plan";
  let framework: ParameterTrainerRunnerFramework = "axolotl";
  let execute = false;
  let command: string | undefined;
  const commandArgs: string[] = [];
  let cwd: string | undefined;
  let timeoutMs: number | undefined;
  const env: Record<string, string> = {};
  let trainingReportPath: string | undefined;
  let preflightReportPath: string | undefined;
  let artifactDir: string | undefined;
  const artifacts: ParameterTrainerRunnerArtifactInput[] = [];
  const evalReports: ParameterTrainerRunnerEvalReportInput[] = [];
  let moduleKind: Exclude<ParameterModuleKind, "base_model"> | undefined;
  let parameters: number | undefined;
  let activeParameters: number | undefined;
  let trainableParameters: number | undefined;
  let rollbackTargetId: string | undefined;
  let baseModuleId: string | undefined;
  let route: string | undefined;
  let trainer: string | undefined;
  let out: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--request") requestPath = requireValue(argv[++index], arg);
    else if (arg === "--mode") mode = parseChoice(requireValue(argv[++index], arg), RUNNER_MODES, arg);
    else if (arg === "--framework") framework = parseChoice(requireValue(argv[++index], arg), FRAMEWORKS, arg);
    else if (arg === "--execute") execute = true;
    else if (arg === "--command") command = requireValue(argv[++index], arg);
    else if (arg === "--arg") commandArgs.push(requireValue(argv[++index], arg));
    else if (arg === "--cwd") cwd = requireValue(argv[++index], arg);
    else if (arg === "--timeout-ms") timeoutMs = parsePositiveInteger(argv[++index], arg);
    else if (arg === "--env") Object.assign(env, parseEnv(requireValue(argv[++index], arg)));
    else if (arg === "--training-report") trainingReportPath = requireValue(argv[++index], arg);
    else if (arg === "--preflight-report") preflightReportPath = requireValue(argv[++index], arg);
    else if (arg === "--artifact-dir") artifactDir = requireValue(argv[++index], arg);
    else if (arg === "--artifact") artifacts.push(parseArtifact(requireValue(argv[++index], arg)));
    else if (arg === "--eval-report") evalReports.push(parseEvalReport(requireValue(argv[++index], arg)));
    else if (arg === "--module-kind") moduleKind = parseChoice(requireValue(argv[++index], arg), MODULE_KINDS, arg);
    else if (arg === "--parameters") parameters = parseNonNegativeInteger(argv[++index], arg);
    else if (arg === "--active-parameters") activeParameters = parseNonNegativeInteger(argv[++index], arg);
    else if (arg === "--trainable-parameters") trainableParameters = parseNonNegativeInteger(argv[++index], arg);
    else if (arg === "--rollback-target-id") rollbackTargetId = requireValue(argv[++index], arg);
    else if (arg === "--base-module-id") baseModuleId = requireValue(argv[++index], arg);
    else if (arg === "--route") route = requireValue(argv[++index], arg);
    else if (arg === "--trainer") trainer = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    requestPath,
    mode,
    framework,
    execute,
    commandArgs,
    env,
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(trainingReportPath ? { trainingReportPath } : {}),
    ...(preflightReportPath ? { preflightReportPath } : {}),
    artifacts,
    evalReports,
    ...(artifactDir ? { artifactDir } : {}),
    ...(moduleKind ? { moduleKind } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
    ...(activeParameters !== undefined ? { activeParameters } : {}),
    ...(trainableParameters !== undefined ? { trainableParameters } : {}),
    ...(rollbackTargetId ? { rollbackTargetId } : {}),
    ...(baseModuleId ? { baseModuleId } : {}),
    ...(route ? { route } : {}),
    ...(trainer ? { trainer } : {}),
    ...(out ? { out } : {}),
  };
}

function parseArtifact(value: string): ParameterTrainerRunnerArtifactInput {
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error("--artifact must be kind=path");
  return {
    kind: value.slice(0, separator),
    path: value.slice(separator + 1),
  };
}

function parseEvalReport(value: string): ParameterTrainerRunnerEvalReportInput {
  const fields = parseKeyValueList(value);
  const kind = parseEvalKind(requireField(fields, "kind", "--eval-report"));
  const path = requireField(fields, "path", "--eval-report");
  const status = parseEvalStatus(fields.status ?? "pass");
  return {
    kind,
    path,
    status,
    ...(fields.summary ? { summary: fields.summary } : {}),
  };
}

function parseEnv(value: string): Record<string, string> {
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error("--env must be NAME=value");
  return { [value.slice(0, separator)]: value.slice(separator + 1) };
}

function parseKeyValueList(value: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) throw new Error(`expected key=value in ${value}`);
    fields[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return fields;
}

function parseEvalStatus(value: string): "pass" | "fail" | "warn" {
  if (value === "pass" || value === "fail" || value === "warn") return value;
  throw new Error(`invalid eval report status: ${value}`);
}

function requireField(fields: Record<string, string>, name: string, flag: string): string {
  const value = fields[name];
  if (!value) throw new Error(`${flag} requires ${name}=...`);
  return value;
}

function parseChoice<T extends readonly string[]>(value: string, choices: T, flag: string): T[number] {
  if ((choices as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`${flag} must be one of: ${choices.join(", ")}`);
}

function parseNonNegativeInteger(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
