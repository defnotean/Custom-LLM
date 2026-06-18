import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ParameterModuleKind } from "../../learning/LiveLearningRegistry";

export const PARAMETER_MODULE_STAGING_EVAL_KINDS = [
  "protocol",
  "knowledge",
  "behavior",
  "router",
  "memory",
  "skill",
  "voice",
  "composite",
  "parameter_growth",
  "training_report",
  "dataset_quality",
  "contamination",
] as const;

export type ParameterModuleStagingEvalKind = (typeof PARAMETER_MODULE_STAGING_EVAL_KINDS)[number];
export type ParameterModuleStagingStatus = "pass" | "fail";

export interface ParameterModuleStagingGateOptions {
  maxParameters?: number;
  requiredEvalKinds?: ParameterModuleStagingEvalKind[];
  requiredArtifactKinds?: string[];
  requireEvalReportHashes?: boolean;
  verifyDatasetFiles?: boolean;
  now?: () => string;
}

export interface ParameterModuleStagingCheck {
  id: string;
  status: ParameterModuleStagingStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ParameterModuleStagingGateReport {
  status: ParameterModuleStagingStatus;
  manifestPath: string;
  generatedAt: string;
  summary: {
    moduleName: string;
    kind: ParameterModuleKind;
    route?: string;
    parameters: number;
    activeParameters: number;
    trainableParameters: number;
    artifacts: number;
    evalReports: number;
    sourceLearningItems: number;
    requiredEvalKinds: ParameterModuleStagingEvalKind[];
    requiredArtifactKinds: string[];
    datasetManifestPath: string;
  };
  checks: ParameterModuleStagingCheck[];
}

export const DEFAULT_PARAMETER_MODULE_STAGING_MAX_PARAMETERS = 25_000_000;

const parameterModuleKinds = [
  "base_model",
  "adapter",
  "router",
  "specialist",
  "expert",
  "merged_checkpoint",
  "ensemble_member",
] as const satisfies readonly ParameterModuleKind[];

const hashedFileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().positive().optional(),
  sha256: z.string().length(64),
});

const stagingManifestSchema = z.object({
  moduleName: z.string().min(1),
  kind: z.enum(parameterModuleKinds),
  parameters: z.number().int().positive(),
  activeParameters: z.number().int().positive(),
  trainableParameters: z.number().int().nonnegative(),
  baseModuleId: z.string().min(1).optional(),
  route: z.string().min(1).optional(),
  datasetManifestPath: z.string().min(1),
  datasetManifestSha256: z.string().length(64),
  sourceLearningItemIds: z.array(z.string().min(1)),
  datasetHashes: z.array(z.string().length(64)),
  artifacts: z.array(
    hashedFileSchema.extend({
      kind: z.string().min(1),
    }),
  ),
  evalReports: z.array(
    hashedFileSchema
      .extend({
        kind: z.enum(PARAMETER_MODULE_STAGING_EVAL_KINDS),
        status: z.enum(["pass", "fail", "warn"]),
        summary: z.string().optional(),
      })
      .partial({ sha256: true }),
  ),
  rollbackTargetId: z.string().min(1).optional(),
  trainedAt: z.string().min(1),
  trainer: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const datasetManifestSchema = z.object({
  id: z.string().min(1),
  files: z.array(
    z.object({
      batchId: z.string().min(1),
      path: z.string().min(1),
      lines: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().length(64),
    }),
  ),
  batches: z.array(z.object({ batchId: z.string().min(1), records: z.number().int().nonnegative() }).passthrough()),
});

const datasetRecordSourceSchema = z.object({
  itemId: z.string().min(1),
});

export type ParameterModuleStagingManifest = z.infer<typeof stagingManifestSchema>;
type DatasetManifest = z.infer<typeof datasetManifestSchema>;

export async function checkParameterModuleStagingManifest(
  manifestPath: string,
  options: ParameterModuleStagingGateOptions = {},
): Promise<ParameterModuleStagingGateReport> {
  const checks: ParameterModuleStagingCheck[] = [];
  const manifest = await readParameterModuleStagingManifest(manifestPath);
  const requiredEvalKinds = options.requiredEvalKinds ?? defaultRequiredEvalKinds(manifest);
  const requiredArtifactKinds = options.requiredArtifactKinds ?? defaultRequiredArtifactKinds(manifest.kind);
  const maxParameters = options.maxParameters ?? DEFAULT_PARAMETER_MODULE_STAGING_MAX_PARAMETERS;

  checks.push(...parameterChecks(manifest, maxParameters));
  checks.push(
    manifest.rollbackTargetId
      ? pass("rollback-target", `Rollback target is set to ${manifest.rollbackTargetId}`)
      : fail("rollback-target", "Rollback target is required before a parameter module can be staged"),
  );
  checks.push(...sourceChecks(manifest));

  const dataset = await readDatasetManifest(manifest, manifestPath, checks);
  if (dataset) {
    checks.push(...datasetHashChecks(manifest, dataset));
    if (options.verifyDatasetFiles ?? true) {
      checks.push(...(await datasetFileChecks(manifest, dataset, manifestPath)));
    }
  }

  checks.push(...artifactPresenceChecks(manifest, requiredArtifactKinds));
  checks.push(...(await hashedEvidenceChecks(manifest.artifacts, manifestPath, "artifact", true)));
  checks.push(...evalChecks(manifest, requiredEvalKinds));
  checks.push(
    ...(await hashedEvidenceChecks(
      manifest.evalReports,
      manifestPath,
      "eval-report",
      options.requireEvalReportHashes ?? true,
    )),
  );

  return {
    status: checks.some((check) => check.status === "fail") ? "fail" : "pass",
    manifestPath,
    generatedAt: options.now?.() ?? new Date().toISOString(),
    summary: {
      moduleName: manifest.moduleName,
      kind: manifest.kind,
      ...(manifest.route ? { route: manifest.route } : {}),
      parameters: manifest.parameters,
      activeParameters: manifest.activeParameters,
      trainableParameters: manifest.trainableParameters,
      artifacts: manifest.artifacts.length,
      evalReports: manifest.evalReports.length,
      sourceLearningItems: manifest.sourceLearningItemIds.length,
      requiredEvalKinds,
      requiredArtifactKinds,
      datasetManifestPath: manifest.datasetManifestPath,
    },
    checks,
  };
}

export async function readParameterModuleStagingManifest(manifestPath: string): Promise<ParameterModuleStagingManifest> {
  return stagingManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
}

function parameterChecks(manifest: ParameterModuleStagingManifest, maxParameters: number): ParameterModuleStagingCheck[] {
  const failures: string[] = [];
  if (manifest.activeParameters > manifest.parameters) failures.push("activeParameters exceeds parameters");
  if (manifest.trainableParameters > manifest.parameters) failures.push("trainableParameters exceeds parameters");
  if (manifest.parameters > maxParameters) {
    failures.push(`parameters ${manifest.parameters} exceeds maxParameters ${maxParameters}`);
  }
  return [
    failures.length === 0
      ? pass("parameter-counts", "Parameter counts are positive and within the staging budget")
      : fail("parameter-counts", "Parameter counts are not stageable", { failures }),
  ];
}

function sourceChecks(manifest: ParameterModuleStagingManifest): ParameterModuleStagingCheck[] {
  const duplicateSourceIds = duplicates(manifest.sourceLearningItemIds);
  return [
    manifest.sourceLearningItemIds.length > 0
      ? pass("source-learning-items", `Staging manifest links ${manifest.sourceLearningItemIds.length} source items`)
      : fail("source-learning-items", "Staging manifest must link source learned-item ids"),
    duplicateSourceIds.length === 0
      ? pass("unique-source-learning-items", "Source learned-item ids are unique")
      : fail("unique-source-learning-items", "Source learned-item ids are duplicated", { duplicateSourceIds }),
    manifest.datasetHashes.length > 0
      ? pass("dataset-hash-list", `Staging manifest records ${manifest.datasetHashes.length} dataset hashes`)
      : fail("dataset-hash-list", "Staging manifest must preserve dataset hashes for provenance"),
  ];
}

async function readDatasetManifest(
  manifest: ParameterModuleStagingManifest,
  manifestPath: string,
  checks: ParameterModuleStagingCheck[],
): Promise<DatasetManifest | null> {
  const datasetManifestPath = resolvePath(manifest.datasetManifestPath, manifestPath);
  let body: Buffer;
  try {
    body = await readFile(datasetManifestPath);
  } catch (err) {
    checks.push(fail("dataset-manifest-readable", "Dataset manifest could not be read", { error: errorMessage(err) }));
    return null;
  }

  const actualSha256 = hashBuffer(body);
  checks.push(
    actualSha256 === manifest.datasetManifestSha256
      ? pass("dataset-manifest-hash", "Dataset manifest hash matches staging manifest")
      : fail("dataset-manifest-hash", "Dataset manifest hash does not match staging manifest", {
          expectedSha256: manifest.datasetManifestSha256,
          actualSha256,
        }),
  );

  try {
    const parsed = datasetManifestSchema.safeParse(JSON.parse(body.toString("utf8")));
    if (!parsed.success) {
      checks.push(fail("dataset-manifest-schema", "Dataset manifest schema is invalid", { error: parsed.error.flatten() }));
      return null;
    }
    checks.push(pass("dataset-manifest-schema", "Dataset manifest schema is valid"));
    return parsed.data;
  } catch (err) {
    checks.push(fail("dataset-manifest-schema", "Dataset manifest is not valid JSON", { error: errorMessage(err) }));
    return null;
  }
}

function datasetHashChecks(manifest: ParameterModuleStagingManifest, dataset: DatasetManifest): ParameterModuleStagingCheck[] {
  const hashes = new Set(manifest.datasetHashes);
  const requiredHashes = [manifest.datasetManifestSha256, ...dataset.files.map((file) => file.sha256)];
  const missingHashes = requiredHashes.filter((hash) => !hashes.has(hash));
  return [
    missingHashes.length === 0
      ? pass("dataset-hashes", "Dataset hash list covers manifest and emitted dataset files")
      : fail("dataset-hashes", "Dataset hash list is missing emitted dataset hashes", { missingHashes }),
  ];
}

async function datasetFileChecks(
  manifest: ParameterModuleStagingManifest,
  dataset: DatasetManifest,
  manifestPath: string,
): Promise<ParameterModuleStagingCheck[]> {
  const checks: ParameterModuleStagingCheck[] = [];
  const datasetManifestPath = resolvePath(manifest.datasetManifestPath, manifestPath);
  const sourceIds = new Set<string>();
  for (const file of dataset.files) {
    const filePath = resolvePath(file.path, datasetManifestPath);
    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch (err) {
      checks.push(fail(`dataset-file-readable:${file.batchId}`, "Dataset file could not be read", { error: errorMessage(err) }));
      continue;
    }
    const actualBytes = body.byteLength;
    const actualSha256 = hashBuffer(body);
    checks.push(
      actualBytes === file.bytes && actualSha256 === file.sha256
        ? pass(`dataset-file-hash:${file.batchId}`, `Verified dataset file ${basename(file.path)}`)
        : fail(`dataset-file-hash:${file.batchId}`, "Dataset file bytes/hash do not match dataset manifest", {
            expectedBytes: file.bytes,
            actualBytes,
            expectedSha256: file.sha256,
            actualSha256,
          }),
    );

    const lines = body.toString("utf8").split(/\r?\n/).filter(Boolean);
    checks.push(
      lines.length === file.lines
        ? pass(`dataset-file-lines:${file.batchId}`, `Dataset file has ${lines.length} rows`)
        : fail(`dataset-file-lines:${file.batchId}`, "Dataset file line count does not match dataset manifest", {
            expected: file.lines,
            actual: lines.length,
          }),
    );
    const parseFailures: Array<{ line: number; error: unknown }> = [];
    lines.forEach((line, index) => {
      try {
        const parsed = datasetRecordSourceSchema.safeParse(JSON.parse(line));
        if (parsed.success) sourceIds.add(parsed.data.itemId);
        else parseFailures.push({ line: index + 1, error: parsed.error.flatten() });
      } catch (err) {
        parseFailures.push({ line: index + 1, error: errorMessage(err) });
      }
    });
    checks.push(
      parseFailures.length === 0
        ? pass(`dataset-source-schema:${file.batchId}`, "Dataset rows expose source learned-item ids")
        : fail(`dataset-source-schema:${file.batchId}`, "Dataset rows are missing source learned-item ids", { parseFailures }),
    );
  }

  const manifestIds = new Set(manifest.sourceLearningItemIds);
  const missingFromManifest = [...sourceIds].filter((id) => !manifestIds.has(id)).sort();
  const missingFromDataset = [...manifestIds].filter((id) => !sourceIds.has(id)).sort();
  checks.push(
    missingFromManifest.length === 0 && missingFromDataset.length === 0
      ? pass("dataset-source-learning-items", "Dataset source item ids match the staging manifest")
      : fail("dataset-source-learning-items", "Dataset source item ids do not match staging manifest", {
          missingFromManifest,
          missingFromDataset,
        }),
  );

  return checks;
}

function artifactPresenceChecks(manifest: ParameterModuleStagingManifest, requiredKinds: string[]): ParameterModuleStagingCheck[] {
  const artifactKinds = new Set(manifest.artifacts.map((artifact) => artifact.kind));
  return requiredKinds.map((kind) =>
    artifactKinds.has(kind)
      ? pass(`required-artifact:${kind}`, `Required ${kind} artifact is present`)
      : fail(`required-artifact:${kind}`, `Required ${kind} artifact is missing`),
  );
}

async function hashedEvidenceChecks(
  files: Array<{ kind: string; path: string; bytes?: number; sha256?: string }>,
  manifestPath: string,
  label: "artifact" | "eval-report",
  requireSha256: boolean,
): Promise<ParameterModuleStagingCheck[]> {
  const checks: ParameterModuleStagingCheck[] = [];
  for (const file of files) {
    if (requireSha256 && !file.sha256) {
      checks.push(fail(`${label}-hash:${file.kind}`, `${label} ${file.kind} is missing sha256 evidence`));
      continue;
    }
    const path = resolvePath(file.path, manifestPath);
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch (err) {
      checks.push(fail(`${label}-readable:${file.kind}`, `${label} ${file.kind} could not be read`, { error: errorMessage(err) }));
      continue;
    }
    const actualBytes = body.byteLength;
    const actualSha256 = hashBuffer(body);
    const expectedBytes = file.bytes;
    const bytesMatch = expectedBytes === undefined || expectedBytes === actualBytes;
    const hashMatch = !file.sha256 || file.sha256 === actualSha256;
    checks.push(
      actualBytes > 0 && bytesMatch && hashMatch
        ? pass(`${label}-hash:${file.kind}`, `${label} ${file.kind} is present and hash-verified`)
        : fail(`${label}-hash:${file.kind}`, `${label} ${file.kind} bytes/hash verification failed`, {
            expectedBytes,
            actualBytes,
            expectedSha256: file.sha256,
            actualSha256,
          }),
    );
  }
  return checks;
}

function evalChecks(
  manifest: ParameterModuleStagingManifest,
  requiredKinds: ParameterModuleStagingEvalKind[],
): ParameterModuleStagingCheck[] {
  const checks: ParameterModuleStagingCheck[] = [];
  const reportsByKind = new Map<ParameterModuleStagingEvalKind, Array<{ status: "pass" | "fail" | "warn" }>>();
  for (const report of manifest.evalReports) {
    reportsByKind.set(report.kind, [...(reportsByKind.get(report.kind) ?? []), { status: report.status }]);
  }
  for (const kind of requiredKinds) {
    const reports = reportsByKind.get(kind) ?? [];
    checks.push(
      reports.some((report) => report.status === "pass")
        ? pass(`required-eval:${kind}`, `Required ${kind} eval report passed`)
        : fail(`required-eval:${kind}`, `Required ${kind} eval report must be present with pass status`, {
            statuses: reports.map((report) => report.status),
          }),
    );
  }

  const failedReports = manifest.evalReports
    .filter((report) => report.status === "fail")
    .map((report) => ({ kind: report.kind, path: report.path, summary: report.summary }));
  checks.push(
    failedReports.length === 0
      ? pass("eval-report-statuses", "No attached eval report has fail status")
      : fail("eval-report-statuses", "Attached eval reports include failures", { failedReports }),
  );
  return checks;
}

function defaultRequiredEvalKinds(manifest: ParameterModuleStagingManifest): ParameterModuleStagingEvalKind[] {
  const required: ParameterModuleStagingEvalKind[] = ["dataset_quality", "parameter_growth", "training_report", "contamination"];
  if (manifest.kind === "router") required.push("router", "protocol");
  else if (manifest.kind === "specialist" || manifest.kind === "expert") required.push("skill", "protocol");
  else if (manifest.kind === "adapter") required.push("protocol", "knowledge", "behavior");
  else if (manifest.kind === "merged_checkpoint") required.push("protocol", "knowledge", "behavior", "skill");
  else if (manifest.kind === "ensemble_member") required.push("protocol", "knowledge");
  else if (manifest.kind === "base_model") required.push("protocol", "knowledge", "behavior");
  if (manifest.route?.toLowerCase().includes("voice")) required.push("voice");
  return unique(required);
}

function defaultRequiredArtifactKinds(kind: ParameterModuleKind): string[] {
  if (kind === "adapter") return ["adapter", "config"];
  return ["checkpoint", "config"];
}

function resolvePath(path: string, baseFilePath: string): string {
  return isAbsolute(path) ? path : join(dirname(baseFilePath), path);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pass(id: string, summary: string, details?: Record<string, unknown>): ParameterModuleStagingCheck {
  return { id, status: "pass", summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): ParameterModuleStagingCheck {
  return { id, status: "fail", summary, ...(details ? { details } : {}) };
}
