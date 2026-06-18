import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkProductionTrainingReadiness } from "../src/training/quality/ProductionTrainingReadiness";

describe("ProductionTrainingReadiness", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes the SFT preflight while warning about missing first-party bot signal", async () => {
    const fixture = await writeFixture();

    const report = await checkProductionTrainingReadiness(fixture.options);

    expect(report.status).toBe("ready");
    expect(report.summary).toMatchObject({
      sftTrain: 3,
      sftValidation: 1,
      preferenceTotal: 2,
      preferenceSyntheticOnly: true,
    });
    expect(checkStatus(report.checks, "sft-first-party-signal")).toBe("warn");
    expect(checkStatus(report.checks, "sft-token-headroom")).toBe("pass");
    expect(checkStatus(report.checks, "behavior-eval-harness")).toBe("pass");
    expect(checkStatus(report.checks, "router-eval-harness")).toBe("pass");
    expect(checkStatus(report.checks, "tool-router-eval-harness")).toBe("pass");
    expect(checkStatus(report.checks, "long-context-eval-harness")).toBe("pass");
    expect(checkStatus(report.checks, "subq-architecture-contract")).toBe("pass");
    expect(checkStatus(report.checks, "dpo-real-preferences")).toBe("warn");
  });

  it("blocks Qwen3.5 QLoRA configs in the production readiness profile", async () => {
    const fixture = await writeFixture({
      axolotlSft:
        goodAxolotlSftConfig().replace("Qwen/Qwen3-4B-Instruct-2507", "Qwen/Qwen3.5-4B"),
    });

    const report = await checkProductionTrainingReadiness(fixture.options);

    expect(report.status).toBe("not_ready");
    expect(checkStatus(report.checks, "sft-no-qwen35-qlora")).toBe("fail");
  });

  it("fails SFT readiness when the longest rows exceed configured tokenizer headroom", async () => {
    const fixture = await writeFixture();

    const report = await checkProductionTrainingReadiness({
      ...fixture.options,
      maxSftTokenBudgetUsage: 0.001,
    });

    expect(report.status).toBe("not_ready");
    expect(checkStatus(report.checks, "sft-token-headroom")).toBe("fail");
  });

  it("fails DPO readiness when preference data is synthetic-only and too small", async () => {
    const fixture = await writeFixture();

    const report = await checkProductionTrainingReadiness({ ...fixture.options, stage: "dpo" });

    expect(report.status).toBe("not_ready");
    expect(checkStatus(report.checks, "dpo-preference-volume")).toBe("fail");
    expect(checkStatus(report.checks, "dpo-real-preferences")).toBe("fail");
  });

  async function writeFixture(overrides: Partial<FixtureOverrides> = {}): Promise<{
    options: Parameters<typeof checkProductionTrainingReadiness>[0];
  }> {
    dir = await mkdtemp(join(tmpdir(), "production-readiness-"));
    const dataDir = join(dir, "data");
    const configDir = join(dir, "configs");
    const evalDir = join(dir, "evals");
    await mkdir(dataDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(evalDir, { recursive: true });

    const sftTrain = join(dataDir, "production-sft.train.jsonl");
    const sftValidation = join(dataDir, "production-sft.validation.jsonl");
    const dpoTrain = join(dataDir, "production-dpo.train.jsonl");
    const dpoValidation = join(dataDir, "production-dpo.validation.jsonl");
    await writeFile(sftTrain, `${chatRecord("sft-1")}\n${chatRecord("sft-2")}\n${chatRecord("sft-3")}\n`, "utf8");
    await writeFile(sftValidation, `${chatRecord("sft-val")}\n`, "utf8");
    await writeFile(dpoTrain, `${dpoRecord("dpo-1")}\n`, "utf8");
    await writeFile(dpoValidation, `${dpoRecord("dpo-val")}\n`, "utf8");

    const sftReportPath = join(dataDir, "production-sft.report.json");
    const preferenceReportPath = join(dataDir, "production-dpo.report.json");
    await writeJson(sftReportPath, {
      train: 3,
      validation: 1,
      maxSyntheticShare: 0.2,
      syntheticTrainShare: 0.1,
      sources: [
        sourceSummary("open_sft_train", sftTrain, "open_sft", true, 3),
        sourceSummary("bot_chatml_train", join(dataDir, "missing-chatml.jsonl"), "bot_log", false, 0, false),
      ],
      files: [await fileReport(sftTrain), await fileReport(sftValidation)],
    });
    await writeJson(preferenceReportPath, {
      train: 1,
      validation: 1,
      total: 2,
      synthetic: 2,
      syntheticShare: 1,
      syntheticOnly: true,
      sources: [sourceSummary("synthetic_tool_preferences", dpoTrain, "synthetic", false, 2)],
      files: [await fileReport(dpoTrain), await fileReport(dpoValidation)],
    });

    const toolEvalReportPath = join(evalDir, "oracle.report.json");
    const knowledgeEvalReportPath = join(evalDir, "knowledge-oracle.report.json");
    const behaviorEvalReportPath = join(evalDir, "behavior-oracle.report.json");
    const routerEvalReportPath = join(evalDir, "specialist-routing-oracle.report.json");
    const toolRouterEvalReportPath = join(evalDir, "tool-router-keyword.report.json");
    const longContextEvalReportPath = join(evalDir, "long-context-oracle.report.json");
    const longContextSuitePath = join(evalDir, "long-context.eval.jsonl");
    await writeJson(toolEvalReportPath, {
      total: 35,
      validJsonRate: 1,
      actionTypeAccuracy: 1,
      toolNameAccuracy: 1,
      toolArgumentValidity: 1,
      noToolAccuracy: 1,
      hallucinatedToolRate: 0,
      missingPredictions: 0,
      failures: [],
    });
    await writeJson(knowledgeEvalReportPath, {
      total: 200,
      answerRate: 1,
      averageTokenF1: 1,
      averageRougeL: 1,
      missingPredictions: 0,
      lowScoreCount: 0,
      failures: [],
    });
    await writeJson(behaviorEvalReportPath, {
      total: 11,
      validJsonRate: 1,
      actionTypeAccuracy: 1,
      requirementPassRate: 1,
      personaConsistencyRate: 1,
      socialCueAccuracy: 1,
      casualToneAccuracy: 1,
      toolAbstainAccuracy: 1,
      boundaryAccuracy: 1,
      missingPredictions: 0,
      failures: [],
    });
    await writeJson(routerEvalReportPath, {
      total: 18,
      routeAccuracy: 1,
      expertAccuracy: 1,
      toolVsNonToolAccuracy: 1,
      missingPredictions: 0,
      invalidPredictions: 0,
      failures: [],
    });
    await writeJson(toolRouterEvalReportPath, {
      total: 25,
      expectedToolRecall: 1,
      caseRecallAccuracy: 1,
      top1Accuracy: 1,
      likelyNeedsToolAccuracy: 1,
      noToolAccuracy: 1,
      forbiddenCandidateRate: 0,
      missingExpectedTools: 0,
      forbiddenCandidateHits: 0,
      failures: [],
    });
    await writeJson(longContextEvalReportPath, {
      total: 17,
      answerRate: 1,
      exactMatchRate: 1,
      expectedContainRate: 1,
      missingPredictions: 0,
      falsePositiveRate: 0,
      failures: [],
    });
    await writeLongContextSuiteFixture(longContextSuitePath);

    const axolotlSftConfigPath = join(configDir, "qwen3-qlora-sft.yaml");
    const axolotlDpoConfigPath = join(configDir, "qwen3-qlora-dpo.yaml");
    const unslothSftConfigPath = join(configDir, "qwen3_qlora_sft.py");
    const unslothDpoConfigPath = join(configDir, "qwen3_dpo.py");
    const llmRouterSourcePath = join(configDir, "LLMRouter.ts");
    const tinyTrainerPath = join(configDir, "train_tiny_transformer_lm.py");
    const tinyEvaluatorPath = join(configDir, "evaluate_tiny_transformer_lm.py");
    await writeFile(axolotlSftConfigPath, overrides.axolotlSft ?? goodAxolotlSftConfig(), "utf8");
    await writeFile(axolotlDpoConfigPath, overrides.axolotlDpo ?? goodAxolotlDpoConfig(), "utf8");
    await writeFile(unslothSftConfigPath, overrides.unslothSft ?? goodUnslothSftConfig(), "utf8");
    await writeFile(unslothDpoConfigPath, overrides.unslothDpo ?? goodUnslothDpoConfig(), "utf8");
    await writeFile(
      llmRouterSourcePath,
      'const preferredProvider = request.metadata?.preferredProvider;\nconst provider = request.metadata?.longContext === true ? "subq" : preferredProvider;\n',
      "utf8",
    );
    await writeFile(
      tinyTrainerPath,
      'parser.add_argument("--attention-mode", choices=["dense", "local-log-sparse"])\ndef sparse_attention_indices(): pass\ndef local_log_sparse_attention(): pass\nsparse_local_window = 32\nsparse_log_base = 2\n',
      "utf8",
    );
    await writeFile(
      tinyEvaluatorPath,
      'attention_mode=str(config.get("attention_mode", "dense"))\nsparse_local_window=int(config.get("sparse_local_window", 32))\nsparse_log_base=int(config.get("sparse_log_base", 2))\n',
      "utf8",
    );

    return {
      options: {
        sftReportPath,
        preferenceReportPath,
        toolEvalReportPath,
        knowledgeEvalReportPath,
        behaviorEvalReportPath,
        routerEvalReportPath,
        toolRouterEvalReportPath,
        longContextEvalReportPath,
        longContextSuitePath,
        llmRouterSourcePath,
        tinyTrainerPath,
        tinyEvaluatorPath,
        axolotlSftConfigPath,
        axolotlDpoConfigPath,
        unslothSftConfigPath,
        unslothDpoConfigPath,
        minSftTrainRecords: 3,
        minSftValidationRecords: 1,
        minPreferenceRecords: 3,
      },
    };
  }
});

interface FixtureOverrides {
  axolotlSft: string;
  axolotlDpo: string;
  unslothSft: string;
  unslothDpo: string;
}

function checkStatus(checks: Array<{ id: string; status: string }>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}

async function writeJson(path: string, body: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

async function writeLongContextSuiteFixture(path: string): Promise<void> {
  const required = [
    ["synthetic-needle-in-context", "needle_retrieval"],
    ["synthetic-repo-artifact", "repo_file_lookup"],
    ["synthetic-repo-artifact", "repo_env_lookup"],
    ["synthetic-repo-artifact", "repo_routing_contract"],
    ["real-repo-snapshot", "repo_script_lookup"],
    ["real-repo-snapshot", "repo_readiness_contract"],
    ["real-repo-snapshot", "repo_router_provider"],
    ["real-repo-multifile", "repo_script_readiness_chain"],
    ["real-repo-multifile", "repo_router_subq_chain"],
  ] as const;
  const rows = [
    ...required.map(([source, taskType], index) => longContextCase(`lc-required-${index}`, source, taskType)),
    ...Array.from({ length: 8 }, (_, index) =>
      longContextCase(`lc-extra-${index}`, "synthetic-needle-in-context", "needle_retrieval", 16_000),
    ),
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function longContextCase(id: string, source: string, taskType: string, targetContextChars = 4096): Record<string, unknown> {
  return {
    id,
    source,
    prompt: "Use the long context.",
    expected: "answer",
    metadata: {
      targetKey: id,
      expectedHash: "0".repeat(64),
      targetContextChars,
      contextChars: targetContextChars + 10,
      approxTokens: Math.ceil(targetContextChars / 4),
      needlePosition: "middle",
      taskType,
      distractorAnswers: [],
      longContext: true,
      preferredProvider: "subq",
      architectureTarget: "subquadratic-sparse-attention",
    },
  };
}

async function fileReport(path: string): Promise<{ path: string; lines: number; bytes: number; sha256: string }> {
  const body = await readFile(path);
  return {
    path,
    lines: body.toString("utf8").split(/\r?\n/).filter((line) => line.length > 0).length,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function sourceSummary(
  name: string,
  path: string,
  kind: string,
  required: boolean,
  accepted: number,
  present = true,
): Record<string, unknown> {
  return {
    name,
    path,
    required,
    present,
    kind,
    raw: accepted,
    accepted,
    skipped: 0,
    ...(present ? {} : { reason: "missing-optional-file" }),
  };
}

function chatRecord(id: string): string {
  return JSON.stringify({
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: `Question ${id}` },
      { role: "assistant", content: `Answer ${id}` },
    ],
    metadata: { id, source: "fixture", split: "train" },
  });
}

function dpoRecord(id: string): string {
  return JSON.stringify({
    prompt: `Prompt ${id}`,
    chosen: `Chosen ${id}`,
    rejected: `Rejected ${id}`,
    metadata: { id, source: "fixture" },
  });
}

function goodAxolotlSftConfig(): string {
  return `
base_model: Qwen/Qwen3-4B-Instruct-2507
adapter: qlora
load_in_4bit: true
sample_packing: true
gradient_checkpointing: true
train_on_inputs: false
roles_to_train:
  - assistant
train_on_eos: turn
`;
}

function goodAxolotlDpoConfig(): string {
  return `
base_model: Qwen/Qwen3-4B-Instruct-2507
rl: dpo
adapter: qlora
load_in_4bit: true
type: chatml.prompt_pairs
dpo_beta: 0.1
`;
}

function goodUnslothSftConfig(): string {
  return `
BASE_MODEL = "unsloth/Qwen3-4B-Instruct-2507-bnb-4bit"
load_in_4bit=True
assistant_only_loss=True
packing=True
optim="adamw_8bit"
`;
}

function goodUnslothDpoConfig(): string {
  return `
BASE_MODEL = "unsloth/Qwen3-4B-Instruct-2507-bnb-4bit"
DPOTrainer
DPOConfig
load_in_4bit=True
beta=0.1
`;
}
