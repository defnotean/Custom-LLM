import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export type DatasetGovernanceStatus = "pass" | "fail";
export type DatasetGovernanceCheckStatus = "pass" | "warn" | "fail";

export interface DatasetGovernanceReadinessOptions {
  rawManifestPath?: string;
  processedReportPath?: string;
  sftReportPath?: string;
  preferenceReportPath?: string;
  preparerSourcePath?: string;
  minAcceptedRecords?: number;
  minValidationRecords?: number;
  minEvalSeedRecords?: number;
  minEvalSeedSourceShare?: number;
  maxSyntheticTrainShare?: number;
  requiredOpenSources?: string[];
  allowedLicenses?: string[];
}

export interface DatasetGovernanceCheck {
  id: string;
  status: DatasetGovernanceCheckStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface DatasetGovernanceReadinessReport {
  status: DatasetGovernanceStatus;
  generatedAt: string;
  rawManifestPath: string;
  processedReportPath: string;
  sftReportPath: string;
  preferenceReportPath: string;
  summary: {
    rawSources: number;
    processedAccepted: number;
    processedTrain: number;
    processedValidation: number;
    evalSeed: number;
    productionTrain: number;
    productionValidation: number;
    syntheticTrainShare: number;
    preferenceTotal: number;
    preferenceSyntheticOnly: boolean;
  };
  checks: DatasetGovernanceCheck[];
}

type DatasetGovernanceReadinessConfig = Required<DatasetGovernanceReadinessOptions>;

const DEFAULTS: DatasetGovernanceReadinessConfig = {
  rawManifestPath: "training/data/raw/dataset_manifest.json",
  processedReportPath: "training/data/processed/dataset_report.json",
  sftReportPath: "training/data/mixtures/production-sft.report.json",
  preferenceReportPath: "training/data/preferences/production-dpo.report.json",
  preparerSourcePath: "src/training/external/OpenDatasetPreparer.ts",
  minAcceptedRecords: 1_000,
  minValidationRecords: 100,
  minEvalSeedRecords: 50,
  minEvalSeedSourceShare: 0.25,
  maxSyntheticTrainShare: 0.2,
  requiredOpenSources: ["dolly", "oasst1_ready"],
  allowedLicenses: ["apache-2.0", "cc-by-sa-3.0", "cc-by-4.0", "project-owned"],
};

const rawSourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().min(1),
    outputFile: z.string().min(1),
    license: z.string().min(1),
    homepage: z.string().min(1),
    expectedSha256: z.string().length(64).optional(),
    gated: z.boolean().optional(),
    status: z.string().min(1),
    path: z.string().min(1),
    bytes: z.number().int().positive().optional(),
    sha256: z.string().length(64).optional(),
  })
  .passthrough();

const rawManifestSchema = z.object({
  generatedAt: z.string().min(1),
  outDir: z.string().min(1),
  sources: z.array(rawSourceSchema).min(1),
});

const outputFileSchema = z.object({
  path: z.string().min(1),
  lines: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
});

const processedReportSchema = z.object({
  totalRaw: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  train: z.number().int().nonnegative(),
  validation: z.number().int().nonnegative(),
  evalSeed: z.number().int().nonnegative(),
  evalSeedBySource: z.record(z.number().int().nonnegative()),
  evalSeedSkippedHighOverlap: z.number().int().nonnegative(),
  skipped: z.record(z.number().int().nonnegative()),
  bySource: z.record(z.object({ raw: z.number().int().nonnegative(), accepted: z.number().int().nonnegative() })),
  files: z.array(outputFileSchema).min(1),
});

const sourceSummarySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  required: z.boolean(),
  present: z.boolean(),
  kind: z.string().min(1),
  raw: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

const sftReportSchema = z.object({
  train: z.number().int().nonnegative(),
  validation: z.number().int().nonnegative(),
  maxSyntheticShare: z.number().min(0).max(1),
  syntheticTrainShare: z.number().min(0).max(1),
  sources: z.array(sourceSummarySchema),
  files: z.array(outputFileSchema).min(1),
});

const preferenceReportSchema = z.object({
  total: z.number().int().nonnegative(),
  syntheticOnly: z.boolean(),
  syntheticShare: z.number().min(0).max(1),
  sources: z.array(sourceSummarySchema),
  files: z.array(outputFileSchema).min(1),
});

const chatRecordSchema = z
  .object({
    metadata: z
      .object({
        source: z.string().optional(),
        license: z.string().optional(),
        split: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /(?:mfa\.)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

const allowedSkipReasons = new Set(["too-short", "too-long", "sensitive", "duplicate", "over-source-cap"]);

export async function checkDatasetGovernanceReadiness(
  options: DatasetGovernanceReadinessOptions = {},
): Promise<DatasetGovernanceReadinessReport> {
  const config = resolveOptions(options);
  const [rawManifest, processedReport, sftReport, preferenceReport, preparerSource] = await Promise.all([
    readJson(config.rawManifestPath, rawManifestSchema),
    readJson(config.processedReportPath, processedReportSchema),
    readJson(config.sftReportPath, sftReportSchema),
    readJson(config.preferenceReportPath, preferenceReportSchema),
    readFile(config.preparerSourcePath, "utf8"),
  ]);

  const checks: DatasetGovernanceCheck[] = [
    await rawManifestChecks(rawManifest, config.requiredOpenSources, config.allowedLicenses),
    gatedSourceCheck(rawManifest),
    processedVolumeCheck(processedReport, config),
    processedSourceCoverageCheck(processedReport, config.requiredOpenSources),
    evalSeedBalanceCheck(processedReport, config.requiredOpenSources, config.minEvalSeedSourceShare),
    skippedReasonCheck(processedReport),
    preparerSafetyContractCheck(preparerSource),
    await processedRecordMetadataCheck(processedReport, config.allowedLicenses),
    await datasetSecretScanCheck([...processedReport.files, ...sftReport.files]),
    await outputFileHashCheck("processed-output-hashes", processedReport.files),
    await outputFileHashCheck("production-sft-output-hashes", sftReport.files),
    productionMixtureCheck(sftReport, config.maxSyntheticTrainShare),
    preferenceGovernanceCheck(preferenceReport),
  ];

  return {
    status: checks.some((check) => check.status === "fail") ? "fail" : "pass",
    generatedAt: new Date().toISOString(),
    rawManifestPath: config.rawManifestPath,
    processedReportPath: config.processedReportPath,
    sftReportPath: config.sftReportPath,
    preferenceReportPath: config.preferenceReportPath,
    summary: {
      rawSources: rawManifest.sources.length,
      processedAccepted: processedReport.accepted,
      processedTrain: processedReport.train,
      processedValidation: processedReport.validation,
      evalSeed: processedReport.evalSeed,
      productionTrain: sftReport.train,
      productionValidation: sftReport.validation,
      syntheticTrainShare: sftReport.syntheticTrainShare,
      preferenceTotal: preferenceReport.total,
      preferenceSyntheticOnly: preferenceReport.syntheticOnly,
    },
    checks,
  };
}

function resolveOptions(options: DatasetGovernanceReadinessOptions): DatasetGovernanceReadinessConfig {
  return {
    rawManifestPath: options.rawManifestPath ?? DEFAULTS.rawManifestPath,
    processedReportPath: options.processedReportPath ?? DEFAULTS.processedReportPath,
    sftReportPath: options.sftReportPath ?? DEFAULTS.sftReportPath,
    preferenceReportPath: options.preferenceReportPath ?? DEFAULTS.preferenceReportPath,
    preparerSourcePath: options.preparerSourcePath ?? DEFAULTS.preparerSourcePath,
    minAcceptedRecords: options.minAcceptedRecords ?? DEFAULTS.minAcceptedRecords,
    minValidationRecords: options.minValidationRecords ?? DEFAULTS.minValidationRecords,
    minEvalSeedRecords: options.minEvalSeedRecords ?? DEFAULTS.minEvalSeedRecords,
    minEvalSeedSourceShare: options.minEvalSeedSourceShare ?? DEFAULTS.minEvalSeedSourceShare,
    maxSyntheticTrainShare: options.maxSyntheticTrainShare ?? DEFAULTS.maxSyntheticTrainShare,
    requiredOpenSources: options.requiredOpenSources ?? DEFAULTS.requiredOpenSources,
    allowedLicenses: options.allowedLicenses ?? DEFAULTS.allowedLicenses,
  };
}

async function rawManifestChecks(
  manifest: z.infer<typeof rawManifestSchema>,
  requiredSources: string[],
  allowedLicenses: string[],
): Promise<DatasetGovernanceCheck> {
  const byId = new Map(manifest.sources.map((source) => [source.id, source]));
  const missing = requiredSources.filter((id) => !byId.has(id));
  const invalid = [];
  for (const id of requiredSources) {
    const source = byId.get(id);
    if (!source) continue;
    if (!["downloaded", "already-present"].includes(source.status)) {
      invalid.push({ id, reason: "not-downloaded", status: source.status });
    }
    if (!allowedLicenses.includes(source.license)) invalid.push({ id, reason: "license", license: source.license });
    if (!source.sha256 || !source.expectedSha256 || source.sha256 !== source.expectedSha256) {
      invalid.push({ id, reason: "checksum", expected: source.expectedSha256, actual: source.sha256 });
    } else {
      try {
        const actual = await fileSha256(source.path);
        if (actual !== source.sha256) invalid.push({ id, reason: "file-hash", expected: source.sha256, actual });
      } catch (err) {
        invalid.push({ id, reason: "file-readable", error: errorMessage(err) });
      }
    }
  }

  return missing.length === 0 && invalid.length === 0
    ? pass("raw-dataset-provenance", `Raw manifest proves ${requiredSources.length} required open sources`)
    : fail("raw-dataset-provenance", "Raw dataset manifest is missing required provenance", { missing, invalid });
}

function gatedSourceCheck(manifest: z.infer<typeof rawManifestSchema>): DatasetGovernanceCheck {
  const loadedGated = manifest.sources.filter((source) => source.gated && source.status !== "gated-manual-access");
  return loadedGated.length === 0
    ? pass("gated-dataset-boundary", "Gated datasets are not silently included")
    : fail("gated-dataset-boundary", "Gated datasets require explicit manual access review before use", {
        loadedGated: loadedGated.map((source) => ({ id: source.id, status: source.status })),
      });
}

function processedVolumeCheck(
  report: z.infer<typeof processedReportSchema>,
  config: typeof DEFAULTS,
): DatasetGovernanceCheck {
  const failures = [];
  if (report.accepted < config.minAcceptedRecords) failures.push({ metric: "accepted", actual: report.accepted, expected: config.minAcceptedRecords });
  if (report.validation < config.minValidationRecords) failures.push({ metric: "validation", actual: report.validation, expected: config.minValidationRecords });
  if (report.evalSeed < config.minEvalSeedRecords) failures.push({ metric: "evalSeed", actual: report.evalSeed, expected: config.minEvalSeedRecords });
  return failures.length === 0
    ? pass("processed-dataset-volume", `Processed dataset has ${report.accepted} accepted rows and ${report.evalSeed} eval seed rows`)
    : fail("processed-dataset-volume", "Processed dataset volume is below governance thresholds", { failures });
}

function processedSourceCoverageCheck(
  report: z.infer<typeof processedReportSchema>,
  requiredSources: string[],
): DatasetGovernanceCheck {
  const missing = requiredSources.filter((source) => (report.bySource[source]?.accepted ?? 0) <= 0);
  return missing.length === 0
    ? pass("processed-source-coverage", "Processed dataset preserves all required open sources")
    : fail("processed-source-coverage", "Processed dataset is missing required source coverage", { missing });
}

function evalSeedBalanceCheck(
  report: z.infer<typeof processedReportSchema>,
  requiredSources: string[],
  minShare: number,
): DatasetGovernanceCheck {
  const failures = [];
  for (const source of requiredSources) {
    const share = report.evalSeed > 0 ? (report.evalSeedBySource[source] ?? 0) / report.evalSeed : 0;
    if (share < minShare) failures.push({ source, share: round(share), minShare });
  }
  return failures.length === 0
    ? pass("eval-seed-source-balance", "Knowledge eval seed remains source-balanced")
    : fail("eval-seed-source-balance", "Knowledge eval seed is too source-imbalanced", { failures });
}

function skippedReasonCheck(report: z.infer<typeof processedReportSchema>): DatasetGovernanceCheck {
  const unknownReasons = Object.keys(report.skipped).filter((key) => {
    const reason = key.includes(":") ? key.split(":").pop() ?? key : key;
    return !allowedSkipReasons.has(reason);
  });
  return unknownReasons.length === 0
    ? pass("processed-skip-reasons", "Skipped rows use classified quality/safety reasons", {
        skipped: report.skipped,
      })
    : fail("processed-skip-reasons", "Processed dataset has unclassified skip reasons", { unknownReasons });
}

function preparerSafetyContractCheck(source: string): DatasetGovernanceCheck {
  const required = ["secretPatterns", "sensitive", "too-long", "too-short", "duplicate", "selectBalancedEvalSeed"];
  const missing = required.filter((needle) => !source.includes(needle));
  return missing.length === 0
    ? pass("dataset-preparer-safety-contract", "Open dataset preparer keeps secret, length, duplicate, and eval-seed controls")
    : fail("dataset-preparer-safety-contract", "Open dataset preparer is missing required safety controls", { missing });
}

async function processedRecordMetadataCheck(
  report: z.infer<typeof processedReportSchema>,
  allowedLicenses: string[],
): Promise<DatasetGovernanceCheck> {
  const samples = await sampleRecords(report.files.filter((file) => file.path.includes("sft.")), 200);
  const missingMetadata = [];
  const sources = new Set<string>();
  const licenses = new Set<string>();
  for (const sample of samples) {
    const parsed = chatRecordSchema.safeParse(sample.row);
    const metadata = parsed.success ? parsed.data.metadata : undefined;
    if (!metadata?.source || !metadata.license || !metadata.split) {
      missingMetadata.push({ path: sample.path, line: sample.line });
      continue;
    }
    sources.add(metadata.source);
    licenses.add(metadata.license);
  }
  const disallowedLicenses = [...licenses].filter((license) => !allowedLicenses.includes(license));
  return missingMetadata.length === 0 && disallowedLicenses.length === 0
    ? pass("processed-record-provenance", "Processed ChatML rows preserve source, license, and split metadata")
    : fail("processed-record-provenance", "Processed ChatML rows have incomplete provenance metadata", {
        missingMetadata: missingMetadata.slice(0, 20),
        disallowedLicenses,
      });
}

async function datasetSecretScanCheck(files: Array<z.infer<typeof outputFileSchema>>): Promise<DatasetGovernanceCheck> {
  const findings = [];
  const unique = uniqueFiles(files);
  for (const file of unique) {
    const body = await readFile(file.path, "utf8");
    const text = textForSecretScan(body);
    const match = secretPatterns.find((pattern) => pattern.test(text));
    if (match) findings.push({ path: file.path, pattern: String(match) });
  }
  return findings.length === 0
    ? pass("dataset-secret-scan", `Scanned ${unique.length} dataset artifacts for obvious secrets/PII`)
    : fail("dataset-secret-scan", "Dataset artifacts contain obvious secrets or PII patterns", {
        findings: findings.slice(0, 20),
      });
}

async function outputFileHashCheck(id: string, files: Array<z.infer<typeof outputFileSchema>>): Promise<DatasetGovernanceCheck> {
  const mismatches = [];
  for (const file of files) {
    try {
      const body = await readFile(file.path);
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (sha256 !== file.sha256 || body.byteLength !== file.bytes) {
        mismatches.push({ path: file.path, expectedSha256: file.sha256, actualSha256: sha256 });
      }
    } catch (err) {
      mismatches.push({ path: file.path, error: errorMessage(err) });
    }
  }
  return mismatches.length === 0
    ? pass(id, `Verified ${files.length} dataset output hashes`)
    : fail(id, "Dataset output files do not match recorded hashes", { mismatches });
}

function textForSecretScan(body: string): string {
  const values: string[] = [];
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return body;

  for (const line of lines) {
    try {
      collectStringValues(JSON.parse(line) as unknown, values);
    } catch {
      return body;
    }
  }

  return values.length > 0 ? values.join("\n") : body;
}

function collectStringValues(value: unknown, values: string[], keyHint?: string): void {
  if (typeof value === "string") {
    values.push(keyHint ? `${keyHint}: ${value}` : value);
    values.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    if (keyHint) values.push(`${keyHint}: ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStringValues(item, values, keyHint));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectStringValues(item, values, key);
  }
}

function productionMixtureCheck(report: z.infer<typeof sftReportSchema>, maxSyntheticShare: number): DatasetGovernanceCheck {
  const requiredMissing = report.sources.filter((source) => source.required && (!source.present || source.accepted <= 0));
  const syntheticTooHigh = report.syntheticTrainShare > maxSyntheticShare || report.syntheticTrainShare > report.maxSyntheticShare;
  return requiredMissing.length === 0 && !syntheticTooHigh
    ? pass("production-mixture-governance", "Production SFT mixture has required open data and capped synthetic share")
    : fail("production-mixture-governance", "Production SFT mixture violates source or synthetic-share policy", {
        requiredMissing,
        syntheticTrainShare: report.syntheticTrainShare,
        maxSyntheticShare,
        reportMaxSyntheticShare: report.maxSyntheticShare,
      });
}

function preferenceGovernanceCheck(report: z.infer<typeof preferenceReportSchema>): DatasetGovernanceCheck {
  if (report.syntheticOnly) {
    return warn(
      "preference-data-governance",
      "Preference data is synthetic-only; acceptable for protocol smoke tests, not final alignment",
      { total: report.total, syntheticShare: report.syntheticShare },
    );
  }
  return pass("preference-data-governance", "Preference data includes non-synthetic reviewed signal");
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function fileSha256(path: string): Promise<string> {
  const body = await readFile(path);
  return createHash("sha256").update(body).digest("hex");
}

async function sampleRecords(
  files: Array<z.infer<typeof outputFileSchema>>,
  maxRows: number,
): Promise<Array<{ path: string; line: number; row: unknown }>> {
  const rows = [];
  for (const file of files) {
    const body = await readFile(file.path, "utf8");
    const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (let index = 0; index < lines.length && rows.length < maxRows; index++) {
      rows.push({ path: file.path, line: index + 1, row: JSON.parse(lines[index] ?? "{}") as unknown });
    }
    if (rows.length >= maxRows) break;
  }
  return rows;
}

function uniqueFiles(files: Array<z.infer<typeof outputFileSchema>>): Array<z.infer<typeof outputFileSchema>> {
  const byPath = new Map<string, z.infer<typeof outputFileSchema>>();
  for (const file of files) byPath.set(file.path, file);
  return [...byPath.values()];
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pass(id: string, summary: string, details?: Record<string, unknown>): DatasetGovernanceCheck {
  return { id, status: "pass", summary, ...(details ? { details } : {}) };
}

function warn(id: string, summary: string, details?: Record<string, unknown>): DatasetGovernanceCheck {
  return { id, status: "warn", summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): DatasetGovernanceCheck {
  return { id, status: "fail", summary, ...(details ? { details } : {}) };
}
