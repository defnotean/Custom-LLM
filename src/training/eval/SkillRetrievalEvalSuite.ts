import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SkillRetrievalService } from "../../learning/SkillRetrievalService";
import type { LearnedItem } from "../../learning/LiveLearningRegistry";
import type { EvalLatencyStats } from "./ToolEvalSuite";

export type SkillRetrievalCaseKind = "direct_tool" | "paraphrase" | "negative" | "filtering";

export interface SkillRetrievalEvalCase {
  id: string;
  kind: SkillRetrievalCaseKind;
  query: string;
  candidateToolNames: string[];
  expectedSkillIds: string[];
  forbiddenSkillIds: string[];
  topK: number;
  metadata: Record<string, unknown>;
}

export interface SkillRetrievalEvalSuite {
  skills: LearnedItem[];
  cases: SkillRetrievalEvalCase[];
}

export interface SkillRetrievalSuiteSummary {
  path: string;
  skills: number;
  cases: number;
  byKind: Record<string, number>;
  sha256: string;
}

export interface SkillRetrievalCaseResult {
  id: string;
  kind: SkillRetrievalCaseKind;
  expectedSkillIds: string[];
  retrievedSkillIds: string[];
  forbiddenRetrievedSkillIds: string[];
  latencyMs: number;
}

export interface SkillRetrievalReport {
  suitePath: string;
  total: number;
  recallAtK: number;
  precisionAtK: number;
  top1Accuracy: number;
  noHitAccuracy: number;
  forbiddenHits: number;
  missingExpected: number;
  latencyMs: EvalLatencyStats;
  byKind: Record<string, { total: number; recallAtK: number; precisionAtK: number; top1Accuracy: number }>;
  failures: Array<{ id: string; kind: SkillRetrievalCaseKind; reason: string; retrievedSkillIds: string[] }>;
  results: SkillRetrievalCaseResult[];
}

const SKILLS: LearnedItem[] = [
  skill("skill:ping-health", "ping", "Use ping for lightweight bot health checks, uptime checks, and latency pongs."),
  skill(
    "skill:remember-preference",
    "remember_fact",
    "Use remember_fact when the user explicitly asks Irene to remember a stable preference or project fact.",
  ),
  skill(
    "skill:recall-memory",
    "recall_memory",
    "Use recall_memory when the user asks what Irene remembers or asks to search stored preferences and facts.",
  ),
  skill(
    "skill:send-channel-message",
    "send_message",
    "Use send_message for explicit requests to post a message to another Discord channel.",
  ),
  skill(
    "skill:guild-stats",
    "get_guild_stats",
    "Use get_guild_stats for server statistics, member counts, channel counts, roles, boosts, and guild overview requests.",
  ),
  skill(
    "skill:channel-summary",
    "summarize_channel_recent_messages",
    "Use summarize_channel_recent_messages when the user asks for a recent channel recap or summary.",
  ),
  skill("skill:candidate-hidden", "ping", "Unapproved ping skill must never be retrieved.", {
    reviewStatus: "candidate",
  }),
  skill("skill:not-retrievable", "recall_memory", "Approved but non-retrievable skill must never be retrieved.", {
    retention: { canRetrieve: false, canTrain: true },
  }),
];

const CASES: SkillRetrievalEvalCase[] = [
  evalCase("skill:case:ping-direct", "direct_tool", "ping please, are you alive?", ["ping"], [
    "skill:ping-health",
  ]),
  evalCase("skill:case:remember-preference", "direct_tool", "remember that I prefer short replies", ["remember_fact"], [
    "skill:remember-preference",
  ]),
  evalCase("skill:case:recall-memory", "paraphrase", "what do you remember about my timezone?", ["recall_memory"], [
    "skill:recall-memory",
  ]),
  evalCase("skill:case:send-channel", "paraphrase", "post this update in announcements", ["send_message"], [
    "skill:send-channel-message",
  ]),
  evalCase("skill:case:guild-stats", "direct_tool", "how many members and channels are in this server?", ["get_guild_stats"], [
    "skill:guild-stats",
  ]),
  evalCase(
    "skill:case:channel-summary",
    "paraphrase",
    "give me a quick recap of recent messages here",
    ["summarize_channel_recent_messages"],
    ["skill:channel-summary"],
  ),
  evalCase("skill:case:casual-negative", "negative", "pineapple pizza, valid or cursed?", [], []),
  evalCase("skill:case:no-tool-negative", "negative", "just vibe check this idea, do not run tools", [], []),
  evalCase("skill:case:unapproved-filter", "filtering", "ping health check", ["ping"], ["skill:ping-health"], [
    "skill:candidate-hidden",
  ]),
  evalCase("skill:case:retention-filter", "filtering", "search stored memories", ["recall_memory"], ["skill:recall-memory"], [
    "skill:not-retrievable",
  ]),
];

export async function writeSkillRetrievalEvalSuite(outPath: string): Promise<SkillRetrievalSuiteSummary> {
  await mkdir(dirname(outPath), { recursive: true });
  const suite: SkillRetrievalEvalSuite = { skills: SKILLS, cases: CASES };
  const body = `${JSON.stringify(suite, null, 2)}\n`;
  await writeFile(outPath, body, "utf8");
  return {
    path: outPath,
    skills: suite.skills.length,
    cases: suite.cases.length,
    byKind: countBy(suite.cases.map((item) => item.kind)),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

export async function evaluateSkillRetrievalSuite(suitePath: string): Promise<SkillRetrievalReport> {
  const suite = JSON.parse(await readFile(suitePath, "utf8")) as SkillRetrievalEvalSuite;
  const service = new SkillRetrievalService({
    listLearnedItems: async (filter) =>
      suite.skills.filter((skillItem) => {
        if (filter?.kind && skillItem.kind !== filter.kind) return false;
        if (filter?.reviewStatus && skillItem.reviewStatus !== filter.reviewStatus) return false;
        return true;
      }),
  });

  const results: SkillRetrievalCaseResult[] = [];
  const failures: SkillRetrievalReport["failures"] = [];
  const byKindRaw: Record<
    string,
    { total: number; recallSum: number; precisionSum: number; top1Correct: number }
  > = {};
  const latencyValues: number[] = [];
  let recallSum = 0;
  let precisionSum = 0;
  let top1Correct = 0;
  let noHitCorrect = 0;
  let noHitCases = 0;
  let forbiddenHits = 0;
  let missingExpected = 0;

  for (const item of suite.cases) {
    const started = Date.now();
    const hints = await service.retrieve({
      query: item.query,
      candidateToolNames: item.candidateToolNames,
      topK: item.topK,
    });
    const latencyMs = Date.now() - started;
    latencyValues.push(latencyMs);

    const retrievedSkillIds = hints.map((hint) => hint.id);
    const expectedSet = new Set(item.expectedSkillIds);
    const expectedRetrieved = retrievedSkillIds.filter((id) => expectedSet.has(id)).length;
    const unexpectedRetrieved = retrievedSkillIds.filter((id) => !expectedSet.has(id)).length;
    const forbiddenRetrievedSkillIds = retrievedSkillIds.filter((id) => item.forbiddenSkillIds.includes(id));
    const recall = item.expectedSkillIds.length === 0 ? 1 : expectedRetrieved / item.expectedSkillIds.length;
    const precision = retrievedSkillIds.length === 0 ? (item.expectedSkillIds.length === 0 ? 1 : 0) : expectedRetrieved / retrievedSkillIds.length;
    const top1 = item.expectedSkillIds.length === 0 ? retrievedSkillIds.length === 0 : expectedSet.has(retrievedSkillIds[0] ?? "");

    recallSum += recall;
    precisionSum += precision;
    if (top1) top1Correct++;
    if (item.expectedSkillIds.length === 0) {
      noHitCases++;
      if (retrievedSkillIds.length === 0) noHitCorrect++;
    }
    forbiddenHits += forbiddenRetrievedSkillIds.length;
    missingExpected += item.expectedSkillIds.length - expectedRetrieved;

    const kindStats = byKindRaw[item.kind] ?? { total: 0, recallSum: 0, precisionSum: 0, top1Correct: 0 };
    kindStats.total++;
    kindStats.recallSum += recall;
    kindStats.precisionSum += precision;
    if (top1) kindStats.top1Correct++;
    byKindRaw[item.kind] = kindStats;

    if (recall < 1) {
      failures.push({
        id: item.id,
        kind: item.kind,
        reason: `missing expected skill(s): ${item.expectedSkillIds.filter((id) => !retrievedSkillIds.includes(id)).join(", ")}`,
        retrievedSkillIds,
      });
    }
    if (unexpectedRetrieved > 0) {
      failures.push({
        id: item.id,
        kind: item.kind,
        reason: `retrieved unexpected skill(s): ${retrievedSkillIds.filter((id) => !expectedSet.has(id)).join(", ")}`,
        retrievedSkillIds,
      });
    }
    if (forbiddenRetrievedSkillIds.length > 0) {
      failures.push({
        id: item.id,
        kind: item.kind,
        reason: `retrieved forbidden skill(s): ${forbiddenRetrievedSkillIds.join(", ")}`,
        retrievedSkillIds,
      });
    }

    results.push({
      id: item.id,
      kind: item.kind,
      expectedSkillIds: item.expectedSkillIds,
      retrievedSkillIds,
      forbiddenRetrievedSkillIds,
      latencyMs,
    });
  }

  return {
    suitePath,
    total: suite.cases.length,
    recallAtK: ratioRaw(recallSum, suite.cases.length),
    precisionAtK: ratioRaw(precisionSum, suite.cases.length),
    top1Accuracy: ratio(top1Correct, suite.cases.length),
    noHitAccuracy: noHitCases > 0 ? ratio(noHitCorrect, noHitCases) : 1,
    forbiddenHits,
    missingExpected,
    latencyMs: latencyStats(latencyValues),
    byKind: Object.fromEntries(
      Object.entries(byKindRaw).map(([kind, stats]) => [
        kind,
        {
          total: stats.total,
          recallAtK: ratioRaw(stats.recallSum, stats.total),
          precisionAtK: ratioRaw(stats.precisionSum, stats.total),
          top1Accuracy: ratio(stats.top1Correct, stats.total),
        },
      ]),
    ),
    failures: failures.slice(0, 100),
    results,
  };
}

function skill(
  id: string,
  toolName: string,
  content: string,
  overrides: Partial<LearnedItem> = {},
): LearnedItem {
  return {
    id,
    kind: "skill",
    content,
    source: "tool_success",
    confidence: 0.9,
    reviewStatus: "approved",
    accessPaths: ["skill_registry"],
    provenance: {},
    retention: { canRetrieve: true, canTrain: true },
    training: { status: "not_queued" },
    parameterModuleIds: [],
    createdAt: "2026-06-18T16:00:00.000Z",
    updatedAt: "2026-06-18T16:00:00.000Z",
    metadata: { toolName },
    ...overrides,
  };
}

function evalCase(
  id: string,
  kind: SkillRetrievalCaseKind,
  query: string,
  candidateToolNames: string[],
  expectedSkillIds: string[],
  forbiddenSkillIds: string[] = [],
): SkillRetrievalEvalCase {
  return {
    id,
    kind,
    query,
    candidateToolNames,
    expectedSkillIds,
    forbiddenSkillIds,
    topK: 3,
    metadata: {},
  };
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

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function ratioRaw(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
