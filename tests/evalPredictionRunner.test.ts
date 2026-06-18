import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolRegistry } from "../src/tools";
import { buildEvalMessages, runEvalPredictions } from "../src/training/eval/EvalPredictionRunner";
import type { ToolEvalCase } from "../src/training/eval/ToolEvalSuite";
import { MockLLMProvider } from "./helpers";

describe("EvalPredictionRunner", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds scoped eval prompts with only candidate tools", () => {
    const registry = buildToolRegistry();
    const candidate = registry.listTools()[0];
    if (!candidate) throw new Error("expected at least one registered tool");

    const toolCase: ToolEvalCase = {
      id: "case:tool",
      kind: "tool_call",
      prompt: "please run the selected tool",
      expected: { type: "tool_call", tool: candidate.name, arguments: {} },
      candidateTools: [candidate.name],
      metadata: {
        tool: candidate.name,
        requiredArgs: ["messageId"],
        providedArgs: { messageId: "abc123" },
        requiredPermissions: ["MANAGE_MESSAGES"],
        memberPermissions: ["MANAGE_MESSAGES"],
      },
    };
    const toolMessages = buildEvalMessages(toolCase, registry);

    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0]?.role).toBe("system");
    expect(toolMessages[0]?.content).toContain("Available tools");
    expect(toolMessages[0]?.content).toContain(candidate.name);
    expect(toolMessages[0]?.content).toContain("Output format");
    expect(toolMessages[1]?.content).toContain(`required arguments for ${candidate.name}: messageId`);
    expect(toolMessages[1]?.content).toContain(`only these candidate tools are allowed: ${candidate.name}`);
    expect(toolMessages[1]?.content).toContain("this request provides messageId=abc123");
    expect(toolMessages[1]?.content).toContain("return clarification");
    expect(toolMessages[1]?.content).toContain("invoking member has required permissions");
    expect(toolMessages[1]?.content).toContain("Do not refuse for permissions");
    expect(toolMessages[2]).toEqual({ role: "user", content: toolCase.prompt });

    const noToolMessages = buildEvalMessages(
      {
        id: "case:no-tool",
        kind: "no_tool",
        prompt: "just chat",
        expected: { type: "message", content: "ok" },
        candidateTools: [],
        metadata: {},
      },
      registry,
    );
    expect(noToolMessages[0]?.content).not.toContain("Available tools");
    expect(noToolMessages[0]?.content).toContain("Output format");
    expect(noToolMessages[1]?.content).toContain("no candidate tools are available");
    expect(noToolMessages[2]).toEqual({ role: "user", content: "just chat" });
  });

  it("adds explicit refusal and confirmation context to eval prompts", () => {
    const registry = buildToolRegistry();
    const missingArgMessages = buildEvalMessages(
      {
        id: "case:missing-arg",
        kind: "clarification",
        prompt: "recall memory please",
        expected: { type: "clarification", content: "which query?" },
        candidateTools: ["recall_memory"],
        metadata: {
          tool: "recall_memory",
          requiredArgs: ["query"],
          missingArg: "query",
        },
      },
      registry,
    );
    expect(missingArgMessages[1]?.content).toContain("missing required argument query");
    expect(missingArgMessages[1]?.content).toContain("Return clarification, not tool_call");

    const permissionMessages = buildEvalMessages(
      {
        id: "case:permission",
        kind: "permission_refusal",
        prompt: "delete that",
        expected: { type: "message", content: "no" },
        candidateTools: ["delete_message"],
        metadata: {
          tool: "delete_message",
          requiredArgs: ["messageId"],
          requiredPermissions: ["MANAGE_MESSAGES"],
          memberPermissions: [],
        },
      },
      registry,
    );
    expect(permissionMessages[1]?.content).toContain("required arguments for delete_message: messageId");
    expect(permissionMessages[1]?.content).toContain("lacks required permissions");
    expect(permissionMessages[1]?.content).toContain("do not request a tool_call");
    expect(permissionMessages[1]?.content).toContain("confirmation_request");

    const confirmationMessages = buildEvalMessages(
      {
        id: "case:confirm",
        kind: "confirmation_request",
        prompt: "timeout user",
        expected: {
          type: "confirmation_request",
          content: "confirm",
          pending_tool_call: { tool: "timeout_user", arguments: {} },
        },
        candidateTools: ["timeout_user"],
        metadata: { requiresConfirmation: true, confirmed: false, requiredPermissions: [], memberPermissions: [] },
      },
      registry,
    );
    expect(confirmationMessages[1]?.content).toContain("requires confirmation");
    expect(confirmationMessages[1]?.content).toContain("confirmation_request");

    const permissionBeforeConfirmationMessages = buildEvalMessages(
      {
        id: "case:permission-confirm",
        kind: "permission_refusal",
        prompt: "timeout user",
        expected: { type: "message", content: "no" },
        candidateTools: ["timeout_user"],
        metadata: {
          requiresConfirmation: true,
          confirmed: false,
          requiredPermissions: ["MODERATE_MEMBERS"],
          memberPermissions: [],
        },
      },
      registry,
    );
    expect(permissionBeforeConfirmationMessages[1]?.content).toContain("lacks required permissions");
    expect(permissionBeforeConfirmationMessages[1]?.content).not.toContain("requires confirmation before execution");
  });

  it("writes prediction JSONL and forwards eval metadata to the LLM", async () => {
    dir = await mkdtemp(join(tmpdir(), "eval-runner-"));
    const suitePath = join(dir, "suite.jsonl");
    const outPath = join(dir, "predictions.jsonl");
    const registry = buildToolRegistry();
    const candidate = registry.listTools()[0];
    if (!candidate) throw new Error("expected at least one registered tool");

    const cases: ToolEvalCase[] = [
      {
        id: "case:tool",
        kind: "tool_call",
        prompt: "run the tool",
        expected: { type: "tool_call", tool: candidate.name, arguments: {} },
        candidateTools: [candidate.name],
        metadata: {},
      },
      {
        id: "case:no-tool",
        kind: "no_tool",
        prompt: "say hi",
        expected: { type: "message", content: "hi" },
        candidateTools: [],
        metadata: {},
      },
    ];
    await writeFile(suitePath, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

    const llm = new MockLLMProvider([
      JSON.stringify({ type: "tool_call", tool: candidate.name, arguments: {} }),
      JSON.stringify({ type: "message", content: "hi" }),
    ]);
    const summary = await runEvalPredictions({
      suitePath,
      outPath,
      registry,
      llm,
      maxTokens: 42,
      temperature: 0.1,
    });

    expect(summary).toMatchObject({
      outPath,
      attempted: 2,
      written: 2,
      errors: 0,
      model: "mock-model",
    });
    const predictions = (await readFile(outPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(predictions).toHaveLength(2);
    expect(predictions[0]).toMatchObject({ id: "case:tool", model: "mock-model", latencyMs: 1 });
    expect(predictions[1]).toMatchObject({ id: "case:no-tool", model: "mock-model", latencyMs: 1 });

    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]).toMatchObject({
      responseFormat: "json",
      maxTokens: 42,
      temperature: 0.1,
      metadata: { evalCaseId: "case:tool", evalKind: "tool_call" },
    });
    expect(llm.requests[0]?.messages[0]?.content).toContain(candidate.name);
    expect(llm.requests[1]).toMatchObject({
      responseFormat: "json",
      metadata: { evalCaseId: "case:no-tool", evalKind: "no_tool" },
    });
    expect(llm.requests[1]?.messages[0]?.content).not.toContain("Available tools");
  });
});
