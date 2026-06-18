import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolRegistry } from "../src/tools";
import {
  applyToolRouterPromotionGate,
  evaluateToolRouter,
  scoreToolRouterPredictions,
  writeToolRouterEvalSuite,
  type ToolRouterEvalCase,
  type ToolRouterEvalPrediction,
} from "../src/training/eval/ToolRouterEvalSuite";

describe("ToolRouterEvalSuite", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("writes deterministic retrieval cases", async () => {
    dir = await mkdtemp(join(tmpdir(), "tool-router-eval-"));
    const suitePath = join(dir, "tool-router.eval.jsonl");
    const summary = await writeToolRouterEvalSuite(suitePath);
    expect(summary.cases).toBeGreaterThanOrEqual(25);
    expect(summary.toolCases).toBeGreaterThan(10);
    expect(summary.noToolCases).toBeGreaterThanOrEqual(7);
    expect(summary.sha256).toMatch(/^[a-f0-9]{64}$/);

    const cases = (await readFile(suitePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ToolRouterEvalCase);
    expect(cases.find((item) => item.id === "tool-router:timeout")).toMatchObject({
      expectedTools: ["timeout_user"],
      memberPermissions: ["MODERATE_MEMBERS"],
    });
    expect(cases.find((item) => item.id === "tool-router:permission:timeout-hidden")).toMatchObject({
      expectedTools: [],
      forbiddenTools: ["timeout_user"],
      memberPermissions: [],
    });
    expect(cases.find((item) => item.id === "tool-router:no-tool:tool-name-discussion")).toMatchObject({
      expectedLikelyNeedsTool: false,
      expectedTools: [],
      forbiddenTools: ["timeout_user"],
      memberPermissions: ["MODERATE_MEMBERS"],
    });
  });

  it("evaluates keyword retrieval against the live registry", async () => {
    dir = await mkdtemp(join(tmpdir(), "tool-router-eval-"));
    const suitePath = join(dir, "tool-router.eval.jsonl");
    await writeToolRouterEvalSuite(suitePath);

    const report = await evaluateToolRouter(suitePath, buildToolRegistry(), "keyword");
    expect(report.total).toBeGreaterThanOrEqual(25);
    expect(report.expectedToolRecall).toBe(1);
    expect(report.caseRecallAccuracy).toBe(1);
    expect(report.noToolAccuracy).toBe(1);
    expect(report.forbiddenCandidateRate).toBe(0);
    expect(report.missingExpectedTools).toBe(0);
    expect(report.forbiddenCandidateHits).toBe(0);

    const gate = applyToolRouterPromotionGate(report);
    expect(gate.status).toBe("pass");
  });

  it("reports missing expected tools and forbidden candidate leaks", () => {
    const cases: ToolRouterEvalCase[] = [
      {
        id: "case:missing",
        prompt: "ping please",
        expectedLikelyNeedsTool: true,
        expectedTools: ["ping"],
        forbiddenTools: [],
        memberPermissions: [],
        maxTools: 10,
        metadata: {},
      },
      {
        id: "case:forbidden",
        prompt: "timeout user",
        expectedLikelyNeedsTool: true,
        expectedTools: [],
        forbiddenTools: ["timeout_user"],
        memberPermissions: [],
        maxTools: 10,
        metadata: {},
      },
    ];
    const predictions: ToolRouterEvalPrediction[] = [
      {
        id: "case:missing",
        likelyNeedsTool: true,
        candidateTools: ["server_info"],
        reasoning: "wrong",
        confidence: 0.5,
        strategy: "keyword",
        latencyMs: 1,
      },
      {
        id: "case:forbidden",
        likelyNeedsTool: true,
        candidateTools: ["timeout_user"],
        reasoning: "leaked",
        confidence: 0.5,
        strategy: "keyword",
        latencyMs: 1,
      },
    ];

    const report = scoreToolRouterPredictions(cases, predictions, "suite.jsonl", "keyword");
    expect(report.expectedToolRecall).toBe(0);
    expect(report.caseRecallAccuracy).toBe(0);
    expect(report.forbiddenCandidateRate).toBe(1);
    expect(report.missingExpectedTools).toBe(1);
    expect(report.forbiddenCandidateHits).toBe(1);
    expect(report.failures.map((failure) => failure.reason)).toEqual(
      expect.arrayContaining(["missing expected tools: ping", "forbidden tools surfaced: timeout_user"]),
    );
    expect(applyToolRouterPromotionGate(report).status).toBe("fail");
  });
});
