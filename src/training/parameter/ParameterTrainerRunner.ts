import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { ParameterModuleKind } from "../../learning/LiveLearningRegistry";
import {
  PARAMETER_MODULE_STAGING_EVAL_KINDS,
  type ParameterModuleStagingEvalKind,
  type ParameterModuleStagingManifest,
} from "./ParameterModuleStagingGate";
import { checkParameterGrowthDatasetQuality } from "./ParameterGrowthDatasetQuality";
import {
  parameterTrainerDispatchRequestSchema,
  type ParameterTrainerDatasetManifest,
  type ParameterTrainerDispatchRequest,
} from "./ParameterTrainerDispatchService";

export type ParameterTrainerRunnerMode = "plan" | "execute-training" | "import-artifacts";
export type ParameterTrainerRunnerFramework = "axolotl" | "unsloth" | "custom";

export interface ParameterTrainerRunnerArtifactInput {
  kind: string;
  path: string;
}

export interface ParameterTrainerRunnerEvalReportInput {
  kind: ParameterModuleStagingEvalKind;
  path: string;
  status: "pass" | "fail" | "warn";
  summary?: string;
}

export interface ParameterTrainerRunnerOptions {
  requestPath: string;
  mode?: ParameterTrainerRunnerMode;
  framework?: ParameterTrainerRunnerFramework;
  execute?: boolean;
  command?: string;
  commandArgs?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  trainingReportPath?: string;
  artifactDir?: string;
  artifacts?: ParameterTrainerRunnerArtifactInput[];
  evalReports?: ParameterTrainerRunnerEvalReportInput[];
  moduleKind?: Exclude<ParameterModuleKind, "base_model">;
  parameters?: number;
  activeParameters?: number;
  trainableParameters?: number;
  rollbackTargetId?: string;
  baseModuleId?: string;
  route?: string;
  trainer?: string;
  now?: () => string;
}

export interface ParameterTrainerRunnerReport {
  status: "planned" | "training_dry_run" | "trained" | "staged";
  generatedAt: string;
  mode: ParameterTrainerRunnerMode;
  framework: ParameterTrainerRunnerFramework;
  requestId: string;
  trainerProfile: string;
  planPath: string;
  trainingCommand?: ParameterTrainerRunnerCommandReport;
  trainingReportPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  exitCode?: number | null;
  stagingManifestPath?: string;
  moduleName?: string;
  moduleKind?: ParameterModuleKind;
  artifacts?: Array<{ kind: string; path: string; bytes: number; sha256: string }>;
  evalReports?: Array<{ kind: string; path: string; status: string; bytes: number; sha256: string }>;
}

const DEFAULT_FRAMEWORK: ParameterTrainerRunnerFramework = "axolotl";
const ARCHITECTURE_TARGET = "subquadratic-sparse-attention";
const DEFAULT_TRAINING_TIMEOUT_MS = 6 * 60 * 60 * 1000;

interface ParameterTrainerRunnerCommandSpec {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
}

interface ParameterTrainerRunnerCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
}

export interface ParameterTrainerRunnerCommandReport {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  envKeys: string[];
}

export async function runParameterTrainer(options: ParameterTrainerRunnerOptions): Promise<ParameterTrainerRunnerReport> {
  const mode = options.mode ?? "plan";
  const framework = options.framework ?? DEFAULT_FRAMEWORK;
  const generatedAt = options.now?.() ?? new Date().toISOString();
  const request = await readDispatchRequest(options.requestPath);
  await mkdir(request.expectedOutput.runDir, { recursive: true });
  const qualityReport = await checkParameterGrowthDatasetQuality(request.datasetManifestPath);
  if (qualityReport.status !== "pass") {
    throw new Error("parameter trainer runner refused a dispatch with failing dataset quality");
  }

  const planPath = join(request.expectedOutput.runDir, "parameter-trainer-runner-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify(buildRunnerPlan({ request, requestPath: options.requestPath, framework, mode, generatedAt }), null, 2)}\n`,
    "utf8",
  );

  if (mode === "plan") {
    return {
      status: "planned",
      generatedAt,
      mode,
      framework,
      requestId: request.requestId,
      trainerProfile: request.trainerProfile,
      planPath,
    };
  }

  if (mode === "execute-training") {
    const command = buildTrainingCommand({
      request,
      requestPath: options.requestPath,
      options,
      framework,
    });
    const trainingReportPath = options.trainingReportPath ?? join(request.expectedOutput.runDir, "trainer-execution-report.json");
    if (!options.execute) {
      await writeFile(
        trainingReportPath,
        `${JSON.stringify(buildTrainingExecutionPlan({ request, command, framework, generatedAt }), null, 2)}\n`,
        "utf8",
      );
      return {
        status: "training_dry_run",
        generatedAt,
        mode,
        framework,
        requestId: request.requestId,
        trainerProfile: request.trainerProfile,
        planPath,
        trainingCommand: commandReport(command),
        trainingReportPath,
      };
    }

    const result = await executeTrainingCommand(command, request.expectedOutput.runDir);
    await writeFile(
      trainingReportPath,
      `${JSON.stringify(buildTrainingExecutionReport({ request, command, result, framework, generatedAt }), null, 2)}\n`,
      "utf8",
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`parameter trainer command failed; see ${trainingReportPath}`);
    }
    return {
      status: "trained",
      generatedAt,
      mode,
      framework,
      requestId: request.requestId,
      trainerProfile: request.trainerProfile,
      planPath,
      trainingCommand: commandReport(command),
      trainingReportPath,
      stdoutPath: result.stdoutPath,
      stderrPath: result.stderrPath,
      exitCode: result.exitCode,
    };
  }

  const manifest = await buildStagingManifest({
    request,
    options,
    framework,
    generatedAt,
  });
  await writeFile(request.expectedOutput.stagingManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    status: "staged",
    generatedAt,
    mode,
    framework,
    requestId: request.requestId,
    trainerProfile: request.trainerProfile,
    planPath,
    stagingManifestPath: request.expectedOutput.stagingManifestPath,
    moduleName: manifest.moduleName,
    moduleKind: manifest.kind,
    artifacts: manifest.artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: artifact.path,
      bytes: artifact.bytes ?? 0,
      sha256: artifact.sha256,
    })),
    evalReports: manifest.evalReports
      .filter((report): report is typeof report & { sha256: string; bytes: number } => Boolean(report.sha256 && report.bytes))
      .map((report) => ({
        kind: report.kind,
        path: report.path,
        status: report.status,
        bytes: report.bytes,
        sha256: report.sha256,
      })),
  };
}

async function readDispatchRequest(path: string): Promise<ParameterTrainerDispatchRequest> {
  return parameterTrainerDispatchRequestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function buildRunnerPlan(input: {
  request: ParameterTrainerDispatchRequest;
  requestPath: string;
  framework: ParameterTrainerRunnerFramework;
  mode: ParameterTrainerRunnerMode;
  generatedAt: string;
}): Record<string, unknown> {
  return {
    runtimeContract: "parameter-trainer-runner-plan-v1",
    generatedAt: input.generatedAt,
    mode: input.mode,
    framework: input.framework,
    requestPath: input.requestPath,
    requestId: input.request.requestId,
    trainerProfile: input.request.trainerProfile,
    datasetManifestPath: input.request.datasetManifestPath,
    runDir: input.request.expectedOutput.runDir,
    stagingManifestPath: input.request.expectedOutput.stagingManifestPath,
    suggestedCommands: suggestedCommands(input.framework, input.request),
    architecture: {
      target: ARCHITECTURE_TARGET,
      requiredGate: "npm run check:subq-architecture",
      longContextProvider: "subq",
      sparseAttentionSmoke: "training/train_tiny_transformer_lm.py --attention-mode local-log-sparse",
      note:
        "Long-context growth must stay compatible with the SubQ/SSA path. Dense-only runs are acceptable only for narrow non-long-context adapters/specialists.",
    },
    note:
      "Plan mode does not train or write a staging manifest. Use import-artifacts mode after a trusted trainer has produced artifacts and eval reports.",
  };
}

function suggestedCommands(
  framework: ParameterTrainerRunnerFramework,
  request: ParameterTrainerDispatchRequest,
): string[] {
  if (framework === "axolotl") {
    return [
      "npm run check:subq-architecture",
      "npm run check:production-readiness",
      `npm run run:parameter-trainer -- --request ${request.expectedOutput.runDir}/trainer-dispatch-request.json --mode execute-training --framework axolotl`,
      "axolotl train training/configs/axolotl/qwen3-qlora-sft.yaml",
      `npm run run:parameter-trainer -- --request ${request.expectedOutput.runDir}/trainer-dispatch-request.json --mode import-artifacts --framework axolotl --artifact-dir training/runs/qwen3-qlora-sft --rollback-target-id <module-id> ...`,
    ];
  }
  if (framework === "unsloth") {
    return [
      "npm run check:subq-architecture",
      "npm run check:production-readiness",
      `npm run run:parameter-trainer -- --request ${request.expectedOutput.runDir}/trainer-dispatch-request.json --mode execute-training --framework unsloth`,
      "python training/configs/unsloth/qwen3_qlora_sft.py",
      `npm run run:parameter-trainer -- --request ${request.expectedOutput.runDir}/trainer-dispatch-request.json --mode import-artifacts --framework unsloth --artifact-dir training/runs/unsloth-qwen3-qlora-sft --rollback-target-id <module-id> ...`,
    ];
  }
  return ["Run the configured private trainer, then re-run this script in import-artifacts mode."];
}

function buildTrainingCommand(input: {
  request: ParameterTrainerDispatchRequest;
  requestPath: string;
  options: ParameterTrainerRunnerOptions;
  framework: ParameterTrainerRunnerFramework;
}): ParameterTrainerRunnerCommandSpec {
  const defaults = defaultTrainingCommand(input.framework);
  const command = input.options.command ?? defaults?.command;
  if (!command) throw new Error("--command is required for custom execute-training runs");
  const args = input.options.commandArgs ?? defaults?.args ?? [];
  return {
    command,
    args,
    cwd: input.options.cwd ?? process.cwd(),
    timeoutMs: input.options.timeoutMs ?? DEFAULT_TRAINING_TIMEOUT_MS,
    env: {
      PARAMETER_TRAINER_REQUEST_PATH: input.requestPath,
      PARAMETER_TRAINER_REQUEST_ID: input.request.requestId,
      PARAMETER_TRAINER_PROFILE: input.request.trainerProfile,
      PARAMETER_TRAINER_DATASET_MANIFEST_PATH: input.request.datasetManifestPath,
      PARAMETER_TRAINER_RUN_DIR: input.request.expectedOutput.runDir,
      PARAMETER_TRAINER_STAGING_MANIFEST_PATH: input.request.expectedOutput.stagingManifestPath,
      PARAMETER_TRAINER_FRAMEWORK: input.framework,
      PARAMETER_TRAINER_ARCHITECTURE_TARGET: ARCHITECTURE_TARGET,
      ...(input.options.env ?? {}),
    },
  };
}

function defaultTrainingCommand(
  framework: ParameterTrainerRunnerFramework,
): { command: string; args: string[] } | undefined {
  if (framework === "axolotl") return { command: "axolotl", args: ["train", "training/configs/axolotl/qwen3-qlora-sft.yaml"] };
  if (framework === "unsloth") return { command: "python", args: ["training/configs/unsloth/qwen3_qlora_sft.py"] };
  return undefined;
}

function buildTrainingExecutionPlan(input: {
  request: ParameterTrainerDispatchRequest;
  command: ParameterTrainerRunnerCommandSpec;
  framework: ParameterTrainerRunnerFramework;
  generatedAt: string;
}): Record<string, unknown> {
  return {
    runtimeContract: "parameter-trainer-execution-plan-v1",
    status: "dry_run",
    generatedAt: input.generatedAt,
    requestId: input.request.requestId,
    trainerProfile: input.request.trainerProfile,
    datasetManifestPath: input.request.datasetManifestPath,
    runDir: input.request.expectedOutput.runDir,
    stagingManifestPath: input.request.expectedOutput.stagingManifestPath,
    framework: input.framework,
    architectureTarget: ARCHITECTURE_TARGET,
    command: commandReport(input.command),
    note: "Dry run only. Re-run with --execute after preflight gates pass to launch training.",
  };
}

function buildTrainingExecutionReport(input: {
  request: ParameterTrainerDispatchRequest;
  command: ParameterTrainerRunnerCommandSpec;
  result: ParameterTrainerRunnerCommandResult;
  framework: ParameterTrainerRunnerFramework;
  generatedAt: string;
}): Record<string, unknown> {
  return {
    runtimeContract: "parameter-trainer-execution-report-v1",
    status: input.result.timedOut || input.result.exitCode !== 0 ? "fail" : "pass",
    generatedAt: input.generatedAt,
    requestId: input.request.requestId,
    trainerProfile: input.request.trainerProfile,
    datasetManifestPath: input.request.datasetManifestPath,
    runDir: input.request.expectedOutput.runDir,
    stagingManifestPath: input.request.expectedOutput.stagingManifestPath,
    framework: input.framework,
    architectureTarget: ARCHITECTURE_TARGET,
    command: commandReport(input.command),
    result: {
      exitCode: input.result.exitCode,
      signal: input.result.signal,
      timedOut: input.result.timedOut,
      durationMs: input.result.durationMs,
      stdoutPath: input.result.stdoutPath,
      stderrPath: input.result.stderrPath,
    },
  };
}

async function executeTrainingCommand(
  command: ParameterTrainerRunnerCommandSpec,
  runDir: string,
): Promise<ParameterTrainerRunnerCommandResult> {
  await mkdir(runDir, { recursive: true });
  const stdoutPath = join(runDir, "trainer-stdout.log");
  const stderrPath = join(runDir, "trainer-stderr.log");
  const startedAt = Date.now();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...command.env };

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: childEnv,
      shell: false,
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, command.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      void Promise.all([
        writeFile(stdoutPath, stdout, "utf8"),
        writeFile(stderrPath, stderr, "utf8"),
      ])
        .then(() =>
          resolve({
            exitCode,
            signal,
            timedOut,
            stdout,
            stderr,
            durationMs,
            stdoutPath,
            stderrPath,
          }),
        )
        .catch(reject);
    });
  });
}

function commandReport(command: ParameterTrainerRunnerCommandSpec): ParameterTrainerRunnerCommandReport {
  return {
    command: command.command,
    args: command.args,
    cwd: command.cwd,
    timeoutMs: command.timeoutMs,
    envKeys: Object.keys(command.env).sort(),
  };
}

async function buildStagingManifest(input: {
  request: ParameterTrainerDispatchRequest;
  options: ParameterTrainerRunnerOptions;
  framework: ParameterTrainerRunnerFramework;
  generatedAt: string;
}): Promise<ParameterModuleStagingManifest> {
  const { request, options } = input;
  const firstBatch = request.datasetManifest.batches[0];
  if (!firstBatch) throw new Error("dataset manifest has no batches to stage");
  const kind = options.moduleKind ?? firstBatch.targetKind;
  const moduleName = firstBatch.moduleName;
  const route = options.route ?? firstBatch.route;
  const parameters = requirePositiveInteger(options.parameters, "--parameters");
  const activeParameters = requirePositiveInteger(options.activeParameters, "--active-parameters");
  const trainableParameters = requireNonNegativeInteger(options.trainableParameters, "--trainable-parameters");
  if (!options.rollbackTargetId) throw new Error("--rollback-target-id is required in import-artifacts mode");

  const artifacts = await buildArtifactEvidence({
    kind,
    artifactDir: options.artifactDir,
    artifacts: options.artifacts ?? [],
  });
  if (artifacts.length === 0) throw new Error("import-artifacts mode requires artifacts or --artifact-dir");

  const evalReports = await Promise.all(
    (options.evalReports ?? []).map(async (report) => ({
      ...report,
      ...(await fileInfo(report.path)),
    })),
  );
  if (evalReports.length === 0) throw new Error("import-artifacts mode requires at least one --eval-report");

  const datasetManifestInfo = await fileInfo(request.datasetManifestPath);
  const sourceLearningItemIds = await collectSourceLearningItemIds(request.datasetManifest);
  return {
    moduleName,
    kind,
    parameters,
    activeParameters,
    trainableParameters,
    ...(options.baseModuleId ? { baseModuleId: options.baseModuleId } : {}),
    ...(route ? { route } : {}),
    datasetManifestPath: request.datasetManifestPath,
    datasetManifestSha256: datasetManifestInfo.sha256,
    sourceLearningItemIds,
    datasetHashes: unique([datasetManifestInfo.sha256, ...request.datasetManifest.files.map((file) => file.sha256)]),
    artifacts,
    evalReports,
    rollbackTargetId: options.rollbackTargetId,
    trainedAt: input.generatedAt,
    trainer: options.trainer ?? `parameter-trainer-runner:${input.framework}`,
    metadata: {
      requestId: request.requestId,
      trainerProfile: request.trainerProfile,
      framework: input.framework,
      mode: "import-artifacts",
      architectureTarget: ARCHITECTURE_TARGET,
      requiredArchitectureGate: "check:subq-architecture",
    },
  };
}

async function buildArtifactEvidence(input: {
  kind: Exclude<ParameterModuleKind, "base_model">;
  artifactDir?: string;
  artifacts: ParameterTrainerRunnerArtifactInput[];
}): Promise<Array<{ kind: string; path: string; bytes: number; sha256: string }>> {
  const artifacts = [...input.artifacts];
  if (input.artifactDir) {
    artifacts.push(...(await detectArtifacts(input.artifactDir, input.kind)));
  }
  const deduped = uniqueBy(artifacts, (artifact) => `${artifact.kind}:${artifact.path}`);
  return Promise.all(deduped.map(async (artifact) => ({ ...artifact, ...(await fileInfo(artifact.path)) })));
}

async function detectArtifacts(
  artifactDir: string,
  kind: Exclude<ParameterModuleKind, "base_model">,
): Promise<ParameterTrainerRunnerArtifactInput[]> {
  const names = new Set(await readdir(artifactDir));
  const config = firstExisting(names, ["adapter_config.json", "config.json", "trainer_config.json"]);
  const adapter = firstExisting(names, ["adapter_model.safetensors", "adapter_model.bin", "adapter.safetensors"]);
  const checkpoint = firstExisting(names, ["model.safetensors", "pytorch_model.bin", "checkpoint.safetensors"]);
  const artifacts: ParameterTrainerRunnerArtifactInput[] = [];
  if (kind === "adapter" && adapter) artifacts.push({ kind: "adapter", path: join(artifactDir, adapter) });
  else if (checkpoint) artifacts.push({ kind: "checkpoint", path: join(artifactDir, checkpoint) });
  else if (adapter) artifacts.push({ kind: "adapter", path: join(artifactDir, adapter) });
  if (config) artifacts.push({ kind: "config", path: join(artifactDir, config) });
  return artifacts;
}

async function collectSourceLearningItemIds(manifest: ParameterTrainerDatasetManifest): Promise<string[]> {
  const ids: string[] = [];
  for (const file of manifest.files) {
    const body = await readFile(file.path, "utf8");
    for (const line of body.split(/\r?\n/).filter(Boolean)) {
      const parsed = JSON.parse(line) as { itemId?: unknown };
      if (typeof parsed.itemId === "string" && parsed.itemId.length > 0) ids.push(parsed.itemId);
    }
  }
  return unique(ids);
}

async function fileInfo(path: string): Promise<{ bytes: number; sha256: string }> {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`expected a non-empty file: ${path}`);
  const body = await readFile(path);
  return {
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function requirePositiveInteger(value: number | undefined, flag: string): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) throw new Error(`${flag} is required and must be positive`);
  return value;
}

function requireNonNegativeInteger(value: number | undefined, flag: string): number {
  if (!Number.isInteger(value) || value === undefined || value < 0) throw new Error(`${flag} is required and must be non-negative`);
  return value;
}

function firstExisting(names: Set<string>, candidates: string[]): string | undefined {
  return candidates.find((candidate) => names.has(candidate));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(value);
  }
  return result;
}

export function resolveRunnerPath(path: string, baseDir = process.cwd()): string {
  return isAbsolute(path) ? path : join(baseDir, path);
}

export function parseEvalKind(value: string): ParameterModuleStagingEvalKind {
  if ((PARAMETER_MODULE_STAGING_EVAL_KINDS as readonly string[]).includes(value)) {
    return value as ParameterModuleStagingEvalKind;
  }
  throw new Error(`unknown eval report kind: ${value}`);
}

export function artifactBasename(path: string): string {
  return basename(path);
}
