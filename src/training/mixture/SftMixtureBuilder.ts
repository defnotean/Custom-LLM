import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { estimateChatMlTokens } from "../quality/TrainingMixtureSequenceStats";

const messageSchema = z
  .object({
    role: z.string().min(1),
    content: z.string().min(1),
    name: z.string().optional(),
  })
  .passthrough();

const chatRecordSchema = z
  .object({
    messages: z.array(messageSchema).min(2),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

type ChatRecord = z.infer<typeof chatRecordSchema>;

export interface MixtureSource {
  name: string;
  path: string;
  required: boolean;
  maxRecords?: number;
  kind?: "open_sft" | "bot_log" | "tool_calling" | "synthetic";
}

export interface SftMixtureOptions {
  outDir: string;
  trainSources: MixtureSource[];
  validationSources: MixtureSource[];
  maxSyntheticShare?: number;
  maxEstimatedTokens?: number;
}

export interface MixtureSourceSummary {
  name: string;
  path: string;
  required: boolean;
  present: boolean;
  kind: string;
  raw: number;
  accepted: number;
  skipped: number;
  skippedOverLength?: number;
  reason?: string;
}

export interface MixtureOutputFile {
  path: string;
  lines: number;
  bytes: number;
  sha256: string;
}

export interface SftMixtureReport {
  generatedAt: string;
  train: number;
  validation: number;
  maxSyntheticShare: number;
  maxEstimatedTokens: number;
  syntheticTrainShare: number;
  sources: MixtureSourceSummary[];
  files: MixtureOutputFile[];
}

interface LoadedRecord {
  id: string;
  source: string;
  kind: string;
  record: ChatRecord;
}

export async function buildSftMixture(options: SftMixtureOptions): Promise<SftMixtureReport> {
  const maxSyntheticShare = options.maxSyntheticShare ?? 0.2;
  const maxEstimatedTokens = options.maxEstimatedTokens ?? 2048;
  const sourceSummaries: MixtureSourceSummary[] = [];
  const train = await loadSources(options.trainSources, "train", sourceSummaries, maxEstimatedTokens);
  const validation = await loadSources(options.validationSources, "validation", sourceSummaries, maxEstimatedTokens);

  const cappedTrain = capSyntheticShare(dedupeStable(train), maxSyntheticShare);
  const cappedValidation = dedupeStable(validation);
  const syntheticTrain = cappedTrain.filter((item) => item.kind === "synthetic").length;

  await mkdir(options.outDir, { recursive: true });
  const trainPath = join(options.outDir, "production-sft.train.jsonl");
  const validationPath = join(options.outDir, "production-sft.validation.jsonl");
  const allPath = join(options.outDir, "production-sft.all.jsonl");

  const files = [
    await writeJsonl(trainPath, cappedTrain.map((item) => item.record)),
    await writeJsonl(validationPath, cappedValidation.map((item) => item.record)),
    await writeJsonl(allPath, [...cappedTrain, ...cappedValidation].map((item) => item.record)),
  ];

  const report: SftMixtureReport = {
    generatedAt: new Date().toISOString(),
    train: cappedTrain.length,
    validation: cappedValidation.length,
    maxSyntheticShare,
    maxEstimatedTokens,
    syntheticTrainShare: cappedTrain.length > 0 ? syntheticTrain / cappedTrain.length : 0,
    sources: sourceSummaries,
    files,
  };
  const reportPath = join(options.outDir, "production-sft.report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  report.files.push(await fileInfo(reportPath, countLines(JSON.stringify(report, null, 2))));
  return report;
}

export function defaultSftMixtureOptions(outDir = "training/data/mixtures"): SftMixtureOptions {
  return {
    outDir,
    maxSyntheticShare: 0.2,
    maxEstimatedTokens: 2048,
    trainSources: [
      {
        name: "open_sft_train",
        path: "training/data/processed/sft.train.jsonl",
        required: true,
        kind: "open_sft",
      },
      {
        name: "bot_chatml_train",
        path: "exports/training/chatml.jsonl",
        required: false,
        kind: "bot_log",
      },
      {
        name: "bot_tool_calling_train",
        path: "exports/training/tool-calling.jsonl",
        required: false,
        kind: "tool_calling",
      },
      {
        name: "synthetic_tool_train",
        path: "exports/training/synthetic-tools.jsonl",
        required: false,
        kind: "synthetic",
        maxRecords: 2_000,
      },
    ],
    validationSources: [
      {
        name: "open_sft_validation",
        path: "training/data/processed/sft.validation.jsonl",
        required: true,
        kind: "open_sft",
      },
      {
        name: "bot_eval_seed",
        path: "training/data/processed/eval.seed.jsonl",
        required: false,
        kind: "bot_log",
      },
    ],
  };
}

async function loadSources(
  sources: MixtureSource[],
  split: "train" | "validation",
  summaries: MixtureSourceSummary[],
  maxEstimatedTokens: number,
): Promise<LoadedRecord[]> {
  const out: LoadedRecord[] = [];
  for (const source of sources) {
    const kind = source.kind ?? "open_sft";
    const exists = await pathExists(source.path);
    const summary: MixtureSourceSummary = {
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
      if (source.required) throw new Error(`Required mixture source is missing: ${source.path}`);
      continue;
    }

    const lines = await readJsonl(source.path);
    summary.raw = lines.length;
    for (let index = 0; index < lines.length; index++) {
      if (source.maxRecords !== undefined && summary.accepted >= source.maxRecords) {
        summary.skipped++;
        continue;
      }
      const normalized = normalizeRecord(lines[index], source, split, index);
      if (!normalized) {
        summary.skipped++;
        continue;
      }
      const tokenEstimate = estimateChatMlTokens(normalized.record.messages);
      if (tokenEstimate.estimatedTokens > maxEstimatedTokens) {
        summary.skipped++;
        summary.skippedOverLength = (summary.skippedOverLength ?? 0) + 1;
        continue;
      }
      summary.accepted++;
      out.push(normalized);
    }
  }
  return out;
}

function normalizeRecord(
  raw: unknown,
  source: MixtureSource,
  split: "train" | "validation",
  index: number,
): LoadedRecord | null {
  const kind = source.kind ?? "open_sft";
  const synthetic = syntheticTrainingExampleToChatRecord(raw);
  const candidate = synthetic ?? raw;
  const parsed = chatRecordSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const metadata = parsed.data.metadata ?? {};
  const id = typeof metadata.id === "string" && metadata.id.length > 0
    ? metadata.id
    : `${source.name}:${index}:${stableHash(JSON.stringify(parsed.data.messages)).slice(0, 16)}`;
  const record: ChatRecord = {
    messages: parsed.data.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
    })),
    metadata: {
      ...metadata,
      id,
      source: typeof metadata.source === "string" ? metadata.source : source.name,
      split,
      mixtureSource: source.name,
      mixtureKind: kind,
    },
  };
  return { id, source: source.name, kind, record };
}

function syntheticTrainingExampleToChatRecord(raw: unknown): ChatRecord | null {
  const parsed = z
    .object({
      inputJson: z.object({ systemPrompt: z.string().default(""), userMessage: z.string().default("") }).passthrough(),
      outputJson: z
        .object({
          finalResponse: z.string().default(""),
          toolCall: z
            .object({
              name: z.string(),
              arguments: z.record(z.unknown()).default({}),
              reason: z.string().optional(),
            })
            .nullable()
            .optional(),
          toolResult: z.unknown().optional(),
        })
        .passthrough(),
      metadataJson: z.record(z.unknown()).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return null;
  const input = parsed.data.inputJson;
  const output = parsed.data.outputJson;
  if (!input.userMessage || (!output.finalResponse && !output.toolCall)) return null;

  const messages: ChatRecord["messages"] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.userMessage },
  ];
  if (output.toolCall) {
    messages.push({
      role: "assistant",
      content: JSON.stringify({
        type: "tool_call",
        tool: output.toolCall.name,
        arguments: output.toolCall.arguments,
        ...(output.toolCall.reason ? { reason: output.toolCall.reason } : {}),
      }),
    });
    messages.push({
      role: "tool",
      name: output.toolCall.name,
      content: JSON.stringify(output.toolResult ?? null),
    });
  }
  if (output.finalResponse) messages.push({ role: "assistant", content: output.finalResponse });
  return { messages, metadata: parsed.data.metadataJson ?? {} };
}

function dedupeStable(records: LoadedRecord[]): LoadedRecord[] {
  const seen = new Set<string>();
  const out: LoadedRecord[] = [];
  for (const record of records) {
    const key = stableHash(JSON.stringify(record.record.messages));
    if (seen.has(record.id) || seen.has(key)) continue;
    seen.add(record.id);
    seen.add(key);
    out.push(record);
  }
  return out;
}

function capSyntheticShare(records: LoadedRecord[], maxSyntheticShare: number): LoadedRecord[] {
  const nonSynthetic = records.filter((record) => record.kind !== "synthetic");
  const synthetic = records.filter((record) => record.kind === "synthetic");
  if (nonSynthetic.length === 0 || maxSyntheticShare <= 0) return nonSynthetic;
  const allowedSynthetic = Math.floor((maxSyntheticShare * nonSynthetic.length) / (1 - maxSyntheticShare));
  return [...nonSynthetic, ...synthetic.slice(0, Math.max(0, allowedSynthetic))];
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function writeJsonl(path: string, rows: unknown[]): Promise<MixtureOutputFile> {
  const body = rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  await writeFile(path, body, "utf8");
  return fileInfo(path, rows.length);
}

async function fileInfo(path: string, lines: number): Promise<MixtureOutputFile> {
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

export function mixtureBasename(path: string): string {
  return basename(path);
}
