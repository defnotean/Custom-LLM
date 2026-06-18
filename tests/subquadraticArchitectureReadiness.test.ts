import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSubquadraticArchitectureReadiness } from "../src/training/quality/SubquadraticArchitectureReadiness";

describe("SubquadraticArchitectureReadiness", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes when the long-context suite and local sparse contracts are present", async () => {
    const fixture = await writeFixture();

    const report = await checkSubquadraticArchitectureReadiness(fixture);

    expect(report.status).toBe("pass");
    expect(report.summary.cases).toBe(25);
    expect(report.summary.sources).toMatchObject({
      "synthetic-needle-in-context": expect.any(Number),
      "synthetic-repo-artifact": expect.any(Number),
      "real-repo-snapshot": expect.any(Number),
      "real-repo-multifile": expect.any(Number),
    });
    expect(report.checks.map((check) => check.id)).toContain("subq-router-contract");
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("fails when a long-context case is not tagged as subquadratic sparse attention", async () => {
    const fixture = await writeFixture({
      caseOverride: { architectureTarget: "dense-attention" },
    });

    const report = await checkSubquadraticArchitectureReadiness(fixture);

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "subq-architecture-target")).toBe("fail");
  });

  it("fails when the trainer cannot prove local sparse attention support", async () => {
    const fixture = await writeFixture({
      trainerSource: 'parser.add_argument("--attention-mode", choices=["dense"])\n',
    });

    const report = await checkSubquadraticArchitectureReadiness(fixture);

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "local-sparse-trainer-contract")).toBe("fail");
  });

  async function writeFixture(overrides: {
    caseOverride?: Record<string, unknown>;
    trainerSource?: string;
  } = {}): Promise<{
    suitePath: string;
    routerSourcePath: string;
    trainerPath: string;
    evaluatorPath: string;
  }> {
    dir = await mkdtemp(join(tmpdir(), "subq-architecture-"));
    const suitePath = join(dir, "long-context.eval.jsonl");
    const routerSourcePath = join(dir, "LLMRouter.ts");
    const trainerPath = join(dir, "train_tiny_transformer_lm.py");
    const evaluatorPath = join(dir, "evaluate_tiny_transformer_lm.py");
    await mkdir(dir, { recursive: true });
    await writeLongContextSuite(suitePath, overrides.caseOverride);
    await writeFile(
      routerSourcePath,
      'const preferredProvider = request.metadata?.preferredProvider;\nconst provider = request.metadata?.longContext === true ? "subq" : preferredProvider;\n',
      "utf8",
    );
    await writeFile(
      trainerPath,
      overrides.trainerSource ??
        'parser.add_argument("--attention-mode", choices=["dense", "local-log-sparse"])\ndef sparse_attention_indices(): pass\ndef local_log_sparse_attention(): pass\nsparse_local_window = 32\nsparse_log_base = 2\n',
      "utf8",
    );
    await writeFile(
      evaluatorPath,
      'attention_mode=str(config.get("attention_mode", "dense"))\nsparse_local_window=int(config.get("sparse_local_window", 32))\nsparse_log_base=int(config.get("sparse_log_base", 2))\n',
      "utf8",
    );
    return { suitePath, routerSourcePath, trainerPath, evaluatorPath };
  }
});

async function writeLongContextSuite(path: string, caseOverride: Record<string, unknown> = {}): Promise<void> {
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
    ["synthetic-repo-artifact", "repo_subq_architecture_gate"],
    ["synthetic-repo-artifact", "repo_voice_retention_policy"],
    ["synthetic-repo-artifact", "repo_parameter_staging_gate"],
    ["synthetic-repo-artifact", "repo_tool_gate_order"],
    ["real-repo-multifile", "repo_subq_architecture_chain"],
    ["real-repo-multifile", "repo_tool_protocol_readiness_chain"],
    ["real-repo-multifile", "repo_dataset_governance_chain"],
    ["real-repo-multifile", "repo_parameter_growth_chain"],
  ] as const;
  const rows = [
    ...required.map(([source, taskType], index) =>
      longContextCase(`required-${index}`, source, taskType, index === 0 ? caseOverride : {}),
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      longContextCase(`extra-${index}`, "synthetic-needle-in-context", "needle_retrieval"),
    ),
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function longContextCase(
  id: string,
  source: string,
  taskType: string,
  metadataOverride: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    source,
    prompt: "Use the long context.",
    expected: "answer",
    metadata: {
      targetKey: id,
      expectedHash: "0".repeat(64),
      targetContextChars: 4096,
      contextChars: 4100,
      approxTokens: 1025,
      needlePosition: "middle",
      taskType,
      distractorAnswers: [],
      longContext: true,
      preferredProvider: "subq",
      architectureTarget: "subquadratic-sparse-attention",
      ...metadataOverride,
    },
  };
}

function checkStatus(checks: Array<{ id: string; status: string }>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}
