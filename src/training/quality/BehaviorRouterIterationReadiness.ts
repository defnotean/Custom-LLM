import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SPECIALIST_ROUTES, expertForRoute, type SpecialistRoute } from "../eval/SpecialistRoutingEvalSuite";

export type BehaviorRouterIterationStatus = "pass" | "fail";

export interface BehaviorRouterIterationReadinessOptions {
  behaviorDatasetPath?: string;
  behaviorEvalSuitePath?: string;
  behaviorGatePath?: string;
  routerDatasetPath?: string;
  routerEvalSuitePath?: string;
  routerGatePath?: string;
  minBehaviorRecords?: number;
  minRouterRecords?: number;
  minRecordsPerBehaviorRoute?: number;
  minRecordsPerRouterRoute?: number;
  now?: () => string;
}

export interface BehaviorRouterIterationReadinessReport {
  runtimeContract: "behavior-router-iteration-readiness-v1";
  generatedAt: string;
  status: BehaviorRouterIterationStatus;
  summary: {
    behaviorRecords: number;
    routerRecords: number;
    behaviorEvalOverlaps: number;
    routerEvalOverlaps: number;
    behaviorPreviousFailures: string[];
    routerPreviousFailures: string[];
  };
  checks: BehaviorRouterIterationCheck[];
  nextActions: string[];
}

export interface BehaviorRouterIterationCheck {
  id: string;
  status: BehaviorRouterIterationStatus;
  summary: string;
  details?: Record<string, unknown>;
}

const DEFAULTS = {
  behaviorDatasetPath: "training/data/behavior/sft.all.jsonl",
  behaviorEvalSuitePath: "training/evals/behavior.eval.jsonl",
  behaviorGatePath: "training/evals/tiny-transformer-behavior-iter3.det.gate.json",
  routerDatasetPath: "training/data/router/sft.all.jsonl",
  routerEvalSuitePath: "training/evals/specialist-routing.eval.jsonl",
  routerGatePath: "training/evals/tiny-transformer-router-iter3.det.gate.json",
  minBehaviorRecords: 90,
  minRouterRecords: 70,
  minRecordsPerBehaviorRoute: 4,
  minRecordsPerRouterRoute: 4,
};

const REQUIRED_BEHAVIOR_ROUTES = ["persona", "casual", "social_cue", "boundary", "tool_abstain"] as const;
const REQUIRED_BEHAVIOR_KINDS = [
  "persona_identity",
  "persona_emotion",
  "casual_conversation",
  "social_support",
  "social_repair",
  "clarification",
  "social_boundary",
  "tool_abstain",
] as const;
const REQUIRED_ROUTER_EXPERTS = ["tool", "knowledge", "conversation", "safety"] as const;
const KNOWN_BEHAVIOR_FAILURE_METRICS = new Set([
  "validJsonRate",
  "actionTypeAccuracy",
  "requirementPassRate",
  "personaConsistencyRate",
  "socialCueAccuracy",
  "casualToneAccuracy",
  "toolAbstainAccuracy",
  "boundaryAccuracy",
]);
const KNOWN_ROUTER_FAILURE_METRICS = new Set([
  "routeAccuracy",
  "expertAccuracy",
  "toolVsNonToolAccuracy",
  "missingPredictions",
  "invalidPredictions",
]);

const messageSchema = z.object({
  role: z.string(),
  content: z.string(),
});

const chatRecordSchema = z.object({
  messages: z.array(messageSchema).min(3),
  metadata: z.record(z.unknown()).default({}),
});

const behaviorAssistantActionSchema = z
  .object({
    type: z.enum(["message", "clarification"]),
    content: z.string().trim().min(1),
  })
  .passthrough();

const routerAssistantActionSchema = z
  .object({
    route: z.enum(SPECIALIST_ROUTES),
    expert: z.enum(REQUIRED_ROUTER_EXPERTS),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1),
  })
  .passthrough();

const evalPromptSchema = z.object({
  prompt: z.string(),
});

const gateSchema = z
  .object({
    status: z.enum(["pass", "fail"]),
    failures: z
      .array(
        z.object({
          metric: z.string().optional(),
          message: z.string().optional(),
        }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

type ChatRecord = z.infer<typeof chatRecordSchema>;

export async function checkBehaviorRouterIterationReadiness(
  options: BehaviorRouterIterationReadinessOptions = {},
): Promise<BehaviorRouterIterationReadinessReport> {
  const config = { ...DEFAULTS, ...options };
  const generatedAt = options.now?.() ?? new Date().toISOString();
  const checks: BehaviorRouterIterationCheck[] = [];

  const behavior = await loadJsonl<ChatRecord>(config.behaviorDatasetPath, chatRecordSchema);
  checks.push(readableCheck("behavior-dataset-readable", behavior, config.behaviorDatasetPath));
  const behaviorEvalPrompts = await loadEvalPrompts(config.behaviorEvalSuitePath);
  checks.push(readableCheck("behavior-eval-readable", behaviorEvalPrompts, config.behaviorEvalSuitePath));
  const behaviorGate = await loadGate(config.behaviorGatePath);
  checks.push(readableCheck("behavior-current-gate-readable", behaviorGate, config.behaviorGatePath));

  const router = await loadJsonl<ChatRecord>(config.routerDatasetPath, chatRecordSchema);
  checks.push(readableCheck("router-dataset-readable", router, config.routerDatasetPath));
  const routerEvalPrompts = await loadEvalPrompts(config.routerEvalSuitePath);
  checks.push(readableCheck("router-eval-readable", routerEvalPrompts, config.routerEvalSuitePath));
  const routerGate = await loadGate(config.routerGatePath);
  checks.push(readableCheck("router-current-gate-readable", routerGate, config.routerGatePath));

  if (behavior.ok) {
    checks.push(...behaviorDatasetChecks(behavior.value, behaviorEvalPrompts.ok ? behaviorEvalPrompts.value : new Set(), config));
  }
  if (behaviorGate.ok) {
    checks.push(previousGateCheck("behavior-current-failure-target", behaviorGate.value, KNOWN_BEHAVIOR_FAILURE_METRICS));
  }

  if (router.ok) {
    checks.push(...routerDatasetChecks(router.value, routerEvalPrompts.ok ? routerEvalPrompts.value : new Set(), config));
  }
  if (routerGate.ok) {
    checks.push(previousGateCheck("router-current-failure-target", routerGate.value, KNOWN_ROUTER_FAILURE_METRICS));
  }

  const behaviorOverlaps =
    behavior.ok && behaviorEvalPrompts.ok ? countEvalOverlaps(behavior.value, behaviorEvalPrompts.value) : 0;
  const routerOverlaps = router.ok && routerEvalPrompts.ok ? countEvalOverlaps(router.value, routerEvalPrompts.value) : 0;
  const behaviorFailures = behaviorGate.ok ? failureMetrics(behaviorGate.value) : [];
  const routerFailures = routerGate.ok ? failureMetrics(routerGate.value) : [];
  const status = checks.every((check) => check.status === "pass") ? "pass" : "fail";

  return {
    runtimeContract: "behavior-router-iteration-readiness-v1",
    generatedAt,
    status,
    summary: {
      behaviorRecords: behavior.ok ? behavior.value.length : 0,
      routerRecords: router.ok ? router.value.length : 0,
      behaviorEvalOverlaps: behaviorOverlaps,
      routerEvalOverlaps: routerOverlaps,
      behaviorPreviousFailures: behaviorFailures,
      routerPreviousFailures: routerFailures,
    },
    checks,
    nextActions: nextActions(status, behaviorFailures, routerFailures),
  };
}

function behaviorDatasetChecks(
  records: ChatRecord[],
  evalPrompts: Set<string>,
  config: typeof DEFAULTS,
): BehaviorRouterIterationCheck[] {
  const routes = countMetadata(records, "route");
  const kinds = countMetadata(records, "kind");
  const assistant = assistantJsonStats(records, behaviorAssistantActionSchema, (value) => {
    const type = value.type;
    return type === "message" || type === "clarification";
  });
  const overlaps = countEvalOverlaps(records, evalPrompts);
  const strictPrompts = records.filter((record) => {
    const system = record.messages.find((message) => message.role === "system")?.content ?? "";
    return system.includes("Output format - STRICT") && system.includes("You present as she/her");
  }).length;

  return [
    thresholdCheck(
      "behavior-dataset-volume",
      records.length,
      config.minBehaviorRecords,
      `Behavior SFT has ${records.length} records`,
    ),
    zeroCheck("behavior-assistant-json-schema", assistant.invalid, "Behavior assistant rows are strict message JSON", {
      invalidExamples: assistant.invalidExamples,
    }),
    coverageCheck(
      "behavior-route-coverage",
      routes,
      REQUIRED_BEHAVIOR_ROUTES,
      config.minRecordsPerBehaviorRoute,
      "Behavior SFT covers persona/casual/social/boundary/tool-abstain routes",
    ),
    coverageCheck(
      "behavior-kind-coverage",
      kinds,
      REQUIRED_BEHAVIOR_KINDS,
      1,
      "Behavior SFT covers required persona, casual, social, repair, boundary, and clarification kinds",
    ),
    zeroCheck("behavior-eval-overlap", overlaps, "Behavior SFT has no exact held-out eval prompt overlap"),
    thresholdCheck(
      "behavior-system-contract",
      strictPrompts,
      records.length,
      "Behavior rows preserve Irene she/her strict-output system contract",
    ),
  ];
}

function routerDatasetChecks(
  records: ChatRecord[],
  evalPrompts: Set<string>,
  config: typeof DEFAULTS,
): BehaviorRouterIterationCheck[] {
  const routes = countMetadata(records, "route");
  const experts = countMetadata(records, "expert");
  const assistant = assistantJsonStats(records, routerAssistantActionSchema, (value) => {
    return value.expert === expertForRoute(value.route as SpecialistRoute);
  });
  const overlaps = countEvalOverlaps(records, evalPrompts);
  const strictPrompts = records.filter((record) => {
    const system = record.messages.find((message) => message.role === "system")?.content ?? "";
    return system.includes("Respond with ONLY JSON") && system.includes("specialist router");
  }).length;

  return [
    thresholdCheck("router-dataset-volume", records.length, config.minRouterRecords, `Router SFT has ${records.length} records`),
    zeroCheck("router-assistant-json-schema", assistant.invalid, "Router assistant rows are strict route JSON", {
      invalidExamples: assistant.invalidExamples,
    }),
    coverageCheck(
      "router-route-coverage",
      routes,
      SPECIALIST_ROUTES,
      config.minRecordsPerRouterRoute,
      "Router SFT covers every MoE route",
    ),
    coverageCheck("router-expert-coverage", experts, REQUIRED_ROUTER_EXPERTS, 1, "Router SFT covers every expert family"),
    zeroCheck("router-eval-overlap", overlaps, "Router SFT has no exact held-out eval prompt overlap"),
    thresholdCheck("router-system-contract", strictPrompts, records.length, "Router rows preserve the strict JSON routing contract"),
  ];
}

function previousGateCheck(
  id: string,
  gate: z.infer<typeof gateSchema>,
  knownMetrics: Set<string>,
): BehaviorRouterIterationCheck {
  const failures = failureMetrics(gate);
  if (gate.status === "pass") {
    return pass(id, "Previous gate already passes; no repair-target failure is open");
  }
  const unknown = failures.filter((metric) => !knownMetrics.has(metric));
  return unknown.length === 0
    ? pass(id, `Previous failed gate has ${failures.length} known repair target(s)`, { failures })
    : fail(id, "Previous failed gate includes unknown repair target metrics", { unknown, failures });
}

async function loadJsonl<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<Result<T[]>> {
  try {
    const body = await readFile(path, "utf8");
    const rows = body
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => schema.parse(JSON.parse(line)) as T);
    return ok(rows);
  } catch (err) {
    return bad(errorMessage(err));
  }
}

async function loadEvalPrompts(path: string): Promise<Result<Set<string>>> {
  try {
    const body = await readFile(path, "utf8");
    const prompts = new Set<string>();
    for (const line of body.split(/\r?\n/).filter((item) => item.trim().length > 0)) {
      const parsed = evalPromptSchema.safeParse(JSON.parse(line) as unknown);
      if (parsed.success) prompts.add(normalizeText(parsed.data.prompt));
    }
    return ok(prompts);
  } catch (err) {
    return bad(errorMessage(err));
  }
}

async function loadGate(path: string): Promise<Result<z.infer<typeof gateSchema>>> {
  try {
    return ok(gateSchema.parse(JSON.parse(await readFile(path, "utf8"))));
  } catch (err) {
    return bad(errorMessage(err));
  }
}

function readableCheck(id: string, result: Result<unknown>, path: string): BehaviorRouterIterationCheck {
  return result.ok ? pass(id, `Loaded ${path}`) : fail(id, `Could not load ${path}`, { error: result.error });
}

function countMetadata(records: ChatRecord[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of records) {
    const value = record.metadata[key];
    if (typeof value === "string") out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function assistantJsonStats<T>(
  records: ChatRecord[],
  schema: z.ZodType<T>,
  predicate: (value: T) => boolean,
): { invalid: number; invalidExamples: string[] } {
  const invalidExamples: string[] = [];
  let invalid = 0;
  for (const record of records) {
    const assistant = [...record.messages].reverse().find((message) => message.role === "assistant");
    try {
      const value = schema.parse(JSON.parse(assistant?.content ?? ""));
      if (!predicate(value)) throw new Error("assistant JSON failed semantic predicate");
    } catch {
      invalid++;
      if (invalidExamples.length < 5) invalidExamples.push(String(record.metadata.id ?? assistant?.content ?? "unknown"));
    }
  }
  return { invalid, invalidExamples };
}

function countEvalOverlaps(records: ChatRecord[], evalPrompts: Set<string>): number {
  let overlaps = 0;
  for (const record of records) {
    const user = record.messages.find((message) => message.role === "user")?.content ?? "";
    if (evalPrompts.has(normalizeText(user))) overlaps++;
  }
  return overlaps;
}

function coverageCheck(
  id: string,
  counts: Record<string, number>,
  required: readonly string[],
  minCount: number,
  summary: string,
): BehaviorRouterIterationCheck {
  const missing = required.filter((key) => (counts[key] ?? 0) < minCount);
  return missing.length === 0 ? pass(id, summary, { counts }) : fail(id, `${summary} is incomplete`, { counts, missing, minCount });
}

function thresholdCheck(id: string, actual: number, expected: number, summary: string): BehaviorRouterIterationCheck {
  return actual >= expected ? pass(id, summary, { actual, expected }) : fail(id, `${summary} below threshold`, { actual, expected });
}

function zeroCheck(
  id: string,
  actual: number,
  summary: string,
  details: Record<string, unknown> = {},
): BehaviorRouterIterationCheck {
  return actual === 0 ? pass(id, summary, { actual, ...details }) : fail(id, `${summary} failed`, { actual, ...details });
}

function failureMetrics(gate: z.infer<typeof gateSchema>): string[] {
  return (gate.failures ?? [])
    .map((failure) => failure.metric)
    .filter((metric): metric is string => typeof metric === "string" && metric.length > 0);
}

function nextActions(status: BehaviorRouterIterationStatus, behaviorFailures: string[], routerFailures: string[]): string[] {
  if (status === "fail") {
    return [
      "Fix behavior/router SFT quality checks before launching another behavior/router scratch run.",
      "Rebuild behavior and router datasets, then re-run this readiness check.",
    ];
  }
  return [
    `Behavior iteration targets current failed metrics: ${behaviorFailures.join(", ") || "none"}.`,
    `Router iteration targets current failed metrics: ${routerFailures.join(", ") || "none"}.`,
    "After this preflight, run the planned next behavior/router scratch training commands and attach direct eval gate evidence before promotion.",
  ];
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function pass(id: string, summary: string, details?: Record<string, unknown>): BehaviorRouterIterationCheck {
  return { id, status: "pass", summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): BehaviorRouterIterationCheck {
  return { id, status: "fail", summary, ...(details ? { details } : {}) };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function bad<T = never>(error: string): Result<T> {
  return { ok: false, error };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
