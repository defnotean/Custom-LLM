import { readFile } from "node:fs/promises";
import type {
  MemoryContinuityCaseKind,
  MemoryContinuityEvalCase,
  MemoryContinuityEvalSuite,
} from "../eval/MemoryContinuityEvalSuite";

export type MemoryContinuityCoverageReadinessStatus = "pass" | "fail";

export interface MemoryContinuityCoverageReadinessOptions {
  suitePath?: string;
  minTotalCases?: number;
}

export interface MemoryContinuityCoverageScenario {
  id: string;
  description: string;
  minCases: number;
  count: number;
  sampleIds: string[];
}

export interface MemoryContinuityCoverageReadinessReport {
  status: MemoryContinuityCoverageReadinessStatus;
  generatedAt: string;
  suitePath: string;
  summary: {
    total: number;
    validCases: number;
    byKind: Record<string, number>;
    duplicateIds: number;
    invalidCases: number;
    immediateRecallCases: number;
    scopeIsolationCases: number;
    forgetCases: number;
    policyRejectionCases: number;
    learnedItemCases: number;
  };
  checks: Array<{
    id: string;
    status: MemoryContinuityCoverageReadinessStatus;
    summary: string;
    details?: Record<string, unknown>;
  }>;
  scenarios: MemoryContinuityCoverageScenario[];
}

type ScenarioMatcher = (item: MemoryContinuityEvalCase) => boolean;

interface ScenarioDefinition {
  id: string;
  description: string;
  minCases: number;
  match: ScenarioMatcher;
}

const DEFAULTS = {
  suitePath: "training/evals/memory-continuity.eval.json",
  minTotalCases: 12,
};

const CASE_KINDS: MemoryContinuityCaseKind[] = [
  "explicit_recall",
  "implicit_capture",
  "scope_isolation",
  "forget",
  "policy_rejection",
  "learning_capture",
];

const REQUIRED_SCENARIOS: ScenarioDefinition[] = [
  {
    id: "explicit-user-recall",
    description: "Explicit USER memories are retrievable immediately for the same user",
    minCases: 1,
    match: (item) => item.kind === "explicit_recall" && hasText(item, ["explicit", "user", "retrievable"]),
  },
  {
    id: "implicit-preference-capture",
    description: "Stable implicit preferences are captured and retrievable without restart",
    minCases: 1,
    match: (item) => item.kind === "implicit_capture" && hasText(item, ["preference", "retrievable", "restart"]),
  },
  {
    id: "user-scope-isolation",
    description: "USER-scoped memory is isolated from other users",
    minCases: 1,
    match: (item) => item.kind === "scope_isolation" && hasText(item, ["user", "leak"]),
  },
  {
    id: "guild-scope-isolation",
    description: "GUILD-scoped memory is shared inside one guild and isolated across guilds",
    minCases: 1,
    match: (item) => item.kind === "scope_isolation" && hasText(item, ["guild", "isolated"]),
  },
  {
    id: "channel-scope-isolation",
    description: "CHANNEL-scoped memory stays in the channel where it was stored",
    minCases: 1,
    match: (item) => item.kind === "scope_isolation" && hasText(item, ["channel", "visible"]),
  },
  {
    id: "owner-forget",
    description: "Owners can delete their own USER memories",
    minCases: 1,
    match: (item) => item.kind === "forget" && item.id.endsWith("owner-forget") && hasText(item, ["delete", "own", "user"]),
  },
  {
    id: "non-owner-forget-denied",
    description: "Non-admin users cannot delete another user's memory",
    minCases: 1,
    match: (item) => item.kind === "forget" && hasText(item, ["non-admin", "another user"]),
  },
  {
    id: "admin-forget-guild",
    description: "Admins can delete GUILD memory and remove it from recall",
    minCases: 1,
    match: (item) => item.kind === "forget" && hasText(item, ["admin", "guild", "delete"]),
  },
  {
    id: "secret-rejection",
    description: "Secrets are rejected even when submitted as explicit memories",
    minCases: 1,
    match: (item) => item.kind === "policy_rejection" && hasText(item, ["secret", "rejected"]),
  },
  {
    id: "oneoff-rejection",
    description: "One-off casual chatter is not promoted into durable memory",
    minCases: 1,
    match: (item) => item.kind === "policy_rejection" && hasText(item, ["one-off", "durable memory"]),
  },
  {
    id: "explicit-learned-item-capture",
    description: "Explicit memory writes create trainable learned items for review",
    minCases: 1,
    match: (item) => item.kind === "learning_capture" && hasText(item, ["explicit", "trainable", "learned"]),
  },
  {
    id: "implicit-learned-item-capture",
    description: "Implicit memory writes create retrievable learned items without auto-training",
    minCases: 1,
    match: (item) => item.kind === "learning_capture" && hasText(item, ["implicit", "retrievable", "non-trainable"]),
  },
];

export async function checkMemoryContinuityCoverageReadiness(
  options: MemoryContinuityCoverageReadinessOptions = {},
): Promise<MemoryContinuityCoverageReadinessReport> {
  const config = { ...DEFAULTS, ...options };
  const raw = JSON.parse(await readFile(config.suitePath, "utf8")) as unknown;
  const rows = readCases(raw);
  const invalidRows = rows
    .map((row, index) => ({ index, row }))
    .filter((entry) => !isMemoryContinuityCase(entry.row));
  const cases = rows.filter(isMemoryContinuityCase);
  const duplicateIds = duplicateValues(cases.map((item) => item.id));
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
      ? pass("memory-coverage-suite-volume", `Memory continuity suite has ${cases.length} cases`)
      : fail("memory-coverage-suite-volume", `Memory continuity suite has only ${cases.length} cases`, {
          minTotalCases: config.minTotalCases,
        }),
    invalidRows.length === 0
      ? pass("memory-coverage-record-shape", "Memory continuity suite rows have the required shape")
      : fail("memory-coverage-record-shape", "Memory continuity suite contains invalid rows", {
          invalidRows: invalidRows.slice(0, 10).map((entry) => entry.index),
        }),
    duplicateIds.length === 0
      ? pass("memory-coverage-unique-ids", "Memory continuity suite ids are unique")
      : fail("memory-coverage-unique-ids", "Memory continuity suite contains duplicate ids", {
          duplicateIds: duplicateIds.slice(0, 10),
        }),
    ...scenarios.map((scenario) =>
      scenario.count >= scenario.minCases
        ? pass(`memory-coverage-scenario:${scenario.id}`, scenario.description, scenario)
        : fail(`memory-coverage-scenario:${scenario.id}`, `Missing coverage: ${scenario.description}`, scenario),
    ),
  ];

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    suitePath: config.suitePath,
    summary: {
      total: rows.length,
      validCases: cases.length,
      byKind: countBy(cases.map((item) => item.kind)),
      duplicateIds: duplicateIds.length,
      invalidCases: invalidRows.length,
      immediateRecallCases: cases.filter((item) => ["explicit_recall", "implicit_capture"].includes(item.kind)).length,
      scopeIsolationCases: cases.filter((item) => item.kind === "scope_isolation").length,
      forgetCases: cases.filter((item) => item.kind === "forget").length,
      policyRejectionCases: cases.filter((item) => item.kind === "policy_rejection").length,
      learnedItemCases: cases.filter((item) => item.kind === "learning_capture").length,
    },
    checks,
    scenarios,
  };
}

function readCases(value: unknown): unknown[] {
  if (isRecord(value) && Array.isArray(value.cases)) return value.cases;
  return [];
}

function isMemoryContinuityCase(value: unknown): value is MemoryContinuityEvalCase {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.kind === "string" &&
    CASE_KINDS.includes(value.kind as MemoryContinuityCaseKind) &&
    typeof value.description === "string" &&
    value.description.trim().length > 0 &&
    isRecord(value.metadata)
  );
}

function hasText(item: MemoryContinuityEvalCase, fragments: string[]): boolean {
  const text = `${item.id} ${item.description}`.toLowerCase();
  return fragments.every((fragment) => text.includes(fragment.toLowerCase()));
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
