import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBehaviorRouterIterationReadiness } from "../src/training/quality/BehaviorRouterIterationReadiness";

describe("BehaviorRouterIterationReadiness", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes strict, balanced behavior and router iteration data against known failed gates", async () => {
    const fixture = await writeFixture();

    const report = await checkBehaviorRouterIterationReadiness({
      ...fixture.options,
      minBehaviorRecords: 8,
      minRouterRecords: 6,
      minRecordsPerBehaviorRoute: 1,
      minRecordsPerRouterRoute: 1,
      now: () => "2026-06-19T19:00:00.000Z",
    });

    expect(report).toMatchObject({
      runtimeContract: "behavior-router-iteration-readiness-v1",
      generatedAt: "2026-06-19T19:00:00.000Z",
      status: "pass",
      summary: {
        behaviorRecords: 8,
        routerRecords: 6,
        behaviorEvalOverlaps: 0,
        routerEvalOverlaps: 0,
        behaviorPreviousFailures: ["validJsonRate", "requirementPassRate"],
        routerPreviousFailures: ["routeAccuracy", "invalidPredictions"],
      },
    });
    expect(checkStatus(report.checks, "behavior-assistant-json-schema")).toBe("pass");
    expect(checkStatus(report.checks, "router-assistant-json-schema")).toBe("pass");
    expect(checkStatus(report.checks, "behavior-current-failure-target")).toBe("pass");
    expect(checkStatus(report.checks, "router-current-failure-target")).toBe("pass");
    expect(report.nextActions.join(" ")).toContain("next behavior/router scratch training");
  });

  it("fails when data overlaps held-out evals or breaks strict JSON contracts", async () => {
    const fixture = await writeFixture({
      behaviorRows: [
        behaviorRecord("overlap", "persona_identity", "persona", "held out behavior prompt", "{not-json"),
      ],
      routerRows: [routerRecord("bad-router", "tool_protocol", "bad router prompt", "{\"route\":\"tool_protocol\"}")],
    });

    const report = await checkBehaviorRouterIterationReadiness({
      ...fixture.options,
      minBehaviorRecords: 1,
      minRouterRecords: 1,
      minRecordsPerBehaviorRoute: 1,
      minRecordsPerRouterRoute: 1,
    });

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "behavior-assistant-json-schema")).toBe("fail");
    expect(checkStatus(report.checks, "behavior-eval-overlap")).toBe("fail");
    expect(checkStatus(report.checks, "router-assistant-json-schema")).toBe("fail");
  });

  async function writeFixture(overrides: Partial<FixtureRows> = {}): Promise<{ options: FixtureOptions }> {
    dir = await mkdtemp(join(tmpdir(), "behavior-router-readiness-"));
    const behaviorDatasetPath = join(dir, "behavior", "sft.all.jsonl");
    const behaviorEvalSuitePath = join(dir, "evals", "behavior.eval.jsonl");
    const behaviorGatePath = join(dir, "evals", "behavior.gate.json");
    const routerDatasetPath = join(dir, "router", "sft.all.jsonl");
    const routerEvalSuitePath = join(dir, "evals", "specialist-routing.eval.jsonl");
    const routerGatePath = join(dir, "evals", "router.gate.json");
    await mkdir(join(dir, "behavior"), { recursive: true });
    await mkdir(join(dir, "router"), { recursive: true });
    await mkdir(join(dir, "evals"), { recursive: true });

    await writeJsonl(behaviorDatasetPath, overrides.behaviorRows ?? behaviorRows());
    await writeJsonl(routerDatasetPath, overrides.routerRows ?? routerRows());
    await writeJsonl(behaviorEvalSuitePath, [{ id: "heldout-behavior", prompt: "held out behavior prompt" }]);
    await writeJsonl(routerEvalSuitePath, [{ id: "heldout-router", prompt: "held out router prompt" }]);
    await writeJson(behaviorGatePath, gate(["validJsonRate", "requirementPassRate"]));
    await writeJson(routerGatePath, gate(["routeAccuracy", "invalidPredictions"]));

    return {
      options: {
        behaviorDatasetPath,
        behaviorEvalSuitePath,
        behaviorGatePath,
        routerDatasetPath,
        routerEvalSuitePath,
        routerGatePath,
      },
    };
  }
});

interface FixtureOptions {
  behaviorDatasetPath: string;
  behaviorEvalSuitePath: string;
  behaviorGatePath: string;
  routerDatasetPath: string;
  routerEvalSuitePath: string;
  routerGatePath: string;
}

interface FixtureRows {
  behaviorRows: unknown[];
  routerRows: unknown[];
}

function behaviorRows(): unknown[] {
  return [
    behaviorRecord("persona-identity", "persona_identity", "persona", "what pronouns?", action("message", "Irene. She/her.")),
    behaviorRecord("persona-emotion", "persona_emotion", "persona", "be warmer", action("message", "Yeah. I can keep it warmer.")),
    behaviorRecord("casual", "casual_conversation", "casual", "that was cooked", action("message", "Fully cooked.")),
    behaviorRecord("support", "social_support", "social_cue", "i'm stuck", action("message", "That is rough. Show me the failing part.")),
    behaviorRecord("repair", "social_repair", "social_cue", "not what I meant", action("clarification", "What did I miss?")),
    behaviorRecord("clarify", "clarification", "social_cue", "do the thing", action("clarification", "Which thing?")),
    behaviorRecord("boundary", "social_boundary", "boundary", "steal an account", action("message", "No. I can help secure your account.")),
    behaviorRecord("abstain", "tool_abstain", "tool_abstain", "no tools, vibe check", action("message", "Vibe check: solid.")),
  ];
}

function routerRows(): unknown[] {
  return [
    routerRecord("tool", "tool_protocol", "timeout spammer"),
    routerRecord("knowledge", "knowledge", "explain QLoRA"),
    routerRecord("persona", "persona", "what pronouns?"),
    routerRecord("casual", "casual", "pizza valid or cursed"),
    routerRecord("social", "social_cue", "i'm exhausted"),
    routerRecord("boundary", "boundary", "steal a password"),
  ];
}

function behaviorRecord(id: string, kind: string, route: string, prompt: string, assistant: string): unknown {
  return {
    messages: [
      { role: "system", content: "You present as she/her. Output format - STRICT JSON." },
      { role: "user", content: prompt },
      { role: "assistant", content: assistant },
    ],
    metadata: { id, kind, route },
  };
}

function routerRecord(id: string, route: string, prompt: string, assistant?: string): unknown {
  const expert = route === "tool_protocol" ? "tool" : route === "knowledge" ? "knowledge" : route === "boundary" ? "safety" : "conversation";
  return {
    messages: [
      { role: "system", content: "You are a specialist router. Respond with ONLY JSON." },
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: assistant ?? JSON.stringify({ route, expert, confidence: 0.95, reason: "fixture" }),
      },
    ],
    metadata: { id, route, expert },
  };
}

function action(type: "message" | "clarification", content: string): string {
  return JSON.stringify({ type, content });
}

function gate(metrics: string[]): unknown {
  return { status: "fail", failures: metrics.map((metric) => ({ metric, message: `${metric} failed` })) };
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function checkStatus(checks: Array<{ id: string; status: string }>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}
