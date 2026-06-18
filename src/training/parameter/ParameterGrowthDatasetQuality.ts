import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
export type ParameterGrowthDatasetQualityStatus = "pass" | "fail";

export interface ParameterGrowthDatasetQualityCheck {
  id: string;
  status: ParameterGrowthDatasetQualityStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ParameterGrowthDatasetQualityReport {
  status: ParameterGrowthDatasetQualityStatus;
  manifestPath: string;
  generatedAt: string;
  summary: {
    files: number;
    records: number;
    batches: number;
    gateStatus: string;
  };
  checks: ParameterGrowthDatasetQualityCheck[];
}

const manifestSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  generatedAt: z.string().min(1),
  gate: z.object({ status: z.string().min(1) }).passthrough(),
  files: z.array(
    z.object({
      batchId: z.string().min(1),
      path: z.string().min(1),
      lines: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().length(64),
    }),
  ),
  batches: z.array(
    z.object({
      batchId: z.string().min(1),
      records: z.number().int().nonnegative(),
      moduleName: z.string().min(1),
      datasetId: z.string().min(1),
    }).passthrough(),
  ),
});

const recordSchema = z.object({
  id: z.string().min(1),
  batchId: z.string().min(1),
  itemId: z.string().min(1),
  target: z.object({
    kind: z.enum(["adapter", "router", "specialist", "expert"]),
    route: z.string().optional(),
    moduleName: z.string().min(1),
    datasetId: z.string().min(1),
  }),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string().min(1),
      }),
    )
    .min(3),
  source: z.object({
    kind: z.string().min(1),
    source: z.string().min(1),
    confidence: z.number().min(0).max(1),
    content: z.string().min(1),
    metadata: z.record(z.unknown()),
  }),
  quality: z.object({
    reviewStatus: z.literal("approved"),
    trainingStatus: z.literal("queued"),
    contentHash: z.string().length(64),
    metadataHash: z.string().length(64),
    canRetrieve: z.boolean(),
    canTrain: z.literal(true),
  }),
});

type ParsedManifest = z.infer<typeof manifestSchema>;

export async function checkParameterGrowthDatasetQuality(
  manifestPath: string,
): Promise<ParameterGrowthDatasetQualityReport> {
  const checks: ParameterGrowthDatasetQualityCheck[] = [];
  const manifest = await readManifest(manifestPath);
  checks.push(
    manifest.gate.status === "pass"
      ? pass("plan-gate", "Parameter growth plan gate passed before dataset build")
      : fail("plan-gate", "Parameter growth plan gate did not pass", { status: manifest.gate.status }),
  );

  const fileResults = await Promise.all(manifest.files.map((file) => checkFile(file)));
  for (const result of fileResults) checks.push(...result.checks);

  const totalRecords = fileResults.reduce((sum, result) => sum + result.records.length, 0);
  const manifestLines = manifest.files.reduce((sum, file) => sum + file.lines, 0);
  checks.push(
    totalRecords === manifestLines
      ? pass("manifest-record-count", `Manifest records match file rows: ${totalRecords}`)
      : fail("manifest-record-count", "Manifest file line counts do not match parsed records", {
          manifestLines,
          totalRecords,
        }),
  );

  const batchRecordCounts = new Map<string, number>();
  for (const result of fileResults) {
    for (const record of result.records) {
      batchRecordCounts.set(record.batchId, (batchRecordCounts.get(record.batchId) ?? 0) + 1);
    }
  }
  const batchMismatches = manifest.batches.filter((batch) => batch.records !== (batchRecordCounts.get(batch.batchId) ?? 0));
  checks.push(
    batchMismatches.length === 0
      ? pass("batch-record-count", "Batch record counts match the manifest")
      : fail("batch-record-count", "Batch record counts do not match the manifest", { batchMismatches }),
  );

  const allRecords = fileResults.flatMap((result) => result.records);
  const duplicateIds = duplicates(allRecords.map((record) => record.id));
  checks.push(
    duplicateIds.length === 0
      ? pass("unique-record-ids", "Parameter-growth record ids are unique")
      : fail("unique-record-ids", "Parameter-growth record ids are duplicated", { duplicateIds }),
  );

  const secretHits = allRecords.flatMap((record) => secretFindings(record));
  checks.push(
    secretHits.length === 0
      ? pass("secret-scan", "No obvious secrets detected in parameter-growth dataset records")
      : fail("secret-scan", "Potential secrets detected in parameter-growth dataset records", { secretHits }),
  );

  return {
    status: checks.some((check) => check.status === "fail") ? "fail" : "pass",
    manifestPath,
    generatedAt: new Date().toISOString(),
    summary: {
      files: manifest.files.length,
      records: totalRecords,
      batches: manifest.batches.length,
      gateStatus: manifest.gate.status,
    },
    checks,
  };
}

async function readManifest(path: string): Promise<ParsedManifest> {
  return manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function checkFile(file: ParsedManifest["files"][number]): Promise<{
  records: Array<z.infer<typeof recordSchema>>;
  checks: ParameterGrowthDatasetQualityCheck[];
}> {
  const checks: ParameterGrowthDatasetQualityCheck[] = [];
  const body = await readFile(file.path, "utf8");
  const actual = {
    bytes: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  checks.push(
    actual.bytes === file.bytes && actual.sha256 === file.sha256
      ? pass(`file-hash:${file.batchId}`, `Verified file hash for ${file.path}`)
      : fail(`file-hash:${file.batchId}`, "File bytes/hash do not match manifest", {
          path: file.path,
          expectedBytes: file.bytes,
          actualBytes: actual.bytes,
          expectedSha256: file.sha256,
          actualSha256: actual.sha256,
        }),
  );

  const lines = body.split(/\r?\n/).filter((line) => line.length > 0);
  checks.push(
    lines.length === file.lines
      ? pass(`file-lines:${file.batchId}`, `Parsed ${lines.length} records for ${file.batchId}`)
      : fail(`file-lines:${file.batchId}`, "File line count does not match manifest", {
          expected: file.lines,
          actual: lines.length,
        }),
  );

  const records: Array<z.infer<typeof recordSchema>> = [];
  const parseFailures: Array<{ line: number; error: unknown }> = [];
  lines.forEach((line, index) => {
    try {
      const parsed = recordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
      else parseFailures.push({ line: index + 1, error: parsed.error.flatten() });
    } catch (err) {
      parseFailures.push({ line: index + 1, error: err instanceof Error ? err.message : String(err) });
    }
  });
  checks.push(
    parseFailures.length === 0
      ? pass(`record-schema:${file.batchId}`, `All records match schema for ${file.batchId}`)
      : fail(`record-schema:${file.batchId}`, "Some records failed schema validation", { parseFailures }),
  );

  const wrongBatch = records.filter((record) => record.batchId !== file.batchId).map((record) => record.id);
  checks.push(
    wrongBatch.length === 0
      ? pass(`record-batch:${file.batchId}`, "All records belong to their manifest batch")
      : fail(`record-batch:${file.batchId}`, "Records belong to the wrong batch", { wrongBatch }),
  );

  return { records, checks };
}

function secretFindings(record: z.infer<typeof recordSchema>): Array<{ id: string; pattern: string }> {
  const body = JSON.stringify(record);
  const patterns: Array<[string, RegExp]> = [
    ["openai_key", /\bsk-[a-z0-9_-]{8,}/i],
    ["discord_token", /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/],
    ["assignment_secret", /\b(password|passwd|passphrase|api[_ -]?key|secret|token)\b\s*[:=]\s*[^,\s;]+/i],
    ["bearer_token", /\b(bearer|authorization)\s+[a-z0-9._-]{10,}/i],
  ];
  return patterns.flatMap(([label, pattern]) => (pattern.test(body) ? [{ id: record.id, pattern: label }] : []));
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

function pass(id: string, summary: string, details?: Record<string, unknown>): ParameterGrowthDatasetQualityCheck {
  return { id, status: "pass", summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): ParameterGrowthDatasetQualityCheck {
  return { id, status: "fail", summary, ...(details ? { details } : {}) };
}
