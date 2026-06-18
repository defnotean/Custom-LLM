import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssistantAction } from "../../types/ai";
import { parseAssistantResponse } from "../../ai/parsing/parseAssistantResponse";
import { requiredArgKeys, sampleFromSchema } from "../../tools/schemaIntrospect";
import type { ToolRegistry } from "../../tools/ToolRegistry";

export type EvalCaseKind =
  | "tool_call"
  | "confirmation_request"
  | "clarification"
  | "permission_refusal"
  | "no_tool";

export interface ToolEvalCase {
  id: string;
  kind: EvalCaseKind;
  prompt: string;
  expected: AssistantAction;
  candidateTools: string[];
  metadata: Record<string, unknown>;
}

export interface EvalSuiteSummary {
  path: string;
  cases: number;
  byKind: Record<string, number>;
  sha256: string;
}

export interface EvalPrediction {
  id: string;
  output: string;
  model?: string;
  latencyMs?: number;
}

export interface EvalMetrics {
  total: number;
  parseOk: number;
  validJsonRate: number;
  actionTypeAccuracy: number;
  toolNameAccuracy: number | null;
  toolArgumentValidity: number | null;
  noToolAccuracy: number | null;
  hallucinatedToolRate: number;
  missingPredictions: number;
  latencyMs: EvalLatencyStats;
  byKind: Record<string, { total: number; correctType: number; correctTool: number; validArgs: number }>;
}

export interface EvalLatencyStats {
  count: number;
  average: number | null;
  p95: number | null;
  max: number | null;
}

export interface EvalReport extends EvalMetrics {
  suitePath: string;
  predictionsPath: string;
  failures: Array<{ id: string; kind: EvalCaseKind; reason: string; output?: string }>;
}

export function buildToolEvalCases(registry: ToolRegistry, options?: { maxTools?: number }): ToolEvalCase[] {
  const tools = registry.listTools().slice(0, options?.maxTools ?? 100);
  const cases: ToolEvalCase[] = [];

  for (const tool of tools) {
    const args = (sampleFromSchema(tool.argsSchema) ?? {}) as Record<string, unknown>;
    const phrase = heldOutToolPrompt(tool.name, args);
    const requiredPermissions = tool.requiredDiscordPermissions ?? [];
    const requiredArgs = requiredArgKeys(tool.argsSchema);
    cases.push({
      id: tool.requiresConfirmation ? `tool:${tool.name}:confirmed` : `tool:${tool.name}:direct`,
      kind: "tool_call",
      prompt: phrase,
      expected: { type: "tool_call", tool: tool.name, arguments: args },
      candidateTools: [tool.name],
      metadata: {
        tool: tool.name,
        category: tool.category,
        riskLevel: tool.riskLevel,
        requiresConfirmation: tool.requiresConfirmation,
        confirmed: tool.requiresConfirmation,
        requiredPermissions,
        memberPermissions: requiredPermissions,
        requiredArgs,
        providedArgs: args,
      },
    });

    if (tool.requiresConfirmation) {
      cases.push({
        id: `tool:${tool.name}:confirm`,
        kind: "confirmation_request",
        prompt: phrase,
        expected: {
          type: "confirmation_request",
          content: "confirm risky action",
          pending_tool_call: { tool: tool.name, arguments: args },
        },
        candidateTools: [tool.name],
        metadata: {
          tool: tool.name,
          riskLevel: tool.riskLevel,
          requiresConfirmation: true,
          confirmed: false,
          requiredPermissions,
          memberPermissions: requiredPermissions,
          requiredArgs,
          providedArgs: args,
        },
      });
    }

    const requiredArg = requiredArgs[0];
    if (requiredArg) {
      cases.push({
        id: `tool:${tool.name}:clarify`,
        kind: "clarification",
        prompt: `${tool.name.replace(/_/g, " ")} please`,
        expected: { type: "clarification", content: `Ask for ${requiredArg}` },
        candidateTools: [tool.name],
        metadata: { tool: tool.name, missingArg: requiredArg, requiredArgs },
      });
    }

    if ((tool.requiredDiscordPermissions ?? []).length > 0) {
      cases.push({
        id: `tool:${tool.name}:permission`,
        kind: "permission_refusal",
        prompt: phrase,
        expected: { type: "message", content: "permission refusal" },
        candidateTools: [tool.name],
        metadata: {
          tool: tool.name,
          requiresConfirmation: tool.requiresConfirmation,
          confirmed: false,
          requiredPermissions,
          memberPermissions: [],
          requiredArgs,
          providedArgs: args,
        },
      });
    }
  }

  cases.push(
    {
      id: "no_tool:casual_1",
      kind: "no_tool",
      prompt: "lol that was wild",
      expected: { type: "message", content: "casual reply" },
      candidateTools: [],
      metadata: {},
    },
    {
      id: "no_tool:opinion_1",
      kind: "no_tool",
      prompt: "what do you think about pineapple pizza",
      expected: { type: "message", content: "opinion reply" },
      candidateTools: [],
      metadata: {},
    },
  );

  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

export async function writeToolEvalSuite(
  path: string,
  registry: ToolRegistry,
  options?: { maxTools?: number },
): Promise<EvalSuiteSummary> {
  const cases = buildToolEvalCases(registry, options);
  await mkdir(dirname(path), { recursive: true });
  const body = `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`;
  await writeFile(path, body, "utf8");
  return {
    path,
    cases: cases.length,
    byKind: countBy(cases.map((item) => item.kind)),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

export async function evaluatePredictions(suitePath: string, predictionsPath: string): Promise<EvalReport> {
  const cases = (await readJsonl(suitePath)) as ToolEvalCase[];
  const predictions = (await readJsonl(predictionsPath)) as EvalPrediction[];
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  const latencyMs = predictions
    .map((prediction) => prediction.latencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const failures: EvalReport["failures"] = [];
  const byKind: EvalMetrics["byKind"] = {};

  let parseOk = 0;
  let correctType = 0;
  let toolCases = 0;
  let toolNameCases = 0;
  let correctTool = 0;
  let validArgs = 0;
  let noToolCases = 0;
  let noToolCorrect = 0;
  let hallucinated = 0;
  let missing = 0;

  for (const item of cases) {
    const kindMetrics =
      byKind[item.kind] ?? (byKind[item.kind] = { total: 0, correctType: 0, correctTool: 0, validArgs: 0 });
    kindMetrics.total++;
    const prediction = byId.get(item.id);
    if (!prediction) {
      missing++;
      failures.push({ id: item.id, kind: item.kind, reason: "missing prediction" });
      continue;
    }
    const parsed = parseAssistantResponse(prediction.output);
    if (parsed.parseOk) parseOk++;
    else failures.push({ id: item.id, kind: item.kind, reason: parsed.parseError ?? "parse failed", output: prediction.output });

    if (parsed.action.type === item.expected.type) {
      correctType++;
      kindMetrics.correctType++;
    } else {
      failures.push({
        id: item.id,
        kind: item.kind,
        reason: `wrong action type: expected ${item.expected.type}, got ${parsed.action.type}`,
        output: prediction.output,
      });
    }

    if (item.expected.type === "tool_call") {
      toolCases++;
      toolNameCases++;
      if (parsed.action.type === "tool_call" && parsed.action.tool === item.expected.tool) {
        correctTool++;
        kindMetrics.correctTool++;
      } else if (parsed.action.type === "tool_call") {
        failures.push({
          id: item.id,
          kind: item.kind,
          reason: `wrong tool: expected ${item.expected.tool}, got ${parsed.action.tool}`,
          output: prediction.output,
        });
      }
      if (parsed.action.type === "tool_call" && !item.candidateTools.includes(parsed.action.tool)) {
        hallucinated++;
        failures.push({
          id: item.id,
          kind: item.kind,
          reason: `tool not in candidate set: ${parsed.action.tool}`,
          output: prediction.output,
        });
      }
      if (parsed.action.type === "tool_call") {
        const validation = registrylessArgMatch(parsed.action.arguments, item.expected.arguments);
        if (validation) {
          validArgs++;
          kindMetrics.validArgs++;
        } else {
          failures.push({
            id: item.id,
            kind: item.kind,
            reason: `wrong arguments: expected ${JSON.stringify(item.expected.arguments)}, got ${JSON.stringify(parsed.action.arguments)}`,
            output: prediction.output,
          });
        }
      }
    }

    if (item.kind === "confirmation_request" && parsed.action.type === "confirmation_request") {
      toolNameCases++;
      const expectedTool = item.expected.type === "confirmation_request" ? item.expected.pending_tool_call.tool : null;
      if (parsed.action.pending_tool_call.tool === expectedTool) {
        correctTool++;
        kindMetrics.correctTool++;
      } else {
        failures.push({
          id: item.id,
          kind: item.kind,
          reason: `wrong pending tool: expected ${expectedTool ?? "unknown"}, got ${parsed.action.pending_tool_call.tool}`,
          output: prediction.output,
        });
      }
    }

    if (item.kind === "no_tool" || item.kind === "permission_refusal" || item.kind === "clarification") {
      noToolCases++;
      if (parsed.action.type !== "tool_call") noToolCorrect++;
      if (parsed.action.type === "tool_call") hallucinated++;
    }
  }

  return {
    suitePath,
    predictionsPath,
    total: cases.length,
    parseOk,
    validJsonRate: ratio(parseOk, cases.length),
    actionTypeAccuracy: ratio(correctType, cases.length),
    toolNameAccuracy: toolNameCases > 0 ? ratio(correctTool, toolNameCases) : null,
    toolArgumentValidity: toolCases > 0 ? ratio(validArgs, toolCases) : null,
    noToolAccuracy: noToolCases > 0 ? ratio(noToolCorrect, noToolCases) : null,
    hallucinatedToolRate: ratio(hallucinated, cases.length),
    missingPredictions: missing,
    latencyMs: latencyStats(latencyMs),
    byKind,
    failures: failures.slice(0, 100),
  };
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function registrylessArgMatch(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
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

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function heldOutToolPrompt(toolName: string, args: Record<string, unknown>): string {
  const toolWords = toolName.replace(/_/g, " ");
  const argsText = argumentsPromptText(args);
  return argsText ? `please execute ${toolWords} using ${argsText}` : `please execute ${toolWords}`;
}

function argumentsPromptText(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${formatPromptValue(value)}`)
    .join(", ");
}

function formatPromptValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  return JSON.stringify(value);
}
