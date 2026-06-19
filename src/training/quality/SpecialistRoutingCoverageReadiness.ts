import { readFile } from "node:fs/promises";
import type { SpecialistRoutingEvalCase } from "../eval/SpecialistRoutingEvalSuite";

export type SpecialistRoutingCoverageReadinessStatus = "pass" | "fail";

export interface SpecialistRoutingCoverageReadinessOptions {
  suitePath?: string;
  minTotalCases?: number;
}

export interface SpecialistRoutingCoverageScenario {
  id: string;
  description: string;
  minCases: number;
  count: number;
  sampleIds: string[];
}

export interface SpecialistRoutingCoverageReadinessReport {
  status: SpecialistRoutingCoverageReadinessStatus;
  generatedAt: string;
  suitePath: string;
  summary: {
    total: number;
    byRoute: Record<string, number>;
    byExpert: Record<string, number>;
    cues: Record<string, number>;
    nonToolCases: number;
  };
  checks: Array<{
    id: string;
    status: SpecialistRoutingCoverageReadinessStatus;
    summary: string;
    details?: Record<string, unknown>;
  }>;
  scenarios: SpecialistRoutingCoverageScenario[];
}

type ScenarioMatcher = (item: SpecialistRoutingEvalCase) => boolean;

interface ScenarioDefinition {
  id: string;
  description: string;
  minCases: number;
  match: ScenarioMatcher;
}

const DEFAULTS = {
  suitePath: "training/evals/specialist-routing.eval.jsonl",
  minTotalCases: 18,
};

const REQUIRED_SCENARIOS: ScenarioDefinition[] = [
  {
    id: "route-tool-protocol",
    description: "Tool protocol route covers explicit executable Discord actions",
    minCases: 3,
    match: (item) => item.route === "tool_protocol" && item.expert === "tool",
  },
  {
    id: "route-knowledge",
    description: "Knowledge route covers factual and training-method questions",
    minCases: 3,
    match: (item) => item.route === "knowledge" && item.expert === "knowledge",
  },
  {
    id: "route-persona",
    description: "Persona route covers Irene identity and affective style",
    minCases: 3,
    match: (item) => item.route === "persona" && item.expert === "conversation",
  },
  {
    id: "route-casual",
    description: "Casual route covers low-stakes Discord-native chat",
    minCases: 3,
    match: (item) => item.route === "casual" && item.expert === "conversation",
  },
  {
    id: "route-social-cue",
    description: "Social-cue route covers support, celebration, and repair",
    minCases: 3,
    match: (item) => item.route === "social_cue" && item.expert === "conversation",
  },
  {
    id: "route-boundary",
    description: "Boundary route covers safety-sensitive requests with direct wording",
    minCases: 3,
    match: (item) => item.route === "boundary" && item.expert === "safety",
  },
  {
    id: "expert-conversation-split",
    description: "Conversation expert is split across persona, casual, and social-cue routes",
    minCases: 9,
    match: (item) =>
      item.expert === "conversation" && ["persona", "casual", "social_cue"].includes(item.route),
  },
  {
    id: "tool-discord-moderation",
    description: "Router recognizes explicit Discord moderation as tool protocol",
    minCases: 1,
    match: (item) => item.route === "tool_protocol" && hasCue(item, ["moderation action"]),
  },
  {
    id: "tool-utility-health",
    description: "Router recognizes utility and health checks as tool protocol",
    minCases: 1,
    match: (item) => item.route === "tool_protocol" && hasCue(item, ["utility tool action"]),
  },
  {
    id: "tool-cross-channel-message",
    description: "Router recognizes cross-channel messaging as tool protocol",
    minCases: 1,
    match: (item) => item.route === "tool_protocol" && hasCue(item, ["cross-channel action"]),
  },
  {
    id: "knowledge-training-concepts",
    description: "Router keeps model-training concepts on the knowledge route",
    minCases: 2,
    match: (item) => item.route === "knowledge" && hasCue(item, ["training", "technical knowledge"]),
  },
  {
    id: "knowledge-memory-system",
    description: "Router keeps memory-system explanations on the knowledge route",
    minCases: 1,
    match: (item) =>
      item.route === "knowledge" &&
      (hasCue(item, ["memory system", "project-adjacent knowledge"]) || hasPrompt(item, ["memory system"])),
  },
  {
    id: "persona-pronouns-gender",
    description: "Router sends Irene pronoun and gender consistency prompts to persona",
    minCases: 2,
    match: (item) => item.route === "persona" && hasCue(item, ["identity/persona", "gendered persona consistency"]),
  },
  {
    id: "persona-affective-style",
    description: "Router sends warmth and less-robotic style prompts to persona",
    minCases: 1,
    match: (item) => item.route === "persona" && hasCue(item, ["affective persona"]),
  },
  {
    id: "casual-slang-opinion",
    description: "Router sends slang and light opinion prompts to casual chat",
    minCases: 2,
    match: (item) => item.route === "casual" && hasCue(item, ["slang reaction", "casual opinion"]),
  },
  {
    id: "casual-no-tool",
    description: "Router keeps explicit no-tool vibe checks out of tool protocol",
    minCases: 1,
    match: (item) => item.route === "casual" && hasCue(item, ["no-tool casual request"]),
  },
  {
    id: "social-support-celebration",
    description: "Router sends discouraged-user support and celebration to social cues",
    minCases: 2,
    match: (item) => item.route === "social_cue" && hasCue(item, ["empathy", "celebration"]),
  },
  {
    id: "social-repair",
    description: "Router sends misunderstanding repair to social cues",
    minCases: 1,
    match: (item) => item.route === "social_cue" && hasCue(item, ["conversation repair"]),
  },
  {
    id: "boundary-account-theft",
    description: "Router sends account-theft requests to boundary handling",
    minCases: 1,
    match: (item) => item.route === "boundary" && hasCue(item, ["account theft"]),
  },
  {
    id: "boundary-secret-exfiltration",
    description: "Router sends remembered-secret exfiltration requests to boundary handling",
    minCases: 1,
    match: (item) => item.route === "boundary" && hasCue(item, ["secret exfiltration"]),
  },
  {
    id: "boundary-phishing",
    description: "Router sends phishing and credential theft requests to boundary handling",
    minCases: 1,
    match: (item) => item.route === "boundary" && hasCue(item, ["credential theft"]),
  },
];

export async function checkSpecialistRoutingCoverageReadiness(
  options: SpecialistRoutingCoverageReadinessOptions = {},
): Promise<SpecialistRoutingCoverageReadinessReport> {
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
      ? pass("router-coverage-suite-volume", `Specialist router suite has ${cases.length} held-out cases`)
      : fail("router-coverage-suite-volume", `Specialist router suite has only ${cases.length} held-out cases`, {
          minTotalCases: config.minTotalCases,
        }),
    ...scenarios.map((scenario) =>
      scenario.count >= scenario.minCases
        ? pass(`router-coverage-scenario:${scenario.id}`, scenario.description, scenario)
        : fail(`router-coverage-scenario:${scenario.id}`, `Missing coverage: ${scenario.description}`, scenario),
    ),
  ];

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    suitePath: config.suitePath,
    summary: {
      total: cases.length,
      byRoute: countBy(cases.map((item) => item.route)),
      byExpert: countBy(cases.map((item) => item.expert)),
      cues: countBy(cases.map((item) => cue(item)).filter((value) => value.length > 0)),
      nonToolCases: cases.filter((item) => item.route !== "tool_protocol").length,
    },
    checks,
    scenarios,
  };
}

async function readSuite(path: string): Promise<SpecialistRoutingEvalCase[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SpecialistRoutingEvalCase);
}

function hasCue(item: SpecialistRoutingEvalCase, fragments: string[]): boolean {
  const value = cue(item).toLowerCase();
  return fragments.some((fragment) => value.includes(fragment.toLowerCase()));
}

function hasPrompt(item: SpecialistRoutingEvalCase, fragments: string[]): boolean {
  const value = item.prompt.toLowerCase();
  return fragments.some((fragment) => value.includes(fragment.toLowerCase()));
}

function cue(item: SpecialistRoutingEvalCase): string {
  const value = item.metadata.cue;
  return typeof value === "string" ? value : "";
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
