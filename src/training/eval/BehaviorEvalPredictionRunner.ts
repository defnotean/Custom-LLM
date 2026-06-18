import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LLMProvider } from "../../ai/llm/LLMProvider";
import { buildSafetySection } from "../../ai/prompts/safetyPrompt";
import { buildSystemPrompt } from "../../ai/prompts/systemPrompt";
import type { ChatMessage } from "../../types/ai";
import { toErrorMessage } from "../../utils/errors";
import type { BehaviorEvalCase } from "./BehaviorEvalSuite";
import type { EvalPrediction } from "./ToolEvalSuite";

export interface BehaviorEvalRunOptions {
  suitePath: string;
  outPath: string;
  llm: LLMProvider;
  maxCases?: number;
  maxTokens?: number;
  temperature?: number;
  botName?: string;
}

export interface BehaviorEvalRunSummary {
  outPath: string;
  attempted: number;
  written: number;
  errors: number;
  model: string;
}

export function buildBehaviorEvalMessages(
  evalCase: BehaviorEvalCase,
  options?: { botName?: string },
): ChatMessage[] {
  const system = buildSystemPrompt({
    botName: options?.botName ?? "Irene",
    guildName: "Custom LLM Eval",
    channelName: "behavior-eval",
    toolSection: null,
    safetySection: buildSafetySection(),
  });
  return [
    { role: "system", content: system },
    {
      role: "system",
      content:
        "Behavior eval context: no candidate tools are available for this prompt. Reply using the strict JSON protocol, and do not call tools.",
    },
    { role: "user", content: evalCase.prompt },
  ];
}

export async function runBehaviorEvalPredictions(
  options: BehaviorEvalRunOptions,
): Promise<BehaviorEvalRunSummary> {
  const cases = (await readJsonl(options.suitePath)) as BehaviorEvalCase[];
  const selected = cases.slice(0, options.maxCases ?? cases.length);
  const predictions: Array<EvalPrediction & { error?: string }> = [];
  let errors = 0;

  for (const evalCase of selected) {
    try {
      const response = await options.llm.generateChatCompletion({
        messages: buildBehaviorEvalMessages(evalCase, { botName: options.botName }),
        responseFormat: "json",
        temperature: options.temperature ?? 0,
        maxTokens: options.maxTokens ?? 256,
        metadata: { evalCaseId: evalCase.id, evalKind: evalCase.kind, evalRoute: evalCase.route },
      });
      predictions.push({
        id: evalCase.id,
        output: response.content,
        model: response.model,
        latencyMs: response.latencyMs,
      });
    } catch (err) {
      errors++;
      predictions.push({
        id: evalCase.id,
        output: "",
        model: options.llm.info.model,
        error: toErrorMessage(err),
      });
    }
  }

  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${predictions.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return {
    outPath: options.outPath,
    attempted: selected.length,
    written: predictions.length,
    errors,
    model: options.llm.info.model,
  };
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}
