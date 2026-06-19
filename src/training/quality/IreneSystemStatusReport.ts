import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ParameterGrowthSnapshot } from "../../learning/LiveLearningRegistry";
import type { LearningStatsPayload } from "../../types/common";
import {
  checkProductionTrainingReadiness,
  type ProductionTrainingReadinessOptions,
  type ProductionTrainingStage,
} from "./ProductionTrainingReadiness";

export type IreneCapabilitySurfaceStatus = "pass" | "fail" | "warn" | "not_measured";
export type IreneCapabilityLevel =
  | "runtime_foundation_ready"
  | "tool_protocol_specialist_prototype"
  | "needs_training_data"
  | "unmeasured";

export interface IreneSystemStatusOptions {
  runRoot?: string;
  plannedProductionBaseParams?: number;
  learningStats?: LearningStatsPayload | null;
  parameterSnapshot?: ParameterGrowthSnapshot | null;
  includeProductionReadiness?: boolean;
  productionReadinessOptions?: ProductionTrainingReadinessOptions;
  toolProtocolGatePath?: string;
  behaviorScratchGatePath?: string;
  behaviorBaselineGatePath?: string;
  routerScratchGatePath?: string;
  specialistRouterBaselineGatePath?: string;
  toolRouterGatePath?: string;
  memoryContinuityGatePath?: string;
  skillRetrievalGatePath?: string;
  longContextGatePath?: string;
  voiceGatePath?: string;
  now?: () => string;
}

export interface IreneSystemStatusReport {
  runtimeContract: "irene-system-status-v1";
  generatedAt: string;
  overall: {
    capabilityLevel: IreneCapabilityLevel;
    summary: string;
    criticalFailures: string[];
  };
  parameterAccounting: {
    source: "parameter_snapshot" | "learning_stats" | "not_configured";
    plannedProductionBaseParams: number;
    activeSystemParams: number;
    activeParamsPerRequest: number;
    stagedParams: number;
    activeModuleIds: string[];
    stagedModuleIds: string[];
    selectedModuleIds: string[];
    largestScratchCheckpointParams: number;
    largestScratchCheckpointRun: string | null;
    bestProtocolScratchParams: number;
    bestProtocolScratchRun: string | null;
    behaviorScratchParams: number;
    routerScratchParams: number;
  };
  learning: {
    enabled: boolean;
    learnedItems: number;
    candidateItems: number;
    approvedItems: number;
    queuedItems: number;
    trainedItems: number;
    parameterModules: number;
    activeParameterModules: number;
    stagedParameterModules: number;
  };
  scratchRuns: {
    totalRuns: number;
    largestCheckpoint: ScratchRunSummary | null;
    bestProtocol: ScratchRunSummary | null;
    behavior: ScratchRunSummary | null;
    router: ScratchRunSummary | null;
  };
  capabilityScorecard: CapabilitySurfaceReport[];
  productionReadiness?: {
    stage: ProductionTrainingStage;
    status: "ready" | "not_ready";
    passChecks: number;
    warnChecks: number;
    failChecks: number;
    warnings: Array<{ id: string; summary: string }>;
    failures: Array<{ id: string; summary: string }>;
  };
  nextActions: string[];
  caveats: string[];
}

export interface ScratchRunSummary {
  runName: string;
  metricsPath: string;
  parameters: number;
  trainRecords: number;
  validationRecords: number;
  bestValLoss: number | null;
  finalValLoss: number | null;
  lossImprovedWithinRun: boolean;
}

export interface CapabilitySurfaceReport {
  id: string;
  label: string;
  status: IreneCapabilitySurfaceStatus;
  cases: number | null;
  params: number | null;
  evidencePath: string;
  metrics: Record<string, number | string | null>;
  summary: string;
}

const DEFAULTS = {
  runRoot: "training/runs",
  plannedProductionBaseParams: 4_000_000_000,
  toolProtocolGatePath: "training/evals/tiny-transformer-protocol-iter16.clean.det.tool.gate.json",
  behaviorScratchGatePath: "training/evals/tiny-transformer-behavior-iter4.det.gate.json",
  behaviorBaselineGatePath: "training/evals/behavior-heuristic.gate.json",
  routerScratchGatePath: "training/evals/tiny-transformer-router-iter4.det.gate.json",
  specialistRouterBaselineGatePath: "training/evals/specialist-routing-heuristic.gate.json",
  toolRouterGatePath: "training/evals/tool-router-keyword.gate.json",
  memoryContinuityGatePath: "training/evals/memory-continuity.gate.json",
  skillRetrievalGatePath: "training/evals/skill-retrieval.gate.json",
  longContextGatePath: "training/evals/long-context-oracle.gate.json",
  voiceGatePath: "training/evals/voice-oracle.gate.json",
};

const metricsSchema = z
  .object({
    model: z.string().optional(),
    parameters: z.number().int().nonnegative(),
    train_records: z.number().int().nonnegative().optional(),
    val_records: z.number().int().nonnegative().optional(),
    trainRecords: z.number().int().nonnegative().optional(),
    validationRecords: z.number().int().nonnegative().optional(),
    best_checkpoint_val_loss: z.number().nullable().optional(),
    final_val_loss: z.number().nullable().optional(),
    history: z.array(z.object({ val_loss: z.number().optional() }).passthrough()).optional(),
  })
  .passthrough();

const gateSchema = z
  .object({
    status: z.enum(["pass", "fail"]),
    candidate: z.record(z.unknown()).optional(),
    failures: z.array(z.unknown()).optional(),
    warnings: z.array(z.unknown()).optional(),
  })
  .passthrough();

type GateReport = z.infer<typeof gateSchema>;

export async function buildIreneSystemStatusReport(
  options: IreneSystemStatusOptions = {},
): Promise<IreneSystemStatusReport> {
  const config = { ...DEFAULTS, ...options };
  const generatedAt = options.now?.() ?? new Date().toISOString();
  const scratchRuns = await scanScratchRuns(config.runRoot);
  const runsByName = new Map(scratchRuns.map((run) => [run.runName, run]));
  const largestScratch = scratchRuns.reduce<ScratchRunSummary | null>(
    (best, run) => (!best || run.parameters > best.parameters ? run : best),
    null,
  );
  const bestProtocol = findRun(runsByName, "tiny-transformer-protocol-iter16");
  const behaviorRun = findLatestRunByPrefix(scratchRuns, "tiny-transformer-behavior-iter");
  const routerRun = findLatestRunByPrefix(scratchRuns, "tiny-transformer-router-iter");

  const [
    toolProtocolGate,
    behaviorGate,
    behaviorBaselineGate,
    routerGate,
    specialistRouterBaselineGate,
    toolRouterGate,
    memoryGate,
    skillGate,
    longContextGate,
    voiceGate,
  ] = await Promise.all([
    readGate(config.toolProtocolGatePath),
    readGate(config.behaviorScratchGatePath),
    readGate(config.behaviorBaselineGatePath),
    readGate(config.routerScratchGatePath),
    readGate(config.specialistRouterBaselineGatePath),
    readGate(config.toolRouterGatePath),
    readGate(config.memoryContinuityGatePath),
    readGate(config.skillRetrievalGatePath),
    readGate(config.longContextGatePath),
    readGate(config.voiceGatePath),
  ]);

  const parameterAccounting = buildParameterAccounting({
    plannedProductionBaseParams: config.plannedProductionBaseParams,
    learningStats: options.learningStats ?? null,
    parameterSnapshot: options.parameterSnapshot ?? null,
    largestScratch,
    bestProtocol,
    behaviorRun,
    routerRun,
  });
  const learning = buildLearningSummary(options.learningStats ?? null);
  const capabilityScorecard: CapabilitySurfaceReport[] = [
    gateSurface({
      id: "tool_protocol_scratch",
      label: "Tool protocol scratch specialist",
      gate: toolProtocolGate,
      evidencePath: config.toolProtocolGatePath,
      params: bestProtocol?.parameters ?? null,
      metrics: ["validJsonRate", "actionTypeAccuracy", "toolNameAccuracy", "toolArgumentValidity", "noToolAccuracy", "hallucinatedToolRate", "latencyP95Ms"],
      passSummary: "Narrow scratch specialist has perfect held-out tool JSON behavior on its current suite.",
      failSummary: "Tool protocol scratch specialist is not promotion-ready.",
    }),
    gateSurface({
      id: "behavior_scratch",
      label: "Behavior/persona scratch specialist",
      gate: behaviorGate,
      evidencePath: config.behaviorScratchGatePath,
      params: behaviorRun?.parameters ?? null,
      metrics: ["validJsonRate", "requirementPassRate", "personaConsistencyRate", "socialCueAccuracy", "casualToneAccuracy", "boundaryAccuracy"],
      passSummary: "Behavior scratch specialist is promotion-ready on the held-out persona/social suite.",
      failSummary: "Behavior scratch specialist still fails direct held-out JSON/persona/social checks.",
    }),
    gateSurface({
      id: "behavior_heuristic_baseline",
      label: "Deterministic behavior/persona baseline",
      gate: behaviorBaselineGate,
      evidencePath: config.behaviorBaselineGatePath,
      params: null,
      metrics: ["validJsonRate", "requirementPassRate", "personaConsistencyRate", "socialCueAccuracy", "casualToneAccuracy", "boundaryAccuracy"],
      passSummary: "Deterministic behavior/persona fallback passes the current held-out persona/social gate.",
      failSummary: "Deterministic behavior/persona fallback is not reliable enough for the current persona/social suite.",
    }),
    gateSurface({
      id: "router_scratch",
      label: "MoE route scratch specialist",
      gate: routerGate,
      evidencePath: config.routerScratchGatePath,
      params: routerRun?.parameters ?? null,
      metrics: ["routeAccuracy", "expertAccuracy", "toolVsNonToolAccuracy", "invalidPredictions", "latencyP95Ms"],
      passSummary: "Router scratch specialist is promotion-ready on the held-out route suite.",
      failSummary: "Router scratch specialist is not reliable enough to choose tool/knowledge/persona/social/boundary routes.",
    }),
    gateSurface({
      id: "router_heuristic_baseline",
      label: "Deterministic MoE router baseline",
      gate: specialistRouterBaselineGate,
      evidencePath: config.specialistRouterBaselineGatePath,
      params: null,
      metrics: ["routeAccuracy", "expertAccuracy", "toolVsNonToolAccuracy", "invalidPredictions", "latencyP95Ms"],
      passSummary: "Deterministic specialist-router fallback passes the current held-out route gate.",
      failSummary: "Deterministic specialist-router fallback is not reliable enough for the current route suite.",
    }),
    gateSurface({
      id: "tool_router_retrieval",
      label: "Tool-router retrieval",
      gate: toolRouterGate,
      evidencePath: config.toolRouterGatePath,
      params: null,
      metrics: ["expectedToolRecall", "top1Accuracy", "noToolAccuracy", "forbiddenCandidateRate", "latencyP95Ms"],
      passSummary: "Runtime tool retrieval is exact on the current candidate-tool suite.",
      failSummary: "Runtime tool retrieval is not safe enough for large-registry routing.",
    }),
    gateSurface({
      id: "memory_continuity",
      label: "Memory and live-learning continuity",
      gate: memoryGate,
      evidencePath: config.memoryContinuityGatePath,
      params: null,
      metrics: ["passRate", "recallHitRate", "isolationPassRate", "forgetPassRate", "policyRejectionPassRate", "learnedItemPassRate", "latencyP95Ms"],
      passSummary: "Memory continuity, extraction, policy, recall, and learned-item capture pass.",
      failSummary: "Memory continuity is not promotion-ready.",
    }),
    gateSurface({
      id: "skill_retrieval",
      label: "Approved-skill retrieval",
      gate: skillGate,
      evidencePath: config.skillRetrievalGatePath,
      params: null,
      metrics: ["recallAtK", "precisionAtK", "top1Accuracy", "noHitAccuracy", "latencyP95Ms"],
      passSummary: "Approved skill retrieval is exact on the current gate.",
      failSummary: "Approved skill retrieval is not reliable enough for live reuse.",
    }),
    gateSurface({
      id: "long_context_subq",
      label: "SubQ/SSA long-context gate",
      gate: longContextGate,
      evidencePath: config.longContextGatePath,
      params: null,
      metrics: ["answerRate", "exactMatchRate", "expectedContainRate", "falsePositiveRate", "latencyP95Ms"],
      passSummary: "SubQ/SSA long-context oracle gate passes on the checked suite.",
      failSummary: "SubQ/SSA long-context behavior is not promotion-ready.",
    }),
    gateSurface({
      id: "voice_gate",
      label: "Discord voice behavior gate",
      gate: voiceGate,
      evidencePath: config.voiceGatePath,
      params: null,
      metrics: ["transcriptExactRate", "speakerAttributionAccuracy", "responseDecisionAccuracy", "latencyPassRate", "retentionPolicyPassRate"],
      passSummary: "Deterministic voice behavior gate passes; live Discord speak/listen still needs service validation.",
      failSummary: "Voice behavior gate is not promotion-ready.",
    }),
  ];

  const productionReadiness = options.includeProductionReadiness
    ? summarizeProductionReadiness(await checkProductionTrainingReadiness(options.productionReadinessOptions ?? {}))
    : undefined;
  const overall = buildOverall(capabilityScorecard, productionReadiness);

  return {
    runtimeContract: "irene-system-status-v1",
    generatedAt,
    overall,
    parameterAccounting,
    learning,
    scratchRuns: {
      totalRuns: scratchRuns.length,
      largestCheckpoint: largestScratch,
      bestProtocol,
      behavior: behaviorRun,
      router: routerRun,
    },
    capabilityScorecard,
    ...(productionReadiness ? { productionReadiness } : {}),
    nextActions: buildNextActions(capabilityScorecard, productionReadiness),
    caveats: [
      "Memory/RAG and approved skills improve immediate behavior without increasing model parameters.",
      "Parameter count grows only after adapters, specialists, experts, merged checkpoints, or larger bases are trained, registered, and promoted.",
      "The current scratch protocol specialist is narrow evidence for tool JSON behavior, not a general assistant model.",
      "The planned Qwen3 4B production base is a target profile until a live model/adapters are actually served and registered.",
    ],
  };
}

async function scanScratchRuns(runRoot: string): Promise<ScratchRunSummary[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(runRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<ScratchRunSummary | null> => {
        const metricsPath = join(runRoot, entry.name, "metrics.json");
        try {
          const metrics = metricsSchema.parse(JSON.parse(await readFile(metricsPath, "utf8")));
          const history = metrics.history ?? [];
          const firstValLoss = history.find((item) => typeof item.val_loss === "number")?.val_loss ?? null;
          const finalValLoss =
            metrics.final_val_loss ?? [...history].reverse().find((item) => typeof item.val_loss === "number")?.val_loss ?? null;
          const bestValLoss = metrics.best_checkpoint_val_loss ?? bestLoss(history);
          return {
            runName: entry.name,
            metricsPath,
            parameters: metrics.parameters,
            trainRecords: metrics.train_records ?? metrics.trainRecords ?? 0,
            validationRecords: metrics.val_records ?? metrics.validationRecords ?? 0,
            bestValLoss,
            finalValLoss,
            lossImprovedWithinRun:
              typeof firstValLoss === "number" && typeof bestValLoss === "number" ? bestValLoss < firstValLoss : false,
          };
        } catch {
          return null;
        }
      }),
  );
  return runs.filter((run): run is ScratchRunSummary => run !== null).sort((a, b) => b.parameters - a.parameters);
}

async function readGate(path: string): Promise<{ data?: GateReport; error?: string }> {
  try {
    return { data: gateSchema.parse(JSON.parse(await readFile(path, "utf8"))) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function gateSurface(options: {
  id: string;
  label: string;
  gate: { data?: GateReport; error?: string };
  evidencePath: string;
  params: number | null;
  metrics: string[];
  passSummary: string;
  failSummary: string;
}): CapabilitySurfaceReport {
  if (!options.gate.data) {
    return {
      id: options.id,
      label: options.label,
      status: "not_measured",
      cases: null,
      params: options.params,
      evidencePath: options.evidencePath,
      metrics: {},
      summary: `No readable gate evidence: ${options.gate.error ?? "missing file"}`,
    };
  }
  const candidate = options.gate.data.candidate ?? {};
  const metrics = Object.fromEntries(options.metrics.map((metric) => [metric, metricValue(candidate, metric)]));
  const status = options.gate.data.status === "pass" ? "pass" : "fail";
  return {
    id: options.id,
    label: options.label,
    status,
    cases: typeof candidate.total === "number" ? candidate.total : null,
    params: options.params,
    evidencePath: options.evidencePath,
    metrics,
    summary: status === "pass" ? options.passSummary : options.failSummary,
  };
}

function buildParameterAccounting(options: {
  plannedProductionBaseParams: number;
  learningStats: LearningStatsPayload | null;
  parameterSnapshot: ParameterGrowthSnapshot | null;
  largestScratch: ScratchRunSummary | null;
  bestProtocol: ScratchRunSummary | null;
  behaviorRun: ScratchRunSummary | null;
  routerRun: ScratchRunSummary | null;
}): IreneSystemStatusReport["parameterAccounting"] {
  if (options.parameterSnapshot) {
    return {
      source: "parameter_snapshot",
      plannedProductionBaseParams: options.plannedProductionBaseParams,
      activeSystemParams: options.parameterSnapshot.totalSystemParams,
      activeParamsPerRequest: options.parameterSnapshot.activeParamsPerRequest,
      stagedParams: options.parameterSnapshot.stagedParams,
      activeModuleIds: options.parameterSnapshot.activeModuleIds,
      stagedModuleIds: options.parameterSnapshot.stagedModuleIds,
      selectedModuleIds: options.parameterSnapshot.selectedModuleIds,
      largestScratchCheckpointParams: options.largestScratch?.parameters ?? 0,
      largestScratchCheckpointRun: options.largestScratch?.runName ?? null,
      bestProtocolScratchParams: options.bestProtocol?.parameters ?? 0,
      bestProtocolScratchRun: options.bestProtocol?.runName ?? null,
      behaviorScratchParams: options.behaviorRun?.parameters ?? 0,
      routerScratchParams: options.routerRun?.parameters ?? 0,
    };
  }
  const stats = options.learningStats;
  return {
    source: stats ? "learning_stats" : "not_configured",
    plannedProductionBaseParams: options.plannedProductionBaseParams,
    activeSystemParams: stats?.totalSystemParams ?? 0,
    activeParamsPerRequest: stats?.activeParamsPerRequest ?? 0,
    stagedParams: stats?.stagedParams ?? 0,
    activeModuleIds: [],
    stagedModuleIds: [],
    selectedModuleIds: [],
    largestScratchCheckpointParams: options.largestScratch?.parameters ?? 0,
    largestScratchCheckpointRun: options.largestScratch?.runName ?? null,
    bestProtocolScratchParams: options.bestProtocol?.parameters ?? 0,
    bestProtocolScratchRun: options.bestProtocol?.runName ?? null,
    behaviorScratchParams: options.behaviorRun?.parameters ?? 0,
    routerScratchParams: options.routerRun?.parameters ?? 0,
  };
}

function buildLearningSummary(stats: LearningStatsPayload | null): IreneSystemStatusReport["learning"] {
  return {
    enabled: Boolean(stats),
    learnedItems: stats?.learnedItems ?? 0,
    candidateItems: stats?.candidateItems ?? 0,
    approvedItems: stats?.approvedItems ?? 0,
    queuedItems: stats?.queuedItems ?? 0,
    trainedItems: stats?.trainedItems ?? 0,
    parameterModules: stats?.parameterModules ?? 0,
    activeParameterModules: stats?.activeParameterModules ?? 0,
    stagedParameterModules: stats?.stagedParameterModules ?? 0,
  };
}

function summarizeProductionReadiness(
  report: Awaited<ReturnType<typeof checkProductionTrainingReadiness>>,
): NonNullable<IreneSystemStatusReport["productionReadiness"]> {
  return {
    stage: report.stage,
    status: report.status,
    passChecks: report.checks.filter((check) => check.status === "pass").length,
    warnChecks: report.checks.filter((check) => check.status === "warn").length,
    failChecks: report.checks.filter((check) => check.status === "fail").length,
    warnings: report.checks
      .filter((check) => check.status === "warn")
      .map((check) => ({ id: check.id, summary: check.summary })),
    failures: report.checks
      .filter((check) => check.status === "fail")
      .map((check) => ({ id: check.id, summary: check.summary })),
  };
}

function buildOverall(
  surfaces: CapabilitySurfaceReport[],
  productionReadiness: IreneSystemStatusReport["productionReadiness"],
): IreneSystemStatusReport["overall"] {
  const criticalFailures = surfaces
    .filter((surface) => surface.status === "fail")
    .filter((surface) => ["tool_protocol_scratch", "behavior_scratch", "router_scratch"].includes(surface.id))
    .map((surface) => surface.id);
  const toolProtocolPass = surfaces.find((surface) => surface.id === "tool_protocol_scratch")?.status === "pass";
  const behaviorPass = surfaces.find((surface) => surface.id === "behavior_scratch")?.status === "pass";
  const routerPass = surfaces.find((surface) => surface.id === "router_scratch")?.status === "pass";
  const foundationPass = surfaces
    .filter((surface) =>
      [
        "behavior_heuristic_baseline",
        "router_heuristic_baseline",
        "tool_router_retrieval",
        "memory_continuity",
        "skill_retrieval",
        "long_context_subq",
        "voice_gate",
      ].includes(surface.id),
    )
    .every((surface) => surface.status === "pass");

  if (productionReadiness?.status === "ready" && foundationPass) {
    return {
      capabilityLevel: "runtime_foundation_ready",
      summary: "Runtime/data/eval foundation is ready for the first useful QLoRA SFT iteration; scratch specialists are still narrow.",
      criticalFailures,
    };
  }
  if (toolProtocolPass && (!behaviorPass || !routerPass)) {
    return {
      capabilityLevel: "tool_protocol_specialist_prototype",
      summary: "The best scratch checkpoint is a strong narrow tool-protocol specialist, but behavior and routing still need training.",
      criticalFailures,
    };
  }
  if (surfaces.some((surface) => surface.status === "not_measured")) {
    return {
      capabilityLevel: "unmeasured",
      summary: "Some required gate evidence is missing, so Irene's current quality cannot be fully summarized.",
      criticalFailures,
    };
  }
  return {
    capabilityLevel: "needs_training_data",
    summary: "The system needs more training data or model iteration before promotion.",
    criticalFailures,
  };
}

function buildNextActions(
  surfaces: CapabilitySurfaceReport[],
  productionReadiness: IreneSystemStatusReport["productionReadiness"],
): string[] {
  const actions: string[] = [];
  if (surfaces.find((surface) => surface.id === "behavior_scratch")?.status === "fail") {
    const baselinePass = surfaces.find((surface) => surface.id === "behavior_heuristic_baseline")?.status === "pass";
    actions.push(
      baselinePass
        ? "Use the deterministic behavior/persona baseline as the guarded fallback while training the learned behavior specialist to match it."
        : "Fix behavior/persona JSON stability before judging social quality.",
    );
  }
  const routerSurface = surfaces.find((surface) => surface.id === "router_scratch");
  if (routerSurface?.status === "fail") {
    const baselinePass = surfaces.find((surface) => surface.id === "router_heuristic_baseline")?.status === "pass";
    const invalidPredictions = routerSurface.metrics.invalidPredictions;
    actions.push(
      baselinePass
        ? "Use the deterministic MoE router baseline as the guarded fallback while training the learned router to match it."
        : invalidPredictions === 0
        ? "Improve route and expert accuracy now that router JSON validity is stable."
        : "Train or replace the route classifier until invalid route predictions are zero.",
    );
  }
  if (surfaces.find((surface) => surface.id === "tool_protocol_scratch")?.status === "pass") {
    actions.push("Keep expanding BFCL-style tool cases so the perfect-tool-call target stays measurable.");
  }
  if (productionReadiness?.status === "ready") {
    actions.push("Use the ready production preflight to run the first QLoRA SFT on the planned Qwen3 4B profile.");
  } else if (productionReadiness?.failures.length) {
    actions.push("Resolve production-readiness failures before spending GPU training compute.");
  }
  actions.push("Register and hot-load only eval-passing adapters/specialists so parameter growth is explicit and reversible.");
  return [...new Set(actions)];
}

function findRun(runsByName: Map<string, ScratchRunSummary>, runName: string): ScratchRunSummary | null {
  return runsByName.get(runName) ?? null;
}

function findLatestRunByPrefix(runs: ScratchRunSummary[], prefix: string): ScratchRunSummary | null {
  const candidates = runs.filter((run) => run.runName.startsWith(prefix));
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => compareRunIteration(b.runName, a.runName) || b.parameters - a.parameters)[0] ?? null;
}

function compareRunIteration(left: string, right: string): number {
  const leftIteration = trailingIteration(left);
  const rightIteration = trailingIteration(right);
  if (leftIteration !== rightIteration) return leftIteration - rightIteration;
  return left.localeCompare(right);
}

function trailingIteration(runName: string): number {
  const match = /(?:^|-)iter(\d+)$/u.exec(runName);
  return match ? Number(match[1]) : -1;
}

function metricValue(candidate: Record<string, unknown>, metric: string): number | string | null {
  const value = candidate[metric];
  if (typeof value === "number" || typeof value === "string") return value;
  return value === null ? null : null;
}

function bestLoss(history: Array<{ val_loss?: number }>): number | null {
  const values = history.map((item) => item.val_loss).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.min(...values) : null;
}
