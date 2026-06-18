import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { z } from "zod";

export type ExternalDatasetSourceId = "dolly" | "oasst1_ready";

export interface ExternalDatasetBuildOptions {
  rawDir: string;
  outDir: string;
  sources?: ExternalDatasetSourceId[];
  maxPerSource?: number;
  validationRatio?: number;
  maxCharsPerExample?: number;
  evalSeedSize?: number;
  evalSeedNgramSize?: number;
  evalSeedOverlapThreshold?: number;
  systemPrompt?: string;
}

export interface ExternalDatasetBuildSummary {
  totalRaw: number;
  accepted: number;
  train: number;
  validation: number;
  evalSeed: number;
  evalSeedBySource: Record<string, number>;
  evalSeedSkippedHighOverlap: number;
  skipped: Record<string, number>;
  bySource: Record<string, { raw: number; accepted: number }>;
  files: Array<{ path: string; lines: number; bytes: number; sha256: string }>;
}

interface CandidateExample {
  id: string;
  source: ExternalDatasetSourceId;
  license: string;
  user: string;
  assistant: string;
  metadata: Record<string, unknown>;
}

interface ChatMlRecord {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  metadata: {
    id: string;
    source: ExternalDatasetSourceId;
    license: string;
    split: "train" | "validation";
  } & Record<string, unknown>;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, concise assistant for a local Discord AI platform. Answer clearly, avoid making up tool results, and ask a short clarification question when the request is underspecified.";

const DATASET_LICENSES: Record<ExternalDatasetSourceId, string> = {
  dolly: "cc-by-sa-3.0",
  oasst1_ready: "apache-2.0",
};

const dollySchema = z
  .object({
    instruction: z.string(),
    context: z.string().nullable().optional(),
    response: z.string(),
    category: z.string().optional(),
  })
  .passthrough();

const oasstMessageSchema = z
  .object({
    message_id: z.string(),
    parent_id: z.string().nullable(),
    text: z.string(),
    role: z.enum(["prompter", "assistant"]),
    lang: z.string().optional(),
    review_result: z.boolean().nullable().optional(),
    deleted: z.boolean().nullable().optional(),
    rank: z.number().nullable().optional(),
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

export async function buildExternalSftDataset(
  options: ExternalDatasetBuildOptions,
): Promise<ExternalDatasetBuildSummary> {
  const sources = options.sources ?? ["dolly", "oasst1_ready"];
  const maxPerSource = options.maxPerSource ?? 2_000;
  const validationRatio = options.validationRatio ?? 0.08;
  const maxCharsPerExample = options.maxCharsPerExample ?? 6_000;
  const evalSeedSize = options.evalSeedSize ?? 200;
  const evalSeedNgramSize = options.evalSeedNgramSize ?? 13;
  const evalSeedOverlapThreshold = options.evalSeedOverlapThreshold ?? 0.8;
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const skipped: Record<string, number> = {};
  const bySource: Record<string, { raw: number; accepted: number }> = {};
  const seen = new Set<string>();
  const accepted: CandidateExample[] = [];

  const addSkip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const source of sources) {
    bySource[source] = { raw: 0, accepted: 0 };
    const candidates =
      source === "dolly"
        ? readDollyExamples(join(options.rawDir, "databricks-dolly-15k.jsonl"))
        : readOasstReadyExamples(join(options.rawDir, "2023-04-12_oasst_ready.messages.jsonl.gz"));

    for await (const candidate of candidates) {
      bySource[source].raw++;
      if (bySource[source].accepted >= maxPerSource) {
        addSkip(`${source}:over-source-cap`);
        continue;
      }
      const checked = validateCandidate(candidate, maxCharsPerExample);
      if (!checked.ok) {
        addSkip(`${source}:${checked.reason}`);
        continue;
      }
      const dedupeKey = stableHash(`${normalizeForDedupe(candidate.user)}\n${normalizeForDedupe(candidate.assistant)}`);
      if (seen.has(dedupeKey)) {
        addSkip(`${source}:duplicate`);
        continue;
      }
      seen.add(dedupeKey);
      bySource[source].accepted++;
      accepted.push(candidate);
    }
  }

  accepted.sort((a, b) => a.id.localeCompare(b.id));

  const train: ChatMlRecord[] = [];
  const validation: ChatMlRecord[] = [];
  for (const example of accepted) {
    const split = splitForId(example.id, validationRatio);
    const record: ChatMlRecord = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: example.user },
        { role: "assistant", content: example.assistant },
      ],
      metadata: {
        id: example.id,
        source: example.source,
        license: example.license,
        split,
        ...example.metadata,
      },
    };
    if (split === "validation") validation.push(record);
    else train.push(record);
  }

  await mkdir(options.outDir, { recursive: true });
  const all = [...train, ...validation].sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
  const evalSeedSelection = selectBalancedEvalSeed(validation, {
    maxRecords: evalSeedSize,
    trainRecords: train,
    ngramSize: evalSeedNgramSize,
    overlapThreshold: evalSeedOverlapThreshold,
  });
  const evalSeedRecords = evalSeedSelection.records;
  const evalSeed = evalSeedRecords.map((record) => ({
    id: record.metadata.id,
    source: record.metadata.source,
    prompt: record.messages.find((m) => m.role === "user")?.content ?? "",
    expected: record.messages.find((m) => m.role === "assistant")?.content ?? "",
  }));

  const files = [
    await writeJsonl(join(options.outDir, "sft.train.jsonl"), train),
    await writeJsonl(join(options.outDir, "sft.validation.jsonl"), validation),
    await writeJsonl(join(options.outDir, "sft.all.jsonl"), all),
    await writeJsonl(join(options.outDir, "eval.seed.jsonl"), evalSeed),
  ];

  const summary: ExternalDatasetBuildSummary = {
    totalRaw: Object.values(bySource).reduce((sum, item) => sum + item.raw, 0),
    accepted: accepted.length,
    train: train.length,
    validation: validation.length,
    evalSeed: evalSeed.length,
    evalSeedBySource: countBy(evalSeed.map((record) => record.source)),
    evalSeedSkippedHighOverlap: evalSeedSelection.skippedHighOverlap,
    skipped,
    bySource,
    files,
  };

  const reportPath = join(options.outDir, "dataset_report.json");
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  summary.files.push(await fileInfo(reportPath, countLines(JSON.stringify(summary, null, 2))));
  return summary;
}

async function* readDollyExamples(path: string): AsyncGenerator<CandidateExample> {
  for await (const { line, index } of readJsonLines(path)) {
    const parsed = dollySchema.safeParse(line);
    if (!parsed.success) continue;
    const row = parsed.data;
    const context = cleanText(row.context ?? "");
    const instruction = cleanText(row.instruction);
    const user = context ? `${instruction}\n\nContext:\n${context}` : instruction;
    yield {
      id: `dolly:${index}`,
      source: "dolly",
      license: DATASET_LICENSES.dolly,
      user,
      assistant: cleanText(row.response),
      metadata: { category: row.category ?? null },
    };
  }
}

async function* readOasstReadyExamples(path: string): AsyncGenerator<CandidateExample> {
  const prompts = new Map<string, { text: string; lang: string | null }>();
  const assistants: Array<z.infer<typeof oasstMessageSchema>> = [];

  for await (const { line } of readJsonLines(path)) {
    const parsed = oasstMessageSchema.safeParse(line);
    if (!parsed.success) continue;
    const row = parsed.data;
    if (!isReviewedExportable(row)) continue;
    if (row.role === "prompter") {
      prompts.set(row.message_id, { text: cleanText(row.text), lang: row.lang ?? null });
    } else {
      assistants.push(row);
    }
  }

  for (const row of assistants) {
    if (row.lang !== "en") continue;
    if (row.rank !== null && row.rank !== undefined && row.rank !== 0) continue;
    const parent = row.parent_id ? prompts.get(row.parent_id) : null;
    if (!parent || parent.lang !== "en") continue;
    yield {
      id: `oasst1_ready:${row.message_id}`,
      source: "oasst1_ready",
      license: DATASET_LICENSES.oasst1_ready,
      user: parent.text,
      assistant: cleanText(row.text),
      metadata: {
        parentId: row.parent_id,
        rank: row.rank ?? null,
      },
    };
  }
}

async function* readJsonLines(path: string): AsyncGenerator<{ line: unknown; index: number }> {
  await stat(path);
  const input = path.endsWith(".gz") ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
  const rl = createInterface({ input, crlfDelay: Infinity });
  let index = 0;

  for await (const raw of rl) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      yield { line: JSON.parse(trimmed) as unknown, index };
    } finally {
      index++;
    }
  }
}

function isReviewedExportable(row: z.infer<typeof oasstMessageSchema>): boolean {
  return row.deleted !== true && row.review_result === true && row.text.trim().length > 0;
}

function validateCandidate(
  candidate: CandidateExample,
  maxCharsPerExample: number,
): { ok: true } | { ok: false; reason: string } {
  if (candidate.user.length < 3 || candidate.assistant.length < 3) return { ok: false, reason: "too-short" };
  if (candidate.user.length + candidate.assistant.length > maxCharsPerExample) {
    return { ok: false, reason: "too-long" };
  }
  const combined = `${candidate.user}\n${candidate.assistant}`;
  if (secretPatterns.some((pattern) => pattern.test(combined))) return { ok: false, reason: "sensitive" };
  return { ok: true };
}

function splitForId(id: string, validationRatio: number): "train" | "validation" {
  const hash = stableHash(id);
  const bucket = Number.parseInt(hash.slice(0, 8), 16) / 0xffffffff;
  return bucket < validationRatio ? "validation" : "train";
}

function selectBalancedEvalSeed(
  records: ChatMlRecord[],
  options: {
    maxRecords: number;
    trainRecords: ChatMlRecord[];
    ngramSize: number;
    overlapThreshold: number;
  },
): { records: ChatMlRecord[]; skippedHighOverlap: number } {
  if (options.maxRecords <= 0) return { records: [], skippedHighOverlap: 0 };
  const buckets = new Map<string, ChatMlRecord[]>();
  for (const record of [...records].sort((a, b) => a.metadata.id.localeCompare(b.metadata.id))) {
    const bucket = buckets.get(record.metadata.source) ?? [];
    bucket.push(record);
    buckets.set(record.metadata.source, bucket);
  }

  const sources = [...buckets.keys()].sort();
  const selected: ChatMlRecord[] = [];
  const trainNgramIndex = buildTrainNgramIndex(options.trainRecords, options.ngramSize);
  let skippedHighOverlap = 0;
  while (selected.length < options.maxRecords) {
    let added = false;
    for (const source of sources) {
      const next = buckets.get(source)?.shift();
      if (!next) continue;
      if (hasHighTrainOverlap(next, trainNgramIndex, options.ngramSize, options.overlapThreshold)) {
        skippedHighOverlap++;
        added = true;
        continue;
      }
      selected.push(next);
      added = true;
      if (selected.length >= options.maxRecords) break;
    }
    if (!added) break;
  }
  return { records: selected, skippedHighOverlap };
}

function buildTrainNgramIndex(records: ChatMlRecord[], ngramSize: number): Map<string, number[]> {
  const index = new Map<string, number[]>();
  records.forEach((record, recordIndex) => {
    for (const ngram of makeNgrams(normalizeForOverlap(recordText(record)), ngramSize)) {
      const matches = index.get(ngram) ?? [];
      matches.push(recordIndex);
      index.set(ngram, matches);
    }
  });
  return index;
}

function hasHighTrainOverlap(
  record: ChatMlRecord,
  trainNgramIndex: Map<string, number[]>,
  ngramSize: number,
  overlapThreshold: number,
): boolean {
  const ngrams = makeNgrams(normalizeForOverlap(recordText(record)), ngramSize);
  if (ngrams.size === 0) return false;
  const overlapCounts = new Map<number, number>();
  for (const ngram of ngrams) {
    for (const trainIndex of trainNgramIndex.get(ngram) ?? []) {
      overlapCounts.set(trainIndex, (overlapCounts.get(trainIndex) ?? 0) + 1);
    }
  }
  for (const shared of overlapCounts.values()) {
    if (shared / ngrams.size >= overlapThreshold) return true;
  }
  return false;
}

function makeNgrams(normalizedText: string, ngramSize: number): Set<string> {
  const tokens = normalizedText.split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (tokens.length < ngramSize) return out;
  for (let index = 0; index <= tokens.length - ngramSize; index++) {
    out.add(tokens.slice(index, index + ngramSize).join(" "));
  }
  return out;
}

function recordText(record: ChatMlRecord): string {
  return record.messages
    .filter((message) => message.role !== "system")
    .map((message) => message.content)
    .join("\n");
}

function normalizeForOverlap(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeForDedupe(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function cleanText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

async function writeJsonl(path: string, rows: unknown[]): Promise<{ path: string; lines: number; bytes: number; sha256: string }> {
  const body = rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  await writeFile(path, body, "utf8");
  return fileInfo(path, rows.length);
}

async function fileInfo(path: string, lines: number): Promise<{ path: string; lines: number; bytes: number; sha256: string }> {
  const body = await readFile(path);
  return {
    path,
    lines,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function countLines(input: string): number {
  return input.length === 0 ? 0 : input.split("\n").length;
}

export function describeExternalDatasetInputs(rawDir: string): Array<{ source: ExternalDatasetSourceId; path: string }> {
  return [
    { source: "dolly", path: join(rawDir, "databricks-dolly-15k.jsonl") },
    { source: "oasst1_ready", path: join(rawDir, "2023-04-12_oasst_ready.messages.jsonl.gz") },
  ];
}

export function externalDatasetBasename(source: ExternalDatasetSourceId): string {
  const input = describeExternalDatasetInputs(".").find((item) => item.source === source);
  return input ? basename(input.path) : source;
}
