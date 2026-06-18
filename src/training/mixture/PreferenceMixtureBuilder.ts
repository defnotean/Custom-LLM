import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

const dpoRecordSchema = z
  .object({
    prompt: z.string().min(1),
    chosen: z.string().min(1),
    rejected: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

const syntheticDpoSchema = z
  .object({
    source: z.string().optional(),
    inputJson: z.object({ userMessage: z.string().default("") }).passthrough().optional(),
    outputJson: z
      .object({
        dpo: z
          .object({
            prompt: z.string().min(1),
            chosen: z.string().min(1),
            rejected: z.string().min(1),
          })
          .nullable()
          .optional(),
      })
      .passthrough(),
    metadataJson: z.record(z.unknown()).optional(),
  })
  .passthrough();

type RawDpoRecord = z.infer<typeof dpoRecordSchema>;

export interface PreferenceSource {
  name: string;
  path: string;
  required: boolean;
  kind?: "synthetic" | "feedback" | "exported_dpo";
  maxRecords?: number;
}

export interface PreferenceMixtureOptions {
  outDir: string;
  sources: PreferenceSource[];
  validationRatio?: number;
  maxSyntheticRecords?: number;
  maxSyntheticShare?: number;
}

export interface PreferenceSourceSummary {
  name: string;
  path: string;
  required: boolean;
  present: boolean;
  kind: string;
  raw: number;
  accepted: number;
  skipped: number;
  reason?: string;
}

export interface PreferenceOutputFile {
  path: string;
  lines: number;
  bytes: number;
  sha256: string;
}

export interface PreferenceMixtureReport {
  generatedAt: string;
  train: number;
  validation: number;
  total: number;
  validationRatio: number;
  synthetic: number;
  syntheticShare: number;
  syntheticOnly: boolean;
  sources: PreferenceSourceSummary[];
  files: PreferenceOutputFile[];
}

interface LoadedPreference {
  id: string;
  kind: string;
  synthetic: boolean;
  prompt: string;
  chosen: string;
  rejected: string;
  metadata: Record<string, unknown>;
}

export async function buildPreferenceMixture(options: PreferenceMixtureOptions): Promise<PreferenceMixtureReport> {
  const validationRatio = options.validationRatio ?? 0.1;
  const summaries: PreferenceSourceSummary[] = [];
  const loaded = await loadPreferenceSources(options.sources, summaries);
  const deduped = dedupePreferences(loaded);
  const capped = capSyntheticPreferences(deduped, {
    maxSyntheticRecords: options.maxSyntheticRecords ?? 2_000,
    maxSyntheticShare: options.maxSyntheticShare ?? 0.5,
  });
  const { train, validation } = splitPreferences(capped, validationRatio);

  await mkdir(options.outDir, { recursive: true });
  const trainPath = join(options.outDir, "production-dpo.train.jsonl");
  const validationPath = join(options.outDir, "production-dpo.validation.jsonl");
  const allPath = join(options.outDir, "production-dpo.all.jsonl");

  const files = [
    await writeJsonl(trainPath, train.map((item) => toOutputRecord(item, "train"))),
    await writeJsonl(validationPath, validation.map((item) => toOutputRecord(item, "validation"))),
    await writeJsonl(allPath, capped.map((item) => toOutputRecord(item, "all"))),
  ];

  const synthetic = capped.filter((item) => item.synthetic).length;
  const report: PreferenceMixtureReport = {
    generatedAt: new Date().toISOString(),
    train: train.length,
    validation: validation.length,
    total: capped.length,
    validationRatio,
    synthetic,
    syntheticShare: capped.length > 0 ? synthetic / capped.length : 0,
    syntheticOnly: capped.length > 0 && synthetic === capped.length,
    sources: summaries,
    files,
  };
  const reportPath = join(options.outDir, "production-dpo.report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  report.files.push(await fileInfo(reportPath, countLines(JSON.stringify(report, null, 2))));
  return report;
}

export function defaultPreferenceMixtureOptions(outDir = "training/data/preferences"): PreferenceMixtureOptions {
  return {
    outDir,
    validationRatio: 0.1,
    maxSyntheticRecords: 2_000,
    maxSyntheticShare: 0.5,
    sources: [
      {
        name: "synthetic_tool_preferences",
        path: "exports/training/synthetic-tools.jsonl",
        required: false,
        kind: "synthetic",
      },
      {
        name: "exported_dpo_pairs",
        path: "exports/training/dpo-placeholder.jsonl",
        required: false,
        kind: "exported_dpo",
      },
      {
        name: "reviewed_feedback_pairs",
        path: "exports/training/preference-feedback.jsonl",
        required: false,
        kind: "feedback",
      },
    ],
  };
}

async function loadPreferenceSources(
  sources: PreferenceSource[],
  summaries: PreferenceSourceSummary[],
): Promise<LoadedPreference[]> {
  const out: LoadedPreference[] = [];
  for (const source of sources) {
    const kind = source.kind ?? "exported_dpo";
    const exists = await pathExists(source.path);
    const summary: PreferenceSourceSummary = {
      name: source.name,
      path: source.path,
      required: source.required,
      present: exists,
      kind,
      raw: 0,
      accepted: 0,
      skipped: 0,
    };
    summaries.push(summary);

    if (!exists) {
      summary.reason = source.required ? "missing-required-file" : "missing-optional-file";
      if (source.required) throw new Error(`Required preference source is missing: ${source.path}`);
      continue;
    }

    const rows = await readJsonl(source.path);
    summary.raw = rows.length;
    for (let index = 0; index < rows.length; index++) {
      if (source.maxRecords !== undefined && summary.accepted >= source.maxRecords) {
        summary.skipped++;
        continue;
      }
      const normalized = normalizePreference(rows[index], source, index);
      if (!normalized) {
        summary.skipped++;
        continue;
      }
      summary.accepted++;
      out.push(normalized);
    }
  }
  return out;
}

function normalizePreference(raw: unknown, source: PreferenceSource, index: number): LoadedPreference | null {
  const kind = source.kind ?? "exported_dpo";
  const direct = normalizeDirectDpo(raw);
  const synthetic = normalizeSyntheticDpo(raw);
  const parsed = synthetic ?? direct;
  if (!parsed) return null;
  if (parsed.chosen === parsed.rejected) return null;

  const syntheticSource = kind === "synthetic" || parsed.metadata.source === "SYNTHETIC";
  const id =
    typeof parsed.metadata.id === "string" && parsed.metadata.id.length > 0
      ? parsed.metadata.id
      : `${source.name}:${index}:${stableHash(`${parsed.prompt}\n${parsed.chosen}\n${parsed.rejected}`).slice(0, 16)}`;

  return {
    id,
    kind,
    synthetic: syntheticSource,
    prompt: parsed.prompt,
    chosen: parsed.chosen,
    rejected: parsed.rejected,
    metadata: {
      ...parsed.metadata,
      id,
      source: typeof parsed.metadata.source === "string" ? parsed.metadata.source : source.name,
      sourcePath: source.path,
      sourceBasename: basename(source.path),
      preferenceKind: kind,
      synthetic: syntheticSource,
    },
  };
}

function normalizeDirectDpo(raw: unknown): LoadedPreference | null {
  const parsed = dpoRecordSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    id: "",
    kind: "exported_dpo",
    synthetic: false,
    prompt: parsed.data.prompt,
    chosen: parsed.data.chosen,
    rejected: parsed.data.rejected,
    metadata: parsed.data.metadata ?? {},
  };
}

function normalizeSyntheticDpo(raw: unknown): LoadedPreference | null {
  const parsed = syntheticDpoSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.outputJson.dpo) return null;
  const metadata = parsed.data.metadataJson ?? {};
  const dpo = parsed.data.outputJson.dpo;
  return {
    id: "",
    kind: "synthetic",
    synthetic: true,
    prompt: dpo.prompt || parsed.data.inputJson?.userMessage || "",
    chosen: dpo.chosen,
    rejected: dpo.rejected,
    metadata: {
      ...metadata,
      source: parsed.data.source ?? "SYNTHETIC",
    },
  };
}

function dedupePreferences(records: LoadedPreference[]): LoadedPreference[] {
  const seen = new Set<string>();
  const out: LoadedPreference[] = [];
  for (const record of records) {
    const key = stableHash(`${record.prompt}\n${record.chosen}\n${record.rejected}`);
    if (seen.has(record.id) || seen.has(key)) continue;
    seen.add(record.id);
    seen.add(key);
    out.push(record);
  }
  return out;
}

function capSyntheticPreferences(
  records: LoadedPreference[],
  options: { maxSyntheticRecords: number; maxSyntheticShare: number },
): LoadedPreference[] {
  const nonSynthetic = records.filter((record) => !record.synthetic);
  const synthetic = records.filter((record) => record.synthetic).slice(0, options.maxSyntheticRecords);
  if (nonSynthetic.length === 0) return synthetic;
  if (options.maxSyntheticShare <= 0) return nonSynthetic;
  const allowedSynthetic = Math.floor((options.maxSyntheticShare * nonSynthetic.length) / (1 - options.maxSyntheticShare));
  return [...nonSynthetic, ...synthetic.slice(0, Math.max(0, allowedSynthetic))];
}

function splitPreferences(records: LoadedPreference[], validationRatio: number): {
  train: LoadedPreference[];
  validation: LoadedPreference[];
} {
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length <= 1 || validationRatio <= 0) return { train: sorted, validation: [] };
  const validationCount = Math.max(1, Math.floor(sorted.length * validationRatio));
  const validation = sorted.slice(0, validationCount);
  const train = sorted.slice(validationCount);
  return { train, validation };
}

function toOutputRecord(record: LoadedPreference, split: "train" | "validation" | "all"): RawDpoRecord {
  return {
    prompt: record.prompt,
    chosen: record.chosen,
    rejected: record.rejected,
    metadata: {
      ...record.metadata,
      split,
      preferenceHash: stableHash(`${record.prompt}\n${record.chosen}\n${record.rejected}`),
    },
  };
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function writeJsonl(path: string, rows: unknown[]): Promise<PreferenceOutputFile> {
  const body = rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  await writeFile(path, body, "utf8");
  return fileInfo(path, rows.length);
}

async function fileInfo(path: string, lines: number): Promise<PreferenceOutputFile> {
  const body = await readFile(path);
  return {
    path,
    lines,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function countLines(input: string): number {
  return input.length === 0 ? 0 : input.split("\n").length;
}
