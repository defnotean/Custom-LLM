import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

const messageSchema = z
  .object({
    role: z.string().min(1),
    content: z.string().min(1),
  })
  .passthrough();

const chatRecordSchema = z
  .object({
    messages: z.array(messageSchema).min(1),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export interface SequenceStatsOptions {
  trainPath: string;
  validationPath: string;
  sequenceLength?: number;
  topLongest?: number;
  outPath?: string;
}

export interface SplitSequenceStats {
  path: string;
  records: number;
  estimatedTokens: number;
  estimatedAssistantTokens: number;
  averageTokens: number;
  p50Tokens: number;
  p90Tokens: number;
  p95Tokens: number;
  p99Tokens: number;
  maxTokens: number;
  p95TokenBudgetUsage: number;
  maxTokenBudgetUsage: number;
  overLengthRecords: number;
  overLengthRate: number;
  estimatedPackedSequences: number;
  packingEfficiency: number;
  longest: LongRecordSummary[];
}

export interface LongRecordSummary {
  id: string;
  source: string;
  estimatedTokens: number;
  estimatedAssistantTokens: number;
  roles: string[];
}

export interface TrainingMixtureSequenceReport {
  generatedAt: string;
  tokenizerEstimate: "regex-chatml-v1";
  sequenceLength: number;
  train: SplitSequenceStats;
  validation: SplitSequenceStats;
  total: {
    records: number;
    estimatedTokens: number;
    estimatedAssistantTokens: number;
    estimatedPackedSequences: number;
    packingEfficiency: number;
  };
}

interface RecordStats extends LongRecordSummary {
  messageCount: number;
}

const TOKEN_RE = /<\|[^|]+\|>|[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

export async function analyzeTrainingMixtureSequences(
  options: SequenceStatsOptions,
): Promise<TrainingMixtureSequenceReport> {
  const sequenceLength = options.sequenceLength ?? 2048;
  if (!Number.isInteger(sequenceLength) || sequenceLength <= 0) {
    throw new Error(`sequenceLength must be a positive integer; got ${sequenceLength}`);
  }
  const topLongest = options.topLongest ?? 10;
  const train = await analyzeSplit(options.trainPath, sequenceLength, topLongest);
  const validation = await analyzeSplit(options.validationPath, sequenceLength, topLongest);
  const totalTokens = train.estimatedTokens + validation.estimatedTokens;
  const totalPackedSequences = train.estimatedPackedSequences + validation.estimatedPackedSequences;

  const report: TrainingMixtureSequenceReport = {
    generatedAt: new Date().toISOString(),
    tokenizerEstimate: "regex-chatml-v1",
    sequenceLength,
    train,
    validation,
    total: {
      records: train.records + validation.records,
      estimatedTokens: totalTokens,
      estimatedAssistantTokens: train.estimatedAssistantTokens + validation.estimatedAssistantTokens,
      estimatedPackedSequences: totalPackedSequences,
      packingEfficiency: packingEfficiency(totalTokens, totalPackedSequences, sequenceLength),
    },
  };

  if (options.outPath) {
    await writeFile(options.outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

export function estimateChatMlTokens(messages: Array<{ role: string; content: string }>): {
  estimatedTokens: number;
  estimatedAssistantTokens: number;
} {
  let total = 2; // bos/eos-style envelope overhead.
  let assistant = 0;
  for (const message of messages) {
    const roleTokens = estimateTextTokens(`<|${message.role}|>`);
    const contentTokens = estimateTextTokens(message.content);
    const messageOverhead = 3;
    total += messageOverhead + roleTokens + contentTokens;
    if (message.role === "assistant") assistant += contentTokens;
  }
  total += estimateTextTokens("<|end|>");
  return { estimatedTokens: total, estimatedAssistantTokens: assistant };
}

export function estimateTextTokens(text: string): number {
  const regexTokens = text.match(TOKEN_RE)?.length ?? 0;
  const nonAsciiBytes = [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 127 ? 1 : 0), 0);
  return regexTokens + Math.ceil(nonAsciiBytes / 3);
}

async function analyzeSplit(path: string, sequenceLength: number, topLongest: number): Promise<SplitSequenceStats> {
  const records = await loadRecordStats(path);
  const tokenCounts = records.map((record) => record.estimatedTokens).sort((left, right) => left - right);
  const totalTokens = records.reduce((sum, record) => sum + record.estimatedTokens, 0);
  const totalAssistantTokens = records.reduce((sum, record) => sum + record.estimatedAssistantTokens, 0);
  const overLengthRecords = records.filter((record) => record.estimatedTokens > sequenceLength).length;
  const packedSequences = Math.ceil(totalTokens / sequenceLength);

  return {
    path,
    records: records.length,
    estimatedTokens: totalTokens,
    estimatedAssistantTokens: totalAssistantTokens,
    averageTokens: records.length === 0 ? 0 : round(totalTokens / records.length),
    p50Tokens: percentile(tokenCounts, 0.5),
    p90Tokens: percentile(tokenCounts, 0.9),
    p95Tokens: percentile(tokenCounts, 0.95),
    p99Tokens: percentile(tokenCounts, 0.99),
    maxTokens: tokenCounts.at(-1) ?? 0,
    p95TokenBudgetUsage: budgetUsage(percentile(tokenCounts, 0.95), sequenceLength),
    maxTokenBudgetUsage: budgetUsage(tokenCounts.at(-1) ?? 0, sequenceLength),
    overLengthRecords,
    overLengthRate: records.length === 0 ? 0 : round(overLengthRecords / records.length),
    estimatedPackedSequences: packedSequences,
    packingEfficiency: packingEfficiency(totalTokens, packedSequences, sequenceLength),
    longest: records
      .sort((left, right) => right.estimatedTokens - left.estimatedTokens)
      .slice(0, topLongest)
      .map(({ id, source, estimatedTokens, estimatedAssistantTokens, roles }) => ({
        id,
        source,
        estimatedTokens,
        estimatedAssistantTokens,
        roles,
      })),
  };
}

async function loadRecordStats(path: string): Promise<RecordStats[]> {
  const body = await readFile(path, "utf8");
  const out: RecordStats[] = [];
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let index = 0; index < lines.length; index++) {
    const raw = JSON.parse(lines[index] ?? "{}") as unknown;
    const parsed = chatRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid ChatML record in ${path}:${index + 1}: ${parsed.error.message}`);
    }
    const metadata = parsed.data.metadata ?? {};
    const id = typeof metadata.id === "string" ? metadata.id : `${path}:${index + 1}`;
    const source = typeof metadata.source === "string" ? metadata.source : "unknown";
    const messages = parsed.data.messages.map((message) => ({ role: message.role, content: message.content }));
    const { estimatedTokens, estimatedAssistantTokens } = estimateChatMlTokens(messages);
    out.push({
      id,
      source,
      estimatedTokens,
      estimatedAssistantTokens,
      roles: messages.map((message) => message.role),
      messageCount: messages.length,
    });
  }
  return out;
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[index] ?? 0;
}

function packingEfficiency(totalTokens: number, packedSequences: number, sequenceLength: number): number {
  if (totalTokens === 0 || packedSequences === 0) return 0;
  return round(totalTokens / (packedSequences * sequenceLength));
}

function budgetUsage(tokens: number, sequenceLength: number): number {
  if (tokens === 0) return 0;
  return round(tokens / sequenceLength);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
