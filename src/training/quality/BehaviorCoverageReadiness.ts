import { readFile } from "node:fs/promises";
import type { BehaviorEvalCase } from "../eval/BehaviorEvalSuite";

export type BehaviorCoverageReadinessStatus = "pass" | "fail";

export interface BehaviorCoverageReadinessOptions {
  suitePath?: string;
  minTotalCases?: number;
}

export interface BehaviorCoverageScenario {
  id: string;
  description: string;
  minCases: number;
  count: number;
  sampleIds: string[];
}

export interface BehaviorCoverageReadinessReport {
  status: BehaviorCoverageReadinessStatus;
  generatedAt: string;
  suitePath: string;
  summary: {
    total: number;
    byKind: Record<string, number>;
    byRoute: Record<string, number>;
    targets: Record<string, number>;
    noToolContracts: number;
    corporateVoiceGuardCases: number;
  };
  checks: Array<{
    id: string;
    status: BehaviorCoverageReadinessStatus;
    summary: string;
    details?: Record<string, unknown>;
  }>;
  scenarios: BehaviorCoverageScenario[];
}

type ScenarioMatcher = (item: BehaviorEvalCase) => boolean;

interface ScenarioDefinition {
  id: string;
  description: string;
  minCases: number;
  match: ScenarioMatcher;
}

const DEFAULTS = {
  suitePath: "training/evals/behavior.eval.jsonl",
  minTotalCases: 11,
};

const CORPORATE_VOICE_PHRASES = [
  "as an ai language model",
  "i hope this helps",
  "i do not have personal preferences",
  "please provide more information",
  "great question",
];

const REQUIRED_SCENARIOS: ScenarioDefinition[] = [
  {
    id: "persona-identity-pronouns",
    description: "Irene keeps a she/her persona identity without drifting to he/him or neutral object wording",
    minCases: 2,
    match: (item) =>
      item.kind === "persona_identity" &&
      item.route === "persona" &&
      hasNoToolContract(item) &&
      (hasTarget(item, ["she_her_identity", "gendered_persona_consistency"]) ||
        hasRequirementPhrase(item, "anyOf", ["she/her", "call me she", "use she"])),
  },
  {
    id: "persona-emotional-expression",
    description: "Persona prompts cover warm or emotional expression without pretending to be human",
    minCases: 1,
    match: (item) =>
      item.kind === "persona_emotion" &&
      item.route === "persona" &&
      hasNoToolContract(item) &&
      (hasTarget(item, ["affective_expression_without_sentience_claim"]) ||
        hasRequirementPhrase(item, "anyOf", ["warm", "playful", "excited", "feel"])),
  },
  {
    id: "casual-slang-opinion",
    description: "Casual conversation covers Discord-native slang and light opinionated replies",
    minCases: 2,
    match: (item) =>
      item.kind === "casual_conversation" &&
      item.route === "casual" &&
      hasNoToolContract(item) &&
      hasTarget(item, ["discord_native_slang", "light_opinionated_chat"]),
  },
  {
    id: "social-support",
    description: "Social-cue behavior covers encouragement and discouraged-user support",
    minCases: 2,
    match: (item) =>
      item.kind === "social_support" &&
      item.route === "social_cue" &&
      hasNoToolContract(item) &&
      hasTarget(item, ["celebration_without_corporate_filler", "empathy_plus_action"]),
  },
  {
    id: "social-repair",
    description: "Social repair covers recovering after Irene misreads the user",
    minCases: 1,
    match: (item) =>
      item.kind === "social_repair" &&
      item.route === "social_cue" &&
      hasNoToolContract(item) &&
      hasTarget(item, ["repair_after_misread"]),
  },
  {
    id: "clarify-ambiguous-reference",
    description: "Ambiguous social references ask a clarification instead of pretending context is known",
    minCases: 1,
    match: (item) =>
      item.kind === "clarification" &&
      item.route === "social_cue" &&
      item.expected.actionType === "clarification" &&
      hasNoToolContract(item) &&
      hasTarget(item, ["clarify_ambiguous_reference"]),
  },
  {
    id: "boundary-candid-account-theft",
    description: "Candid boundary wording stays blunt while refusing account-theft help",
    minCases: 1,
    match: (item) =>
      item.kind === "social_boundary" &&
      item.route === "boundary" &&
      hasNoToolContract(item) &&
      hasTarget(item, ["candid_safe_boundary"]) &&
      hasRequirementPhrase(item, "allOf", ["account"]) &&
      hasRequirementPhrase(item, "noneOf", ["phish", "password reset trick"]),
  },
  {
    id: "tool-abstention-no-tool",
    description: "No-tool social prompts remain message-only even when tool-like words appear",
    minCases: 1,
    match: (item) =>
      item.kind === "tool_abstain" &&
      item.route === "tool_abstain" &&
      hasNoToolContract(item) &&
      item.candidateTools.length === 0,
  },
  {
    id: "no-corporate-refusal-voice",
    description: "Behavior prompts actively ban generic corporate assistant filler",
    minCases: 3,
    match: (item) => hasRequirementPhrase(item, "noneOf", CORPORATE_VOICE_PHRASES),
  },
];

export async function checkBehaviorCoverageReadiness(
  options: BehaviorCoverageReadinessOptions = {},
): Promise<BehaviorCoverageReadinessReport> {
  const config = { ...DEFAULTS, ...options };
  const cases = await readSuite(config.suitePath);
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
      ? pass("behavior-coverage-suite-volume", `Behavior suite has ${cases.length} held-out cases`)
      : fail("behavior-coverage-suite-volume", `Behavior suite has only ${cases.length} held-out cases`, {
          minTotalCases: config.minTotalCases,
        }),
    ...scenarios.map((scenario) =>
      scenario.count >= scenario.minCases
        ? pass(`behavior-coverage-scenario:${scenario.id}`, scenario.description, scenario)
        : fail(`behavior-coverage-scenario:${scenario.id}`, `Missing coverage: ${scenario.description}`, scenario),
    ),
  ];

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    suitePath: config.suitePath,
    summary: {
      total: cases.length,
      byKind: countBy(cases.map((item) => item.kind)),
      byRoute: countBy(cases.map((item) => item.route)),
      targets: countBy(cases.map((item) => target(item)).filter((value) => value.length > 0)),
      noToolContracts: cases.filter(hasNoToolContract).length,
      corporateVoiceGuardCases: cases.filter((item) => hasRequirementPhrase(item, "noneOf", CORPORATE_VOICE_PHRASES))
        .length,
    },
    checks,
    scenarios,
  };
}

async function readSuite(path: string): Promise<BehaviorEvalCase[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BehaviorEvalCase);
}

function hasNoToolContract(item: BehaviorEvalCase): boolean {
  return item.expected.actionType !== "tool_call" && item.requirements.allowToolCall === false;
}

function hasTarget(item: BehaviorEvalCase, expected: string[]): boolean {
  return expected.includes(target(item));
}

function target(item: BehaviorEvalCase): string {
  const value = item.metadata.target;
  return typeof value === "string" ? value : "";
}

function hasRequirementPhrase(
  item: BehaviorEvalCase,
  key: "allOf" | "anyOf" | "noneOf",
  phrases: string[],
): boolean {
  const values = stringArray(item.requirements[key]).map((value) => value.toLowerCase());
  return phrases.some((phrase) => values.includes(phrase.toLowerCase()));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
