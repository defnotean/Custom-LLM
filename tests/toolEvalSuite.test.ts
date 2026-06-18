import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolRegistry } from "../src/tools";
import {
  buildToolEvalCases,
  evaluatePredictions,
  writeToolEvalSuite,
  type ToolEvalCase,
} from "../src/training/eval/ToolEvalSuite";

describe("ToolEvalSuite", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("generates held-out eval cases from the live tool registry", async () => {
    const registry = buildToolRegistry();
    const cases = buildToolEvalCases(registry, { maxTools: 5 });
    const allCases = buildToolEvalCases(registry);

    expect(cases.length).toBeGreaterThan(5);
    expect(cases.some((item) => item.kind === "tool_call")).toBe(true);
    expect(cases.some((item) => item.kind === "no_tool")).toBe(true);
    expect(cases.some((item) => item.kind === "no_tool" && item.metadata.adversarial === true)).toBe(true);
    expect(
      allCases
        .filter((item) => item.kind === "no_tool" && item.metadata.adversarial === true)
        .every((item) => item.candidateTools.length === 0 && item.expected.type === "message"),
    ).toBe(true);
    expect(allCases.find((item) => item.id === "no_tool:mentions_tool_name")?.prompt).toContain("timeout_user");
    expect(allCases.find((item) => item.id === "no_tool:json_tool_call_discussion")?.prompt).toContain("tool_call");
    expect(allCases.find((item) => item.id === "no_tool:quote_tool_names")?.metadata.mentionedTools).toEqual([
      "send_message",
      "delete_message",
    ]);
    expect(
      cases
        .filter((item) => item.kind === "permission_refusal")
        .every((item) => Array.isArray(item.metadata.requiredPermissions) && Array.isArray(item.metadata.memberPermissions)),
    ).toBe(true);
    expect(
      cases
        .filter((item) => item.kind === "confirmation_request")
        .every((item) => item.metadata.requiresConfirmation === true && item.metadata.confirmed === false),
    ).toBe(true);
    expect(
      cases
        .filter((item) => item.kind === "tool_call" && item.metadata.requiresConfirmation === true)
        .every((item) => item.metadata.confirmed === true),
    ).toBe(true);
    expect(allCases.some((item) => item.id === "tool:send_message:clarify")).toBe(true);
    expect(allCases.some((item) => item.id === "tool:summarize_channel_recent_messages:clarify")).toBe(false);
    expect(
      allCases
        .filter((item) => item.metadata.tool === "send_message")
        .every((item) => Array.isArray(item.metadata.requiredArgs) && item.metadata.requiredArgs.includes("content")),
    ).toBe(true);
    const addNumbersDirect = allCases.find((item) => item.id === "tool:add_numbers:direct");
    expect(addNumbersDirect?.prompt).toContain("a=1");
    expect(addNumbersDirect?.prompt).toContain("b=1");
    expect(addNumbersDirect?.metadata.providedArgs).toMatchObject({ a: 1, b: 1 });
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
  });

  it("writes a suite and scores prediction JSONL", async () => {
    dir = await mkdtemp(join(tmpdir(), "tool-eval-"));
    const suitePath = join(dir, "suite.jsonl");
    const predictionsPath = join(dir, "predictions.jsonl");
    const registry = buildToolRegistry();
    const summary = await writeToolEvalSuite(suitePath, registry, { maxTools: 3 });
    expect(summary.cases).toBeGreaterThan(3);

    const cases = (await readFile(suitePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ToolEvalCase);
    const predictions = cases.map((item, index) => {
      if (index === 0) return { id: item.id, output: "not json", latencyMs: 25 };
      if (item.expected.type === "tool_call") {
        return {
          id: item.id,
          output: JSON.stringify({
            type: "tool_call",
            tool: item.expected.tool,
            arguments: item.expected.arguments,
          }),
          latencyMs: 50 + index,
        };
      }
      if (item.expected.type === "confirmation_request") {
        return {
          id: item.id,
          output: JSON.stringify({
            type: "confirmation_request",
            content: "Confirm?",
            pending_tool_call: item.expected.pending_tool_call,
          }),
          latencyMs: 50 + index,
        };
      }
      return { id: item.id, output: JSON.stringify({ type: "message", content: "ok" }), latencyMs: 50 + index };
    });
    await mkdir(dir, { recursive: true });
    await writeFile(predictionsPath, `${predictions.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

    const report = await evaluatePredictions(suitePath, predictionsPath);
    expect(report.total).toBe(cases.length);
    expect(report.validJsonRate).toBeLessThan(1);
    expect(report.failures.some((failure) => failure.reason.includes("no JSON"))).toBe(true);
    expect(report.hallucinatedToolRate).toBe(0);
    expect(report.missingPredictions).toBe(0);
    expect(report.latencyMs.count).toBe(predictions.length);
    expect(report.latencyMs.p95).toBeGreaterThan(0);
  });

  it("records tool-name and argument failures, not only action-type failures", async () => {
    dir = await mkdtemp(join(tmpdir(), "tool-eval-"));
    const suitePath = join(dir, "suite.jsonl");
    const predictionsPath = join(dir, "predictions.jsonl");
    const cases: ToolEvalCase[] = [
      {
        id: "case:wrong-tool",
        kind: "tool_call",
        prompt: "run ping",
        expected: { type: "tool_call", tool: "ping", arguments: {} },
        candidateTools: ["ping"],
        metadata: {},
      },
      {
        id: "case:wrong-args",
        kind: "tool_call",
        prompt: "add",
        expected: { type: "tool_call", tool: "add_numbers", arguments: { a: 1, b: 1 } },
        candidateTools: ["add_numbers"],
        metadata: {},
      },
    ];
    await mkdir(dir, { recursive: true });
    await writeFile(suitePath, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    await writeFile(
      predictionsPath,
      [
        { id: "case:wrong-tool", output: JSON.stringify({ type: "tool_call", tool: "server_info", arguments: {} }) },
        { id: "case:wrong-args", output: JSON.stringify({ type: "tool_call", tool: "add_numbers", arguments: { a: 1 } }) },
      ].map((item) => JSON.stringify(item)).join("\n") + "\n",
      "utf8",
    );

    const report = await evaluatePredictions(suitePath, predictionsPath);
    expect(report.toolNameAccuracy).toBe(0.5);
    expect(report.toolArgumentValidity).toBe(0.5);
    expect(report.hallucinatedToolRate).toBe(0.5);
    expect(report.failures.map((failure) => failure.reason)).toEqual(
      expect.arrayContaining([
        "wrong tool: expected ping, got server_info",
        "tool not in candidate set: server_info",
        'wrong arguments: expected {"a":1,"b":1}, got {"a":1}',
      ]),
    );
  });
});
