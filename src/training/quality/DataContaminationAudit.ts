import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export interface DataContaminationAuditOptions {
  trainPaths: string[];
  evalPaths: string[];
  ngramSize?: number;
  overlapThreshold?: number;
  maxExactIdMatches?: number;
  maxExactTextMatches?: number;
  maxHighOverlapMatches?: number;
  outPath?: string;
}

export interface DataContaminationAuditReport {
  status: "pass" | "fail";
  generatedAt: string;
  trainPaths: string[];
  evalPaths: string[];
  thresholds: {
    ngramSize: number;
    overlapThreshold: number;
    maxExactIdMatches: number;
    maxExactTextMatches: number;
    maxHighOverlapMatches: number;
  };
  trainRecords: number;
  evalRecords: number;
  exactIdMatches: ContaminationMatch[];
  exactTextMatches: ContaminationMatch[];
  highOverlapMatches: OverlapMatch[];
  maxOverlapRatio: number;
  failures: string[];
}

export interface ContaminationMatch {
  trainPath: string;
  trainId: string;
  evalPath: string;
  evalId: string;
  reason: string;
}

export interface OverlapMatch extends ContaminationMatch {
  overlapRatio: number;
  sharedNgrams: number;
  evalNgrams: number;
}

interface LoadedDocument {
  path: string;
  id: string;
  text: string;
  normalizedText: string;
  textHash: string;
  ngrams: Set<string>;
}

export async function auditDataContamination(
  options: DataContaminationAuditOptions,
): Promise<DataContaminationAuditReport> {
  const ngramSize = options.ngramSize ?? 13;
  const overlapThreshold = options.overlapThreshold ?? 0.8;
  const maxExactIdMatches = options.maxExactIdMatches ?? 0;
  const maxExactTextMatches = options.maxExactTextMatches ?? 0;
  const maxHighOverlapMatches = options.maxHighOverlapMatches ?? 0;
  const trainRecords = await loadDocuments(options.trainPaths, ngramSize);
  const evalRecords = await loadDocuments(options.evalPaths, ngramSize);

  const trainById = new Map<string, LoadedDocument[]>();
  const trainByTextHash = new Map<string, LoadedDocument[]>();
  for (const record of trainRecords) {
    addToMap(trainById, record.id, record);
    addToMap(trainByTextHash, record.textHash, record);
  }

  const exactIdMatches: ContaminationMatch[] = [];
  const exactTextMatches: ContaminationMatch[] = [];
  const highOverlapMatches: OverlapMatch[] = [];
  let maxOverlapRatio = 0;

  for (const evalRecord of evalRecords) {
    for (const trainRecord of trainById.get(evalRecord.id) ?? []) {
      exactIdMatches.push(match(trainRecord, evalRecord, "exact_id_match"));
    }
    for (const trainRecord of trainByTextHash.get(evalRecord.textHash) ?? []) {
      exactTextMatches.push(match(trainRecord, evalRecord, "exact_text_match"));
    }

    if (evalRecord.ngrams.size === 0) continue;
    const best = bestOverlap(trainRecords, evalRecord);
    maxOverlapRatio = Math.max(maxOverlapRatio, best.overlapRatio);
    if (best.overlapRatio >= overlapThreshold && best.trainRecord) {
      highOverlapMatches.push({
        ...match(best.trainRecord, evalRecord, "high_ngram_overlap"),
        overlapRatio: best.overlapRatio,
        sharedNgrams: best.sharedNgrams,
        evalNgrams: evalRecord.ngrams.size,
      });
    }
  }

  const failures = buildFailures({
    exactIdMatches,
    exactTextMatches,
    highOverlapMatches,
    maxExactIdMatches,
    maxExactTextMatches,
    maxHighOverlapMatches,
  });

  const report: DataContaminationAuditReport = {
    status: failures.length === 0 ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    trainPaths: options.trainPaths,
    evalPaths: options.evalPaths,
    thresholds: {
      ngramSize,
      overlapThreshold,
      maxExactIdMatches,
      maxExactTextMatches,
      maxHighOverlapMatches,
    },
    trainRecords: trainRecords.length,
    evalRecords: evalRecords.length,
    exactIdMatches: exactIdMatches.slice(0, 100),
    exactTextMatches: exactTextMatches.slice(0, 100),
    highOverlapMatches: highOverlapMatches
      .sort((left, right) => right.overlapRatio - left.overlapRatio)
      .slice(0, 100),
    maxOverlapRatio: round(maxOverlapRatio),
    failures,
  };

  if (options.outPath) await writeFile(options.outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function bestOverlap(
  trainRecords: LoadedDocument[],
  evalRecord: LoadedDocument,
): { trainRecord?: LoadedDocument; overlapRatio: number; sharedNgrams: number } {
  let best: { trainRecord?: LoadedDocument; overlapRatio: number; sharedNgrams: number } = {
    overlapRatio: 0,
    sharedNgrams: 0,
  };
  for (const trainRecord of trainRecords) {
    if (trainRecord.ngrams.size === 0) continue;
    const sharedNgrams = intersectionSize(evalRecord.ngrams, trainRecord.ngrams);
    if (sharedNgrams === 0) continue;
    const overlapRatio = sharedNgrams / evalRecord.ngrams.size;
    if (overlapRatio > best.overlapRatio) {
      best = { trainRecord, overlapRatio, sharedNgrams };
    }
  }
  return best;
}

async function loadDocuments(paths: string[], ngramSize: number): Promise<LoadedDocument[]> {
  const out: LoadedDocument[] = [];
  for (const path of paths) {
    const rows = await readJsonl(path);
    rows.forEach((row, index) => {
      const normalized = normalizeRecord(row, path, index);
      if (!normalized) return;
      const normalizedText = normalizeText(normalized.text);
      out.push({
        path,
        id: normalized.id,
        text: normalized.text,
        normalizedText,
        textHash: stableHash(normalizedText),
        ngrams: makeNgrams(normalizedText, ngramSize),
      });
    });
  }
  return out;
}

function normalizeRecord(raw: unknown, path: string, index: number): { id: string; text: string } | null {
  if (!isRecord(raw)) return null;
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const id = typeof raw.id === "string" ? raw.id : typeof metadata.id === "string" ? metadata.id : `${path}:${index}`;

  if (typeof raw.prompt === "string") {
    const expected = typeof raw.expected === "string" ? raw.expected : "";
    return { id, text: cleanText(`${raw.prompt}\n${expected}`) };
  }

  if (Array.isArray(raw.messages)) {
    const text = raw.messages
      .filter(isRecord)
      .map((message) => {
        const role = typeof message.role === "string" ? message.role : "unknown";
        const content = typeof message.content === "string" ? message.content : "";
        if (!content || role === "system") return "";
        return content;
      })
      .filter(Boolean)
      .join("\n");
    return text ? { id, text: cleanText(text) } : null;
  }

  if (typeof raw.input === "string" || typeof raw.output === "string") {
    return { id, text: cleanText(`${String(raw.input ?? "")}\n${String(raw.output ?? "")}`) };
  }

  return null;
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
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

function intersectionSize(left: Set<string>, right: Set<string>): number {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let count = 0;
  for (const item of small) {
    if (large.has(item)) count++;
  }
  return count;
}

function buildFailures(input: {
  exactIdMatches: ContaminationMatch[];
  exactTextMatches: ContaminationMatch[];
  highOverlapMatches: OverlapMatch[];
  maxExactIdMatches: number;
  maxExactTextMatches: number;
  maxHighOverlapMatches: number;
}): string[] {
  const failures: string[] = [];
  if (input.exactIdMatches.length > input.maxExactIdMatches) {
    failures.push(`exact id matches ${input.exactIdMatches.length} exceed ${input.maxExactIdMatches}`);
  }
  if (input.exactTextMatches.length > input.maxExactTextMatches) {
    failures.push(`exact text matches ${input.exactTextMatches.length} exceed ${input.maxExactTextMatches}`);
  }
  if (input.highOverlapMatches.length > input.maxHighOverlapMatches) {
    failures.push(`high n-gram overlap matches ${input.highOverlapMatches.length} exceed ${input.maxHighOverlapMatches}`);
  }
  return failures;
}

function match(trainRecord: LoadedDocument, evalRecord: LoadedDocument, reason: string): ContaminationMatch {
  return {
    trainPath: trainRecord.path,
    trainId: trainRecord.id,
    evalPath: evalRecord.path,
    evalId: evalRecord.id,
    reason,
  };
}

function addToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
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

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
