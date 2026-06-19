import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBehaviorEvalCases,
  evaluateBehaviorPredictions,
  writeBehaviorEvalSuite,
  type BehaviorEvalCase,
} from "../src/training/eval/BehaviorEvalSuite";

describe("BehaviorEvalSuite", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("generates persona, social-cue, casual, and tool-abstain cases", () => {
    const cases = buildBehaviorEvalCases();
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.some((item) => item.kind === "persona_identity")).toBe(true);
    expect(cases.some((item) => item.kind === "persona_emotion")).toBe(true);
    expect(cases.some((item) => item.kind === "social_support")).toBe(true);
    expect(cases.some((item) => item.kind === "social_boundary")).toBe(true);
    expect(cases.some((item) => item.kind === "tool_abstain")).toBe(true);
    expect(cases.every((item) => item.candidateTools.length === 0)).toBe(true);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
  });

  it("writes a suite and scores oracle predictions as perfect", async () => {
    dir = await mkdtemp(join(tmpdir(), "behavior-eval-"));
    const suitePath = join(dir, "suite.jsonl");
    const predictionsPath = join(dir, "predictions.jsonl");
    const summary = await writeBehaviorEvalSuite(suitePath);
    expect(summary.cases).toBeGreaterThanOrEqual(10);
    expect(summary.byRoute.persona).toBeGreaterThan(0);

    const cases = (await readFile(suitePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as BehaviorEvalCase);
    const predictions = cases.map((item, index) => ({
      id: item.id,
      output: JSON.stringify(item.expected.oracle),
      latencyMs: 20 + index,
    }));
    await writeFile(predictionsPath, `${predictions.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

    const report = await evaluateBehaviorPredictions(suitePath, predictionsPath);
    expect(report.total).toBe(cases.length);
    expect(report.validJsonRate).toBe(1);
    expect(report.actionTypeAccuracy).toBe(1);
    expect(report.requirementPassRate).toBe(1);
    expect(report.personaConsistencyRate).toBe(1);
    expect(report.socialCueAccuracy).toBe(1);
    expect(report.toolAbstainAccuracy).toBe(1);
    expect(report.boundaryAccuracy).toBe(1);
    expect(report.failures).toEqual([]);
  });

  it("flags generic, wrong-pronoun, and accidental tool-call behavior", async () => {
    dir = await mkdtemp(join(tmpdir(), "behavior-eval-"));
    const suitePath = join(dir, "suite.jsonl");
    const predictionsPath = join(dir, "predictions.jsonl");
    const cases: BehaviorEvalCase[] = [
      {
        id: "persona",
        kind: "persona_identity",
        route: "persona",
        prompt: "pronouns?",
        expected: { actionType: "message", oracle: { type: "message", content: "She/her." } },
        candidateTools: [],
        requirements: { anyOf: ["she/her"], noneOf: ["he/him"], allowToolCall: false },
        metadata: {},
      },
      {
        id: "tool",
        kind: "tool_abstain",
        route: "tool_abstain",
        prompt: "just chat",
        expected: { actionType: "message", oracle: { type: "message", content: "Just chatting." } },
        candidateTools: [],
        requirements: { anyOf: ["chat"], allowToolCall: false },
        metadata: {},
      },
    ];
    await mkdir(dir, { recursive: true });
    await writeFile(suitePath, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    await writeFile(
      predictionsPath,
      [
        { id: "persona", output: JSON.stringify({ type: "message", content: "He/him works." }) },
        { id: "tool", output: JSON.stringify({ type: "tool_call", tool: "search", arguments: {} }) },
      ].map((item) => JSON.stringify(item)).join("\n") + "\n",
      "utf8",
    );

    const report = await evaluateBehaviorPredictions(suitePath, predictionsPath);
    expect(report.actionTypeAccuracy).toBe(0.5);
    expect(report.requirementPassRate).toBe(0);
    expect(report.personaConsistencyRate).toBe(0);
    expect(report.toolAbstainAccuracy).toBe(0.5);
    expect(report.failures.map((failure) => failure.reason)).toEqual(
      expect.arrayContaining([
        "contained forbidden phrase: he/him",
        "wrong action type: expected message, got tool_call",
        "tool call was not allowed for this behavior case",
      ]),
    );
  });

  it("normalizes slash spacing for she/her persona checks", async () => {
    dir = await mkdtemp(join(tmpdir(), "behavior-eval-"));
    const suitePath = join(dir, "suite.jsonl");
    const predictionsPath = join(dir, "predictions.jsonl");
    const cases: BehaviorEvalCase[] = [
      {
        id: "persona",
        kind: "persona_identity",
        route: "persona",
        prompt: "pronouns?",
        expected: { actionType: "message", oracle: { type: "message", content: "She/her." } },
        candidateTools: [],
        requirements: { anyOf: ["she/her"], noneOf: ["he/him"], allowToolCall: false },
        metadata: {},
      },
    ];
    await mkdir(dir, { recursive: true });
    await writeFile(suitePath, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    await writeFile(
      predictionsPath,
      `${JSON.stringify({ id: "persona", output: JSON.stringify({ type: "message", content: "She / her works." }) })}\n`,
      "utf8",
    );

    const report = await evaluateBehaviorPredictions(suitePath, predictionsPath);
    expect(report.validJsonRate).toBe(1);
    expect(report.requirementPassRate).toBe(1);
    expect(report.personaConsistencyRate).toBe(1);
    expect(report.failures).toEqual([]);
  });
});
