import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMProvider } from "../src/ai/llm/LLMProvider";
import type { LLMChatRequest, LLMChatResponse, LLMProviderInfo } from "../src/types/ai";
import { writeLongContextEvalSuite, type LongContextEvalCase } from "../src/training/eval/LongContextEvalSuite";
import { runLongContextEvalPredictions } from "../src/training/eval/LongContextEvalPredictionRunner";

describe("LongContextEvalPredictionRunner", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("marks eval requests as long-context and supports a preferred provider", async () => {
    dir = await mkdtemp(join(tmpdir(), "long-context-runner-"));
    const suite = join(dir, "long-context.eval.jsonl");
    const out = join(dir, "long-context.predictions.jsonl");
    await writeLongContextEvalSuite({
      outPath: suite,
      contextCharTargets: [1024],
      needlePositions: ["middle"],
    });
    const [evalCase] = await readJsonl<LongContextEvalCase>(suite);
    if (!evalCase) throw new Error("expected generated eval case");
    const provider = new EchoExpectedProvider(evalCase.expected);

    const summary = await runLongContextEvalPredictions({
      suitePath: suite,
      outPath: out,
      llm: provider,
      preferredProvider: "subq",
    });

    expect(summary.routedLongContext).toBe(true);
    expect(summary.preferredProvider).toBe("subq");
    expect(provider.requests[0]?.metadata).toMatchObject({
      longContext: true,
      preferredProvider: "subq",
      architectureTarget: "subquadratic-sparse-attention",
      needlePosition: "middle",
    });
    const predictions = await readJsonl(out);
    expect(predictions[0]).toMatchObject({ id: evalCase.id, output: evalCase.expected, model: "fake-subq" });
  });
});

class EchoExpectedProvider implements LLMProvider {
  readonly info: LLMProviderInfo = { name: "subq", model: "fake-subq", baseUrl: "memory://fake" };
  readonly requests: LLMChatRequest[] = [];

  constructor(private readonly expected: string) {}

  async generateChatCompletion(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(request);
    return {
      content: this.expected,
      raw: {},
      latencyMs: 12,
      model: this.info.model,
      finishReason: "stop",
    };
  }
}

async function readJsonl<T = unknown>(path: string): Promise<T[]> {
  await mkdir(join(path, ".."), { recursive: true });
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
