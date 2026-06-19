import { readFile } from "node:fs/promises";
import { z } from "zod";

export type SubquadraticArchitectureReadinessStatus = "pass" | "fail";

export interface SubquadraticArchitectureReadinessOptions {
  suitePath?: string;
  routerSourcePath?: string;
  trainerPath?: string;
  evaluatorPath?: string;
  minCases?: number;
  requiredSources?: string[];
  requiredTaskTypes?: string[];
}

export interface SubquadraticArchitectureReadinessCheck {
  id: string;
  status: SubquadraticArchitectureReadinessStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface SubquadraticArchitectureReadinessReport {
  status: SubquadraticArchitectureReadinessStatus;
  generatedAt: string;
  suitePath: string;
  routerSourcePath: string;
  trainerPath: string;
  evaluatorPath: string;
  summary: {
    cases: number;
    maxTargetContextChars: number;
    sources: Record<string, number>;
    taskTypes: Record<string, number>;
  };
  checks: SubquadraticArchitectureReadinessCheck[];
}

interface LongContextArchitectureCase {
  id: string;
  source: string;
  metadata: {
    longContext: unknown;
    preferredProvider: unknown;
    architectureTarget: unknown;
    targetContextChars?: number;
    taskType?: string;
  };
}

const DEFAULT_REQUIRED_SOURCES = [
  "synthetic-needle-in-context",
  "synthetic-repo-artifact",
  "real-repo-snapshot",
  "real-repo-multifile",
];

const DEFAULT_REQUIRED_TASK_TYPES = [
  "needle_retrieval",
  "repo_file_lookup",
  "repo_env_lookup",
  "repo_routing_contract",
  "repo_script_lookup",
  "repo_readiness_contract",
  "repo_router_provider",
  "repo_script_readiness_chain",
  "repo_router_subq_chain",
  "repo_subq_architecture_gate",
  "repo_voice_retention_policy",
  "repo_parameter_staging_gate",
  "repo_tool_gate_order",
  "repo_subq_architecture_chain",
  "repo_tool_protocol_readiness_chain",
  "repo_dataset_governance_chain",
  "repo_parameter_growth_chain",
  "repo_training_readiness_decision",
  "repo_live_learning_access_decision",
  "repo_discord_voice_boundary_decision",
];

const DEFAULTS = {
  suitePath: "training/evals/long-context.eval.jsonl",
  routerSourcePath: "src/ai/llm/LLMRouter.ts",
  trainerPath: "training/train_tiny_transformer_lm.py",
  evaluatorPath: "training/evaluate_tiny_transformer_lm.py",
  minCases: 28,
};

const caseSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  metadata: z.object({
    longContext: z.unknown(),
    preferredProvider: z.unknown(),
    architectureTarget: z.unknown(),
    targetContextChars: z.number().optional(),
    taskType: z.string().optional(),
  }),
});

export async function checkSubquadraticArchitectureReadiness(
  options: SubquadraticArchitectureReadinessOptions = {},
): Promise<SubquadraticArchitectureReadinessReport> {
  const config = { ...DEFAULTS, ...options };
  const requiredSources = options.requiredSources ?? DEFAULT_REQUIRED_SOURCES;
  const requiredTaskTypes = options.requiredTaskTypes ?? DEFAULT_REQUIRED_TASK_TYPES;
  const [suiteRows, routerSource, trainerSource, evaluatorSource] = await Promise.all([
    readJsonl(config.suitePath),
    readFile(config.routerSourcePath, "utf8"),
    readFile(config.trainerPath, "utf8"),
    readFile(config.evaluatorPath, "utf8"),
  ]);

  const cases = suiteRows.map((row, index) => {
    const parsed = caseSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`${config.suitePath}:${index + 1} is not a valid long-context architecture case`);
    }
    return parsed.data as LongContextArchitectureCase;
  });
  const sources = countBy(cases.map((item) => item.source));
  const taskTypes = countBy(cases.map((item) => item.metadata.taskType ?? "missing"));
  const maxTargetContextChars = Math.max(
    0,
    ...cases.map((item) =>
      typeof item.metadata.targetContextChars === "number" ? item.metadata.targetContextChars : 0,
    ),
  );

  const checks: SubquadraticArchitectureReadinessCheck[] = [
    cases.length >= config.minCases
      ? pass("long-context-suite-volume", `Long-context suite has ${cases.length} cases`)
      : fail("long-context-suite-volume", `Long-context suite has only ${cases.length} cases`, {
          minCases: config.minCases,
        }),
    allCasesMatch(cases, "longContext", true)
      ? pass("long-context-metadata-flag", "Every long-context case carries metadata.longContext=true")
      : fail("long-context-metadata-flag", "Some long-context cases are missing metadata.longContext=true", {
          failures: mismatchIds(cases, "longContext", true),
        }),
    allCasesMatch(cases, "preferredProvider", "subq")
      ? pass("long-context-provider-target", 'Every long-context case targets preferredProvider="subq"')
      : fail("long-context-provider-target", 'Some long-context cases do not target preferredProvider="subq"', {
          failures: mismatchIds(cases, "preferredProvider", "subq"),
        }),
    allCasesMatch(cases, "architectureTarget", "subquadratic-sparse-attention")
      ? pass("subq-architecture-target", "Every long-context case targets subquadratic sparse attention")
      : fail("subq-architecture-target", "Some long-context cases do not target subquadratic sparse attention", {
          failures: mismatchIds(cases, "architectureTarget", "subquadratic-sparse-attention"),
        }),
    includesAllKeys(sources, requiredSources)
      ? pass("long-context-source-coverage", "Long-context suite covers synthetic and real repository sources")
      : fail("long-context-source-coverage", "Long-context suite is missing required sources", {
          missing: missingKeys(sources, requiredSources),
          sources,
        }),
    includesAllKeys(taskTypes, requiredTaskTypes)
      ? pass("long-context-task-coverage", "Long-context suite covers all required SubQ/SSA task types")
      : fail("long-context-task-coverage", "Long-context suite is missing required task types", {
          missing: missingKeys(taskTypes, requiredTaskTypes),
          taskTypes,
        }),
    routerSource.includes("metadata?.longContext === true") &&
    routerSource.includes('"subq"') &&
    routerSource.includes("preferredProvider")
      ? pass("subq-router-contract", "LLMRouter prefers the subq provider for long-context metadata")
      : fail("subq-router-contract", "LLMRouter no longer proves automatic long-context SubQ routing", {
          required: ['metadata?.longContext === true', '"subq"', "preferredProvider"],
        }),
    trainerSource.includes('"local-log-sparse"') &&
    trainerSource.includes("sparse_attention_indices") &&
    trainerSource.includes("local_log_sparse_attention") &&
    trainerSource.includes("sparse_local_window") &&
    trainerSource.includes("sparse_log_base")
      ? pass("local-sparse-trainer-contract", "Tiny trainer exposes local/log sparse attention smoke mode")
      : fail("local-sparse-trainer-contract", "Tiny trainer is missing local/log sparse attention support", {
          required: [
            "local-log-sparse",
            "sparse_attention_indices",
            "local_log_sparse_attention",
            "sparse_local_window",
            "sparse_log_base",
          ],
        }),
    evaluatorSource.includes('config.get("attention_mode", "dense")') &&
    evaluatorSource.includes("sparse_local_window") &&
    evaluatorSource.includes("sparse_log_base")
      ? pass("local-sparse-evaluator-contract", "Tiny evaluator reloads sparse attention checkpoint settings")
      : fail("local-sparse-evaluator-contract", "Tiny evaluator cannot prove sparse attention checkpoint reload", {
          required: ["attention_mode", "sparse_local_window", "sparse_log_base"],
        }),
  ];

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    suitePath: config.suitePath,
    routerSourcePath: config.routerSourcePath,
    trainerPath: config.trainerPath,
    evaluatorPath: config.evaluatorPath,
    summary: {
      cases: cases.length,
      maxTargetContextChars,
      sources,
      taskTypes,
    },
    checks,
  };
}

async function readJsonl(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function allCasesMatch(
  cases: LongContextArchitectureCase[],
  key: "longContext" | "preferredProvider" | "architectureTarget",
  expected: unknown,
): boolean {
  return mismatchIds(cases, key, expected).length === 0;
}

function mismatchIds(
  cases: LongContextArchitectureCase[],
  key: "longContext" | "preferredProvider" | "architectureTarget",
  expected: unknown,
): Array<{ id: string; actual: unknown }> {
  return cases
    .filter((item) => item.metadata[key] !== expected)
    .map((item) => ({ id: item.id, actual: item.metadata[key] }));
}

function includesAllKeys(actual: Record<string, number>, required: string[]): boolean {
  return missingKeys(actual, required).length === 0;
}

function missingKeys(actual: Record<string, number>, required: string[]): string[] {
  return required.filter((key) => !actual[key]);
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function pass(id: string, summary: string, details?: Record<string, unknown>): SubquadraticArchitectureReadinessCheck {
  return { id, status: "pass", summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): SubquadraticArchitectureReadinessCheck {
  return { id, status: "fail", summary, ...(details ? { details } : {}) };
}
