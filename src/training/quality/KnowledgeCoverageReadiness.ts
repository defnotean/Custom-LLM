import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { KnowledgeEvalCase } from "../eval/KnowledgeEvalSuite";

export type KnowledgeCoverageReadinessStatus = "pass" | "fail";

export interface KnowledgeCoverageReadinessOptions {
  suitePath?: string;
  minTotalCases?: number;
}

export interface KnowledgeCoverageScenario {
  id: string;
  description: string;
  minCases: number;
  count: number;
  sampleIds: string[];
}

export interface KnowledgeCoverageReadinessReport {
  status: KnowledgeCoverageReadinessStatus;
  generatedAt: string;
  suitePath: string;
  summary: {
    total: number;
    validCases: number;
    bySource: Record<string, number>;
    contextGroundedCases: number;
    technicalCases: number;
    longPromptCases: number;
    longFormAnswerCases: number;
    conciseAnswerCases: number;
    duplicateIds: number;
    duplicatePromptExpectedPairs: number;
    expectedHashMatches: number;
    metadataSourceMismatches: number;
  };
  checks: Array<{
    id: string;
    status: KnowledgeCoverageReadinessStatus;
    summary: string;
    details?: Record<string, unknown>;
  }>;
  scenarios: KnowledgeCoverageScenario[];
}

type ScenarioMatcher = (item: KnowledgeEvalCase) => boolean;

interface ScenarioDefinition {
  id: string;
  description: string;
  minCases: number;
  match: ScenarioMatcher;
}

const DEFAULTS = {
  suitePath: "training/evals/knowledge.eval.jsonl",
  minTotalCases: 200,
};

const REQUIRED_SCENARIOS: ScenarioDefinition[] = [
  {
    id: "source-dolly",
    description: "Knowledge suite keeps Dolly validation-seed coverage",
    minCases: 50,
    match: (item) => item.source === "dolly",
  },
  {
    id: "source-oasst1-ready",
    description: "Knowledge suite keeps OpenAssistant validation-seed coverage",
    minCases: 50,
    match: (item) => item.source === "oasst1_ready",
  },
  {
    id: "context-grounded",
    description: "Knowledge suite includes context-grounded answers that must use supplied evidence",
    minCases: 25,
    match: (item) => hasContextBlock(item.prompt),
  },
  {
    id: "technical-code",
    description: "Knowledge suite includes technical and code-oriented questions",
    minCases: 15,
    match: (item) => looksTechnical(`${item.prompt}\n${item.expected}`),
  },
  {
    id: "long-prompt-reasoning",
    description: "Knowledge suite includes longer prompts that exercise prompt parsing and retrieval",
    minCases: 25,
    match: (item) => item.prompt.length > 500,
  },
  {
    id: "long-form-explanation",
    description: "Knowledge suite includes multi-paragraph and long-form explanatory references",
    minCases: 50,
    match: (item) => item.expected.length > 500 || /\n\s*\n/.test(item.expected),
  },
  {
    id: "concise-factual-answer",
    description: "Knowledge suite includes concise factual answers, not only essay responses",
    minCases: 20,
    match: (item) => item.expected.trim().length <= 120,
  },
];

export async function checkKnowledgeCoverageReadiness(
  options: KnowledgeCoverageReadinessOptions = {},
): Promise<KnowledgeCoverageReadinessReport> {
  const config = { ...DEFAULTS, ...options };
  const rows = await readSuite(config.suitePath);
  const invalidRows = rows
    .map((row, index) => ({ index, row }))
    .filter((entry) => !isKnowledgeEvalCase(entry.row));
  const cases = rows.filter(isKnowledgeEvalCase);
  const duplicateIds = duplicateValues(cases.map((item) => item.id));
  const duplicatePromptExpectedPairs = duplicateValues(cases.map((item) => `${item.prompt}\n${item.expected}`));
  const hashFailures = cases
    .filter((item) => expectedHash(item) !== stableHash(item.expected))
    .map((item) => item.id);
  const metadataSourceMismatches = cases
    .filter((item) => metadataSource(item) !== undefined && metadataSource(item) !== item.source)
    .map((item) => item.id);
  const scenarios = REQUIRED_SCENARIOS.map((definition) => {
    const matches = cases.filter(definition.match);
    return {
      id: definition.id,
      description: definition.description,
      minCases: definition.minCases,
      count: matches.length,
      sampleIds: matches.slice(0, 5).map((item) => item.id),
    };
  });

  const checks = [
    cases.length >= config.minTotalCases
      ? pass("knowledge-coverage-suite-volume", `Knowledge suite has ${cases.length} held-out cases`)
      : fail("knowledge-coverage-suite-volume", `Knowledge suite has only ${cases.length} held-out cases`, {
          minTotalCases: config.minTotalCases,
        }),
    invalidRows.length === 0
      ? pass("knowledge-coverage-record-shape", "Knowledge suite rows have the required id/source/prompt/expected shape")
      : fail("knowledge-coverage-record-shape", "Knowledge suite contains invalid rows", {
          invalidRows: invalidRows.slice(0, 10).map((entry) => entry.index),
        }),
    duplicateIds.length === 0
      ? pass("knowledge-coverage-unique-ids", "Knowledge suite ids are unique")
      : fail("knowledge-coverage-unique-ids", "Knowledge suite contains duplicate ids", {
          duplicateIds: duplicateIds.slice(0, 10),
        }),
    duplicatePromptExpectedPairs.length === 0
      ? pass("knowledge-coverage-unique-references", "Knowledge suite prompt/reference pairs are unique")
      : fail("knowledge-coverage-unique-references", "Knowledge suite contains duplicate prompt/reference pairs", {
          duplicates: duplicatePromptExpectedPairs.slice(0, 10),
        }),
    hashFailures.length === 0
      ? pass("knowledge-coverage-expected-hashes", "Knowledge suite expected-answer hashes match references")
      : fail("knowledge-coverage-expected-hashes", "Knowledge suite expected-answer hashes are stale or missing", {
          ids: hashFailures.slice(0, 10),
        }),
    metadataSourceMismatches.length === 0
      ? pass("knowledge-coverage-source-metadata", "Knowledge suite source metadata matches top-level sources")
      : fail("knowledge-coverage-source-metadata", "Knowledge suite source metadata disagrees with top-level sources", {
          ids: metadataSourceMismatches.slice(0, 10),
        }),
    ...scenarios.map((scenario) =>
      scenario.count >= scenario.minCases
        ? pass(`knowledge-coverage-scenario:${scenario.id}`, scenario.description, scenario)
        : fail(`knowledge-coverage-scenario:${scenario.id}`, `Missing coverage: ${scenario.description}`, scenario),
    ),
  ];

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    suitePath: config.suitePath,
    summary: {
      total: rows.length,
      validCases: cases.length,
      bySource: countBy(cases.map((item) => item.source)),
      contextGroundedCases: cases.filter((item) => hasContextBlock(item.prompt)).length,
      technicalCases: cases.filter((item) => looksTechnical(`${item.prompt}\n${item.expected}`)).length,
      longPromptCases: cases.filter((item) => item.prompt.length > 500).length,
      longFormAnswerCases: cases.filter((item) => item.expected.length > 500 || /\n\s*\n/.test(item.expected)).length,
      conciseAnswerCases: cases.filter((item) => item.expected.trim().length <= 120).length,
      duplicateIds: duplicateIds.length,
      duplicatePromptExpectedPairs: duplicatePromptExpectedPairs.length,
      expectedHashMatches: cases.length - hashFailures.length,
      metadataSourceMismatches: metadataSourceMismatches.length,
    },
    checks,
    scenarios,
  };
}

async function readSuite(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function isKnowledgeEvalCase(value: unknown): value is KnowledgeEvalCase {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.source === "string" &&
    value.source.trim().length > 0 &&
    typeof value.prompt === "string" &&
    value.prompt.trim().length > 0 &&
    typeof value.expected === "string" &&
    value.expected.trim().length > 0 &&
    isRecord(value.metadata)
  );
}

function hasContextBlock(value: string): boolean {
  return /\bcontext\s*:/i.test(value);
}

function looksTechnical(value: string): boolean {
  return /```|\bpython\b|\bjavascript\b|\btypescript\b|\bcode\b|\bprogram\b|\bserverless\b|\bapi\b|\blinux\b|\bjson\b/i.test(
    value,
  );
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function expectedHash(item: KnowledgeEvalCase): string | undefined {
  const value = item.metadata.expectedHash;
  return typeof value === "string" ? value : undefined;
}

function metadataSource(item: KnowledgeEvalCase): string | undefined {
  const value = item.metadata.source;
  return typeof value === "string" ? value : undefined;
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function pass(id: string, summary: string, details?: Record<string, unknown>) {
  return { id, status: "pass" as const, summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>) {
  return { id, status: "fail" as const, summary, ...(details ? { details } : {}) };
}
