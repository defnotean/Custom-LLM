import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvalLatencyStats } from "./ToolEvalSuite";

export interface KnowledgeEvalCase {
  id: string;
  source: string;
  prompt: string;
  expected: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeEvalSuiteSummary {
  path: string;
  cases: number;
  bySource: Record<string, number>;
  sha256: string;
}

export interface KnowledgePrediction {
  id: string;
  output: string;
  model?: string;
  latencyMs?: number;
}

export interface KnowledgeEvalReport {
  suitePath: string;
  predictionsPath: string;
  total: number;
  answered: number;
  answerRate: number;
  exactMatchRate: number;
  averageTokenF1: number;
  averageRougeL: number;
  missingPredictions: number;
  lowScoreCount: number;
  latencyMs: EvalLatencyStats;
  bySource: Record<string, { total: number; averageTokenF1: number; averageRougeL: number }>;
  failures: Array<{ id: string; reason: string; output?: string; expected?: string }>;
}

export interface BuildKnowledgeEvalOptions {
  inputPath: string;
  outPath: string;
  maxCases?: number;
  minExpectedChars?: number;
  maxPromptChars?: number;
}

export interface EvaluateKnowledgeOptions {
  suitePath: string;
  predictionsPath: string;
  lowScoreThreshold?: number;
}

interface LoadedSeed {
  id: string;
  source: string;
  prompt: string;
  expected: string;
  metadata: Record<string, unknown>;
}

export async function writeKnowledgeEvalSuite(options: BuildKnowledgeEvalOptions): Promise<KnowledgeEvalSuiteSummary> {
  const minExpectedChars = options.minExpectedChars ?? 3;
  const maxPromptChars = options.maxPromptChars ?? 8_000;
  const raw = await readJsonl(options.inputPath);
  const seen = new Set<string>();
  const cases: KnowledgeEvalCase[] = [];

  for (const item of raw) {
    const parsed = normalizeSeed(item);
    if (!parsed) continue;
    if (parsed.expected.length < minExpectedChars || parsed.prompt.length > maxPromptChars) continue;
    const key = stableHash(`${parsed.prompt}\n${parsed.expected}`);
    if (seen.has(parsed.id) || seen.has(key)) continue;
    seen.add(parsed.id);
    seen.add(key);
    cases.push({
      id: parsed.id,
      source: parsed.source,
      prompt: parsed.prompt,
      expected: parsed.expected,
      metadata: {
        ...parsed.metadata,
        source: parsed.source,
        expectedHash: stableHash(parsed.expected),
      },
    });
    if (options.maxCases !== undefined && cases.length >= options.maxCases) break;
  }

  await mkdir(dirname(options.outPath), { recursive: true });
  const body = `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`;
  await writeFile(options.outPath, body, "utf8");
  return {
    path: options.outPath,
    cases: cases.length,
    bySource: countBy(cases.map((item) => item.source)),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

export async function makeKnowledgeOraclePredictions(
  suitePath: string,
  outPath: string,
): Promise<{ outPath: string; predictions: number }> {
  const cases = (await readJsonl(suitePath)) as KnowledgeEvalCase[];
  const predictions = cases.map((item) => ({
    id: item.id,
    output: item.expected,
    model: "oracle",
  }));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${predictions.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return { outPath, predictions: predictions.length };
}

export async function evaluateKnowledgePredictions(options: EvaluateKnowledgeOptions): Promise<KnowledgeEvalReport> {
  const cases = (await readJsonl(options.suitePath)) as KnowledgeEvalCase[];
  const predictions = (await readJsonl(options.predictionsPath)) as KnowledgePrediction[];
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  const threshold = options.lowScoreThreshold ?? 0.35;
  const failures: KnowledgeEvalReport["failures"] = [];
  const bySourceAccum = new Map<string, { total: number; tokenF1: number; rougeL: number }>();
  const latencyValues = predictions
    .map((prediction) => prediction.latencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);

  let answered = 0;
  let exact = 0;
  let tokenF1Sum = 0;
  let rougeLSum = 0;
  let missing = 0;
  let lowScore = 0;

  for (const item of cases) {
    const prediction = byId.get(item.id);
    const source = bySourceAccum.get(item.source) ?? { total: 0, tokenF1: 0, rougeL: 0 };
    source.total++;
    bySourceAccum.set(item.source, source);

    if (!prediction) {
      missing++;
      failures.push({ id: item.id, reason: "missing prediction", expected: item.expected });
      continue;
    }

    const output = prediction.output.trim();
    const tokenF1 = scoreTokenF1(output, item.expected);
    const rougeL = scoreRougeL(output, item.expected);
    const isReferenceSupported = Math.max(tokenF1, rougeL) >= threshold;
    const isAnswered = output.length > 0 && (!looksLikeNonAnswer(output) || isReferenceSupported);
    if (isAnswered) answered++;
    else failures.push({ id: item.id, reason: "empty or non-answer", output, expected: item.expected });

    tokenF1Sum += tokenF1;
    rougeLSum += rougeL;
    source.tokenF1 += tokenF1;
    source.rougeL += rougeL;

    if (normalizeText(output) === normalizeText(item.expected)) exact++;
    if (Math.max(tokenF1, rougeL) < threshold) {
      lowScore++;
      failures.push({
        id: item.id,
        reason: `low reference overlap: tokenF1=${tokenF1.toFixed(3)}, rougeL=${rougeL.toFixed(3)}`,
        output,
        expected: item.expected,
      });
    }
  }

  return {
    suitePath: options.suitePath,
    predictionsPath: options.predictionsPath,
    total: cases.length,
    answered,
    answerRate: ratio(answered, cases.length),
    exactMatchRate: ratio(exact, cases.length),
    averageTokenF1: ratioRaw(tokenF1Sum, cases.length),
    averageRougeL: ratioRaw(rougeLSum, cases.length),
    missingPredictions: missing,
    lowScoreCount: lowScore,
    latencyMs: latencyStats(latencyValues),
    bySource: Object.fromEntries(
      [...bySourceAccum.entries()].map(([source, stats]) => [
        source,
        {
          total: stats.total,
          averageTokenF1: ratioRaw(stats.tokenF1, stats.total),
          averageRougeL: ratioRaw(stats.rougeL, stats.total),
        },
      ]),
    ),
    failures: failures.slice(0, 100),
  };
}

function normalizeSeed(raw: unknown): LoadedSeed | null {
  if (!isRecord(raw)) return null;
  const directId = typeof raw.id === "string" ? raw.id : "";
  const directSource = typeof raw.source === "string" ? raw.source : "unknown";
  const directPrompt = typeof raw.prompt === "string" ? raw.prompt : "";
  const directExpected = typeof raw.expected === "string" ? raw.expected : "";
  if (directId && directPrompt && directExpected) {
    return {
      id: directId,
      source: directSource,
      prompt: cleanText(directPrompt),
      expected: cleanText(directExpected),
      metadata: {},
    };
  }

  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const id = typeof metadata.id === "string" ? metadata.id : "";
  const source = typeof metadata.source === "string" ? metadata.source : "unknown";
  const prompt = findMessageContent(messages, "user");
  const expected = findLastMessageContent(messages, "assistant");
  if (!id || !prompt || !expected) return null;
  return {
    id,
    source,
    prompt: cleanText(prompt),
    expected: cleanText(expected),
    metadata,
  };
}

function findMessageContent(messages: unknown[], role: string): string {
  for (const message of messages) {
    if (isRecord(message) && message.role === role && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

function findLastMessageContent(messages: unknown[], role: string): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isRecord(message) && message.role === role && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

function scoreTokenF1(output: string, expected: string): number {
  const outputTokens = tokenize(output);
  const expectedTokens = tokenize(expected);
  if (outputTokens.length === 0 || expectedTokens.length === 0) return 0;
  const outputCounts = tokenCounts(outputTokens);
  const expectedCounts = tokenCounts(expectedTokens);
  let overlap = 0;
  for (const [token, expectedCount] of expectedCounts.entries()) {
    overlap += Math.min(outputCounts.get(token) ?? 0, expectedCount);
  }
  if (overlap === 0) return 0;
  const precision = overlap / outputTokens.length;
  const recall = overlap / expectedTokens.length;
  return Number(((2 * precision * recall) / (precision + recall)).toFixed(6));
}

function scoreRougeL(output: string, expected: string): number {
  const outputTokens = tokenize(output);
  const expectedTokens = tokenize(expected);
  if (outputTokens.length === 0 || expectedTokens.length === 0) return 0;
  const lcs = longestCommonSubsequenceLength(outputTokens, expectedTokens);
  return Number((lcs / expectedTokens.length).toFixed(6));
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  const previous = new Array<number>(b.length + 1).fill(0);
  const current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? (previous[j - 1] ?? 0) + 1 : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    previous.splice(0, previous.length, ...current);
    current.fill(0);
  }
  return previous[b.length] ?? 0;
}

function looksLikeNonAnswer(output: string): boolean {
  const normalized = normalizeText(output);
  return [
    "i don't know",
    "i do not know",
    "i cannot answer",
    "i can't answer",
    "not enough information",
    "as an ai",
  ].some((phrase) => normalized.includes(phrase));
}

function tokenCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function latencyStats(values: number[]): EvalLatencyStats {
  if (values.length === 0) return { count: 0, average: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: sorted.length,
    average: Number((sum / sorted.length).toFixed(3)),
    p95: Number((sorted[p95Index] ?? 0).toFixed(3)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
  };
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function ratioRaw(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
