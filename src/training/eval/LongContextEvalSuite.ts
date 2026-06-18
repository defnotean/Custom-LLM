import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvalLatencyStats } from "./ToolEvalSuite";

export type LongContextNeedlePosition = "early" | "middle" | "late";

export interface LongContextEvalCase {
  id: string;
  source: "synthetic-needle-in-context";
  prompt: string;
  expected: string;
  metadata: {
    targetKey: string;
    expectedHash: string;
    targetContextChars: number;
    contextChars: number;
    approxTokens: number;
    needlePosition: LongContextNeedlePosition;
    distractorAnswers: string[];
    longContext: true;
    preferredProvider: "subq";
    architectureTarget: "subquadratic-sparse-attention";
  };
}

export interface LongContextEvalSuiteSummary {
  path: string;
  cases: number;
  contextCharTargets: number[];
  byNeedlePosition: Record<LongContextNeedlePosition, number>;
  sha256: string;
}

export interface LongContextPrediction {
  id: string;
  output: string;
  model?: string;
  latencyMs?: number;
}

export interface LongContextEvalReport {
  suitePath: string;
  predictionsPath: string;
  total: number;
  answered: number;
  answerRate: number;
  exactMatchRate: number;
  expectedContainRate: number;
  missingPredictions: number;
  falsePositiveCount: number;
  falsePositiveRate: number;
  latencyMs: EvalLatencyStats;
  byNeedlePosition: Record<LongContextNeedlePosition, LongContextBucketStats>;
  byContextTarget: Record<string, LongContextBucketStats>;
  failures: Array<{ id: string; reason: string; output?: string; expected?: string }>;
}

export interface LongContextBucketStats {
  total: number;
  exactMatchRate: number;
  expectedContainRate: number;
}

export interface BuildLongContextEvalOptions {
  outPath: string;
  contextCharTargets?: number[];
  needlePositions?: LongContextNeedlePosition[];
  maxCases?: number;
}

export interface EvaluateLongContextOptions {
  suitePath: string;
  predictionsPath: string;
}

const DEFAULT_CONTEXT_CHAR_TARGETS = [4_000, 16_000, 64_000];
const DEFAULT_NEEDLE_POSITIONS: LongContextNeedlePosition[] = ["early", "middle", "late"];
const POSITION_RATIOS: Record<LongContextNeedlePosition, number> = {
  early: 0.12,
  middle: 0.5,
  late: 0.88,
};

export async function writeLongContextEvalSuite(
  options: BuildLongContextEvalOptions,
): Promise<LongContextEvalSuiteSummary> {
  const contextCharTargets = validateContextTargets(options.contextCharTargets ?? DEFAULT_CONTEXT_CHAR_TARGETS);
  const needlePositions = options.needlePositions ?? DEFAULT_NEEDLE_POSITIONS;
  const cases: LongContextEvalCase[] = [];

  for (const targetChars of contextCharTargets) {
    for (const position of needlePositions) {
      cases.push(makeLongContextCase({ targetChars, position, ordinal: cases.length + 1 }));
      if (options.maxCases !== undefined && cases.length >= options.maxCases) break;
    }
    if (options.maxCases !== undefined && cases.length >= options.maxCases) break;
  }

  await mkdir(dirname(options.outPath), { recursive: true });
  const body = `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`;
  await writeFile(options.outPath, body, "utf8");
  return {
    path: options.outPath,
    cases: cases.length,
    contextCharTargets,
    byNeedlePosition: countPositions(cases),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

export async function makeLongContextOraclePredictions(
  suitePath: string,
  outPath: string,
): Promise<{ outPath: string; predictions: number }> {
  const cases = (await readJsonl(suitePath)) as LongContextEvalCase[];
  const predictions = cases.map((item) => ({
    id: item.id,
    output: item.expected,
    model: "oracle",
  }));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${predictions.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return { outPath, predictions: predictions.length };
}

export async function evaluateLongContextPredictions(
  options: EvaluateLongContextOptions,
): Promise<LongContextEvalReport> {
  const cases = (await readJsonl(options.suitePath)) as LongContextEvalCase[];
  const predictions = (await readJsonl(options.predictionsPath)) as LongContextPrediction[];
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  const latencyValues = predictions
    .map((prediction) => prediction.latencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const byPosition = initPositionStats();
  const byContext = new Map<string, BucketAccumulator>();
  const failures: LongContextEvalReport["failures"] = [];

  let answered = 0;
  let exact = 0;
  let contains = 0;
  let missing = 0;
  let falsePositiveCount = 0;

  for (const item of cases) {
    const prediction = byId.get(item.id);
    const positionBucket = byPosition.get(item.metadata.needlePosition);
    if (!positionBucket) throw new Error(`Unknown needle position: ${item.metadata.needlePosition}`);
    const contextKey = String(item.metadata.targetContextChars);
    const contextBucket = byContext.get(contextKey) ?? makeBucket();
    byContext.set(contextKey, contextBucket);
    positionBucket.total++;
    contextBucket.total++;

    if (!prediction) {
      missing++;
      failures.push({ id: item.id, reason: "missing prediction", expected: item.expected });
      continue;
    }

    const output = prediction.output.trim();
    const exactMatch = normalizeAnswer(output) === normalizeAnswer(item.expected);
    const containsExpected = normalizeAnswer(output).includes(normalizeAnswer(item.expected));
    const falsePositive = item.metadata.distractorAnswers.some((answer) =>
      normalizeAnswer(output).includes(normalizeAnswer(answer)),
    );

    if (output.length > 0 && !looksLikeNonAnswer(output)) answered++;
    else failures.push({ id: item.id, reason: "empty or non-answer", output, expected: item.expected });

    if (exactMatch) {
      exact++;
      positionBucket.exact++;
      contextBucket.exact++;
    }

    if (containsExpected) {
      contains++;
      positionBucket.contains++;
      contextBucket.contains++;
    } else {
      failures.push({ id: item.id, reason: "expected value not found in output", output, expected: item.expected });
    }

    if (falsePositive) {
      falsePositiveCount++;
      failures.push({ id: item.id, reason: "output included a distractor value", output, expected: item.expected });
    }
  }

  return {
    suitePath: options.suitePath,
    predictionsPath: options.predictionsPath,
    total: cases.length,
    answered,
    answerRate: ratio(answered, cases.length),
    exactMatchRate: ratio(exact, cases.length),
    expectedContainRate: ratio(contains, cases.length),
    missingPredictions: missing,
    falsePositiveCount,
    falsePositiveRate: ratio(falsePositiveCount, cases.length),
    latencyMs: latencyStats(latencyValues),
    byNeedlePosition: Object.fromEntries(
      [...byPosition.entries()].map(([position, stats]) => [position, summarizeBucket(stats)]),
    ) as Record<LongContextNeedlePosition, LongContextBucketStats>,
    byContextTarget: Object.fromEntries(
      [...byContext.entries()].map(([target, stats]) => [target, summarizeBucket(stats)]),
    ),
    failures: failures.slice(0, 100),
  };
}

function makeLongContextCase(input: {
  targetChars: number;
  position: LongContextNeedlePosition;
  ordinal: number;
}): LongContextEvalCase {
  const targetKey = `IRENE_LONG_CONTEXT_TRACE_${input.targetChars}_${input.position.toUpperCase()}_${String(input.ordinal).padStart(2, "0")}`;
  const expected = `LC-${stableHash(targetKey).slice(0, 10).toUpperCase()}-${input.position.toUpperCase()}`;
  const distractorAnswers = Array.from({ length: 8 }, (_, index) =>
    `LC-${stableHash(`${targetKey}:distractor:${index}`).slice(0, 10).toUpperCase()}-DISTRACTOR`,
  );
  const context = buildContext({
    targetChars: input.targetChars,
    position: input.position,
    targetKey,
    expected,
    distractorAnswers,
  });
  const prompt =
    "You are evaluating long-context retrieval for Irene's subquadratic sparse-attention path.\n" +
    "Use only the context block. The context contains many similar distractor trace values.\n" +
    `Return only the exact value assigned to ${targetKey}.\n\n` +
    "<long_context>\n" +
    `${context}\n` +
    "</long_context>\n\n" +
    `Question: What is the exact value assigned to ${targetKey}?`;

  return {
    id: `long-context-${input.targetChars}-${input.position}`,
    source: "synthetic-needle-in-context",
    prompt,
    expected,
    metadata: {
      targetKey,
      expectedHash: stableHash(expected),
      targetContextChars: input.targetChars,
      contextChars: context.length,
      approxTokens: Math.ceil(context.length / 4),
      needlePosition: input.position,
      distractorAnswers,
      longContext: true,
      preferredProvider: "subq",
      architectureTarget: "subquadratic-sparse-attention",
    },
  };
}

function buildContext(input: {
  targetChars: number;
  position: LongContextNeedlePosition;
  targetKey: string;
  expected: string;
  distractorAnswers: string[];
}): string {
  const lineCount = Math.max(24, Math.ceil(input.targetChars / 120));
  const needleIndex = Math.min(lineCount - 1, Math.max(0, Math.floor(lineCount * POSITION_RATIOS[input.position])));
  const distractorEvery = Math.max(3, Math.floor(lineCount / input.distractorAnswers.length));
  const lines: string[] = [];

  for (let index = 0; index < lineCount; index++) {
    if (index === needleIndex) {
      lines.push(`CANONICAL_TRACE ${input.targetKey} = ${input.expected}. This is the only correct answer.`);
      continue;
    }
    const distractorIndex = Math.floor(index / distractorEvery);
    if (distractorIndex < input.distractorAnswers.length && index % distractorEvery === 0) {
      lines.push(
        `DISTRACTOR_TRACE IRENE_LONG_CONTEXT_DISTRACTOR_${input.targetChars}_${index} = ${input.distractorAnswers[distractorIndex]}. Do not use this for the requested key.`,
      );
      continue;
    }
    lines.push(makeFillerLine(input.targetChars, index));
  }

  let context = lines.join("\n");
  let padIndex = 0;
  while (context.length < input.targetChars) {
    context += `\n${makeFillerLine(input.targetChars, lineCount + padIndex)}`;
    padIndex++;
  }
  return context;
}

function makeFillerLine(targetChars: number, index: number): string {
  const topic = ["memory", "tool-use", "voice", "discord", "routing", "retrieval"][index % 6];
  return (
    `context-note-${targetChars}-${String(index).padStart(5, "0")}: ` +
    `Irene records ${topic} observations here, but this line is background noise for the retrieval benchmark.`
  );
}

function validateContextTargets(rawTargets: number[]): number[] {
  if (rawTargets.length === 0) throw new Error("At least one context char target is required");
  const targets = rawTargets.map((target) => {
    if (!Number.isInteger(target) || target < 512) {
      throw new Error(`Context char targets must be integers >= 512; got ${target}`);
    }
    return target;
  });
  return [...new Set(targets)].sort((a, b) => a - b);
}

function initPositionStats(): Map<LongContextNeedlePosition, BucketAccumulator> {
  return new Map(DEFAULT_NEEDLE_POSITIONS.map((position) => [position, makeBucket()]));
}

interface BucketAccumulator {
  total: number;
  exact: number;
  contains: number;
}

function makeBucket(): BucketAccumulator {
  return { total: 0, exact: 0, contains: 0 };
}

function summarizeBucket(stats: BucketAccumulator): LongContextBucketStats {
  return {
    total: stats.total,
    exactMatchRate: ratio(stats.exact, stats.total),
    expectedContainRate: ratio(stats.contains, stats.total),
  };
}

function countPositions(cases: LongContextEvalCase[]): Record<LongContextNeedlePosition, number> {
  return {
    early: cases.filter((item) => item.metadata.needlePosition === "early").length,
    middle: cases.filter((item) => item.metadata.needlePosition === "middle").length,
    late: cases.filter((item) => item.metadata.needlePosition === "late").length,
  };
}

function normalizeAnswer(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function looksLikeNonAnswer(output: string): boolean {
  const normalized = output.toLowerCase();
  return [
    "i don't know",
    "i do not know",
    "not enough information",
    "cannot determine",
    "can't determine",
  ].some((phrase) => normalized.includes(phrase));
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

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
