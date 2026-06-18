import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBehaviorEvalMessages,
  runBehaviorEvalPredictions,
} from "../src/training/eval/BehaviorEvalPredictionRunner";
import type { BehaviorEvalCase } from "../src/training/eval/BehaviorEvalSuite";
import { MockLLMProvider } from "./helpers";

describe("BehaviorEvalPredictionRunner", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds strict no-tool behavior eval prompts with the she/her persona", () => {
    const evalCase = behaviorCase("persona:pronouns", "persona_identity", "persona", "what pronouns?");
    const messages = buildBehaviorEvalMessages(evalCase, { botName: "Irene" });

    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("You are Irene");
    expect(messages[0]?.content).toContain("You present as she/her");
    expect(messages[0]?.content).toContain("Output format - STRICT");
    expect(messages[0]?.content).not.toContain("Available tools");
    expect(messages[1]?.content).toContain("no candidate tools are available");
    expect(messages[1]?.content).toContain("do not call tools");
    expect(messages[2]).toEqual({ role: "user", content: "what pronouns?" });
  });

  it("writes prediction JSONL and forwards behavior metadata to the LLM", async () => {
    dir = await mkdtemp(join(tmpdir(), "behavior-eval-runner-"));
    const suitePath = join(dir, "suite.jsonl");
    const outPath = join(dir, "predictions.jsonl");
    const cases = [
      behaviorCase("persona:pronouns", "persona_identity", "persona", "what pronouns?"),
      behaviorCase("social:repair", "social_repair", "social_cue", "no, that's not what I meant"),
    ];
    await writeFile(suitePath, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

    const llm = new MockLLMProvider([
      JSON.stringify({ type: "message", content: "She/her." }),
      JSON.stringify({ type: "clarification", content: "What part did I misread?" }),
    ]);

    const summary = await runBehaviorEvalPredictions({
      suitePath,
      outPath,
      llm,
      maxTokens: 64,
      temperature: 0.15,
      botName: "Irene",
    });

    expect(summary).toMatchObject({ outPath, attempted: 2, written: 2, errors: 0, model: "mock-model" });
    const predictions = (await readFile(outPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(predictions).toHaveLength(2);
    expect(predictions[0]).toMatchObject({ id: "persona:pronouns", model: "mock-model", latencyMs: 1 });
    expect(predictions[1]).toMatchObject({ id: "social:repair", model: "mock-model", latencyMs: 1 });

    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]).toMatchObject({
      responseFormat: "json",
      maxTokens: 64,
      temperature: 0.15,
      metadata: { evalCaseId: "persona:pronouns", evalKind: "persona_identity", evalRoute: "persona" },
    });
    expect(llm.requests[1]).toMatchObject({
      responseFormat: "json",
      metadata: { evalCaseId: "social:repair", evalKind: "social_repair", evalRoute: "social_cue" },
    });
  });
});

function behaviorCase(
  id: string,
  kind: BehaviorEvalCase["kind"],
  route: BehaviorEvalCase["route"],
  prompt: string,
): BehaviorEvalCase {
  return {
    id,
    kind,
    route,
    prompt,
    expected: { actionType: "message", oracle: { type: "message", content: "ok" } },
    candidateTools: [],
    requirements: { allowToolCall: false },
    metadata: {},
  };
}
