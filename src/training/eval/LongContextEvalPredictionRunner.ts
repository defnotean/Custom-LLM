import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LLMProvider } from "../../ai/llm/LLMProvider";
import type { ChatMessage } from "../../types/ai";
import { toErrorMessage } from "../../utils/errors";
import type { LongContextEvalCase, LongContextPrediction } from "./LongContextEvalSuite";

export interface LongContextEvalRunOptions {
  suitePath: string;
  outPath: string;
  llm: LLMProvider;
  maxCases?: number;
  maxTokens?: number;
  temperature?: number;
  preferredProvider?: string;
}

export interface LongContextEvalRunSummary {
  outPath: string;
  attempted: number;
  written: number;
  errors: number;
  model: string;
  routedLongContext: true;
  preferredProvider?: string;
}

const LONG_CONTEXT_EVAL_SYSTEM_PROMPT =
  "You are being evaluated on long-context retrieval for a subquadratic sparse-attention architecture. " +
  "Use only the provided context, ignore distractor trace values, and answer with only the exact requested value. " +
  "Do not call tools, explain, invent values, or wrap the answer in JSON.";

export function buildLongContextEvalMessages(evalCase: LongContextEvalCase): ChatMessage[] {
  return [
    { role: "system", content: LONG_CONTEXT_EVAL_SYSTEM_PROMPT },
    { role: "user", content: evalCase.prompt },
  ];
}

export async function runLongContextEvalPredictions(
  options: LongContextEvalRunOptions,
): Promise<LongContextEvalRunSummary> {
  const cases = (await readJsonl(options.suitePath)) as LongContextEvalCase[];
  const selected = cases.slice(0, options.maxCases ?? cases.length);
  const predictions: Array<LongContextPrediction & { error?: string }> = [];
  let errors = 0;

  for (const evalCase of selected) {
    const metadata: Record<string, unknown> = {
      evalCaseId: evalCase.id,
      evalKind: "long-context-retrieval",
      longContext: true,
      architectureTarget: "subquadratic-sparse-attention",
      contextChars: evalCase.metadata.contextChars,
      needlePosition: evalCase.metadata.needlePosition,
      source: evalCase.source,
      taskType: evalCase.metadata.taskType,
    };
    if (options.preferredProvider) metadata.preferredProvider = options.preferredProvider;

    try {
      const response = await options.llm.generateChatCompletion({
        messages: buildLongContextEvalMessages(evalCase),
        responseFormat: "text",
        temperature: options.temperature ?? 0,
        maxTokens: options.maxTokens ?? 64,
        metadata,
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
    routedLongContext: true,
    ...(options.preferredProvider ? { preferredProvider: options.preferredProvider } : {}),
  };
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}
