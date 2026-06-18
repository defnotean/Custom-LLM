import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LLMProvider } from "../../ai/llm/LLMProvider";
import type { ChatMessage } from "../../types/ai";
import { toErrorMessage } from "../../utils/errors";
import type { KnowledgeEvalCase, KnowledgePrediction } from "./KnowledgeEvalSuite";

export interface KnowledgeEvalRunOptions {
  suitePath: string;
  outPath: string;
  llm: LLMProvider;
  maxCases?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface KnowledgeEvalRunSummary {
  outPath: string;
  attempted: number;
  written: number;
  errors: number;
  model: string;
}

const KNOWLEDGE_EVAL_SYSTEM_PROMPT =
  "You are being evaluated on held-out knowledge and instruction-following examples. " +
  "Answer the user directly and concisely. If the prompt includes context, ground the answer in that context. " +
  "Do not call tools, invent tool results, or wrap the answer in JSON.";

export function buildKnowledgeEvalMessages(evalCase: KnowledgeEvalCase): ChatMessage[] {
  return [
    { role: "system", content: KNOWLEDGE_EVAL_SYSTEM_PROMPT },
    { role: "user", content: evalCase.prompt },
  ];
}

export async function runKnowledgeEvalPredictions(
  options: KnowledgeEvalRunOptions,
): Promise<KnowledgeEvalRunSummary> {
  const cases = (await readJsonl(options.suitePath)) as KnowledgeEvalCase[];
  const selected = cases.slice(0, options.maxCases ?? cases.length);
  const predictions: Array<KnowledgePrediction & { error?: string }> = [];
  let errors = 0;

  for (const evalCase of selected) {
    try {
      const response = await options.llm.generateChatCompletion({
        messages: buildKnowledgeEvalMessages(evalCase),
        responseFormat: "text",
        temperature: options.temperature ?? 0,
        maxTokens: options.maxTokens ?? 512,
        metadata: { evalCaseId: evalCase.id, evalKind: "knowledge" },
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
