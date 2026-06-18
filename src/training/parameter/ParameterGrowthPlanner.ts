import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  LearnedItem,
  LearningKind,
  ParameterModuleKind,
} from "../../learning/LiveLearningRegistry";
import type { JsonObject, JsonValue } from "../../types/common";

export type ParameterGrowthPlanStatus = "ready" | "needs_more_data" | "blocked";
export type ParameterGrowthBatchStatus = "ready" | "needs_more_data";
export type TrainableGrowthKind = Extract<ParameterModuleKind, "adapter" | "router" | "specialist" | "expert">;

export interface ParameterGrowthPlanningSource {
  listLearnedItems(filter?: {
    reviewStatus?: "approved";
    trainingStatus?: "queued";
    limit?: number;
  }): Promise<LearnedItem[]>;
}

export interface ParameterGrowthPlannerOptions {
  limit?: number;
  now?: () => string;
  minItemsByKind?: Partial<Record<TrainableGrowthKind, number>>;
  parameterBudgets?: Partial<Record<TrainableGrowthKind, number>>;
}

export interface ParameterGrowthPlanRecord {
  itemId: string;
  kind: LearningKind;
  source: string;
  confidence: number;
  contentHash: string;
  metadataHash: string;
  canRetrieve: boolean;
  canTrain: boolean;
  contentPreview?: string;
}

export interface ParameterGrowthBlockedCandidate {
  itemId: string;
  kind: LearningKind;
  reason: string;
}

export interface ParameterGrowthBatch {
  id: string;
  status: ParameterGrowthBatchStatus;
  purpose: string;
  targetKind: TrainableGrowthKind;
  route?: string;
  moduleName: string;
  datasetId: string;
  estimatedNewParameters: number;
  activeParameters: number;
  trainableParameters: number;
  sourceLearningItemIds: string[];
  sourceKinds: LearningKind[];
  datasetHashes: string[];
  records: ParameterGrowthPlanRecord[];
  gateRequirements: string[];
  riskFlags: string[];
  blockers: string[];
  nextActions: string[];
}

export interface ParameterGrowthPlan {
  id: string;
  generatedAt: string;
  status: ParameterGrowthPlanStatus;
  summary: {
    queuedCandidates: number;
    trainableCandidates: number;
    blockedCandidates: number;
    batches: number;
    readyBatches: number;
    estimatedNewParameters: number;
  };
  batches: ParameterGrowthBatch[];
  blockedCandidates: ParameterGrowthBlockedCandidate[];
  assumptions: string[];
}

export interface WrittenParameterGrowthPlan {
  path: string;
  latestPath: string;
  plan: ParameterGrowthPlan;
}

interface TargetSpec {
  kind: TrainableGrowthKind;
  purpose: string;
  route?: string;
}

const DEFAULT_MIN_ITEMS: Record<TrainableGrowthKind, number> = {
  adapter: 5,
  router: 20,
  specialist: 3,
  expert: 2,
};

const DEFAULT_PARAMETER_BUDGETS: Record<TrainableGrowthKind, number> = {
  adapter: 12_000_000,
  router: 343_050,
  specialist: 392_619,
  expert: 775_358,
};

export class ParameterGrowthPlanner {
  constructor(
    private readonly source: ParameterGrowthPlanningSource,
    private readonly options: ParameterGrowthPlannerOptions = {},
  ) {}

  async buildPlan(options: ParameterGrowthPlannerOptions = {}): Promise<ParameterGrowthPlan> {
    const config = resolveOptions(this.options, options);
    const items = await this.source.listLearnedItems({
      reviewStatus: "approved",
      trainingStatus: "queued",
      limit: config.limit,
    });
    return buildParameterGrowthPlan(items, config);
  }

  async writePlan(outDir: string, options: ParameterGrowthPlannerOptions = {}): Promise<WrittenParameterGrowthPlan> {
    const plan = await this.buildPlan(options);
    await mkdir(outDir, { recursive: true });
    const path = join(outDir, `${plan.id}.json`);
    const latestPath = join(outDir, "latest.json");
    const body = `${JSON.stringify(plan, null, 2)}\n`;
    await writeFile(path, body, "utf8");
    await writeFile(latestPath, body, "utf8");
    return { path, latestPath, plan };
  }
}

export function buildParameterGrowthPlan(
  items: LearnedItem[],
  options: Required<Pick<ParameterGrowthPlannerOptions, "limit" | "now">> &
    Pick<ParameterGrowthPlannerOptions, "minItemsByKind" | "parameterBudgets">,
): ParameterGrowthPlan {
  const generatedAt = options.now();
  const minItems = { ...DEFAULT_MIN_ITEMS, ...(options.minItemsByKind ?? {}) };
  const budgets = { ...DEFAULT_PARAMETER_BUDGETS, ...(options.parameterBudgets ?? {}) };
  const blockedCandidates = blockedItems(items);
  const trainable = items.filter(isTrainableQueuedItem);
  const groups = groupByTarget(trainable);
  const batches = [...groups.values()]
    .map((group) => buildBatch(group.target, group.items, generatedAt, minItems, budgets))
    .sort((a, b) => a.id.localeCompare(b.id));
  const readyBatches = batches.filter((batch) => batch.status === "ready").length;
  const status: ParameterGrowthPlanStatus =
    readyBatches > 0 ? "ready" : trainable.length > 0 ? "needs_more_data" : "blocked";

  return {
    id: `parameter-growth-${dateSlug(generatedAt)}-${hashText(stableJson({ generatedAt, items: items.map((item) => item.id) })).slice(0, 8)}`,
    generatedAt,
    status,
    summary: {
      queuedCandidates: items.length,
      trainableCandidates: trainable.length,
      blockedCandidates: blockedCandidates.length,
      batches: batches.length,
      readyBatches,
      estimatedNewParameters: batches
        .filter((batch) => batch.status === "ready")
        .reduce((sum, batch) => sum + batch.estimatedNewParameters, 0),
    },
    batches,
    blockedCandidates,
    assumptions: [
      "This plan does not train weights by itself; it is the reviewed handoff artifact for a background trainer.",
      "Full training text stays in the learned-item store. The plan stores source ids, hashes, and retrieval-safe previews only.",
      "A parameter module should be registered and promoted only after the listed gates pass and rollback metadata exists.",
    ],
  };
}

function buildBatch(
  target: TargetSpec,
  items: LearnedItem[],
  generatedAt: string,
  minItems: Record<TrainableGrowthKind, number>,
  budgets: Record<TrainableGrowthKind, number>,
): ParameterGrowthBatch {
  const records = items.map(toPlanRecord);
  const datasetHashes = records.map((record) => record.contentHash);
  const sourceLearningItemIds = records.map((record) => record.itemId);
  const sourceKinds = unique(items.map((item) => item.kind));
  const routeSlug = target.route ? `-${slug(target.route)}` : "";
  const targetSlug = `${target.kind}${routeSlug}`;
  const batchHash = hashText(stableJson({ target, sourceLearningItemIds, datasetHashes })).slice(0, 10);
  const requiredItems = minItems[target.kind];
  const blockers =
    records.length >= requiredItems
      ? []
      : [`needs at least ${requiredItems} queued approved trainable items for ${target.kind}; found ${records.length}`];
  const status: ParameterGrowthBatchStatus = blockers.length === 0 ? "ready" : "needs_more_data";

  return {
    id: `growth-batch-${targetSlug}-${batchHash}`,
    status,
    purpose: target.purpose,
    targetKind: target.kind,
    ...(target.route ? { route: target.route } : {}),
    moduleName: `irene-${targetSlug}-${dateSlug(generatedAt)}-${batchHash.slice(0, 6)}`,
    datasetId: `learned-${targetSlug}-${batchHash}`,
    estimatedNewParameters: budgets[target.kind],
    activeParameters: budgets[target.kind],
    trainableParameters: budgets[target.kind],
    sourceLearningItemIds,
    sourceKinds,
    datasetHashes,
    records,
    gateRequirements: gateRequirements(target, sourceKinds),
    riskFlags: riskFlags(items),
    blockers,
    nextActions:
      status === "ready"
        ? [
            "export reviewed source rows into a training split",
            "run contamination checks against held-out evals",
            "train the target adapter/specialist/expert",
            "attach eval reports and rollback target before module promotion",
          ]
        : [
            "continue collecting reviewed queued learning items for this target",
            "do not train or register a parameter module for this batch yet",
          ],
  };
}

function groupByTarget(items: LearnedItem[]): Map<string, { target: TargetSpec; items: LearnedItem[] }> {
  const groups = new Map<string, { target: TargetSpec; items: LearnedItem[] }>();
  for (const item of items) {
    const target = targetForItem(item);
    const key = `${target.kind}:${target.route ?? target.purpose}`;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { target, items: [item] });
  }
  return groups;
}

function targetForItem(item: LearnedItem): TargetSpec {
  const toolName = stringMetadata(item.metadata, "toolName");
  if (item.kind === "skill" && toolName) {
    return { kind: "expert", route: toolName, purpose: `tool skill expert for ${toolName}` };
  }
  if (item.kind === "skill") {
    return { kind: "specialist", route: "tool_protocol", purpose: "general tool workflow specialist" };
  }
  if (item.kind === "eval_failure") {
    const failureType = stringMetadata(item.metadata, "failureType") ?? "failure_repair";
    return { kind: "specialist", route: failureType, purpose: `failure repair specialist for ${failureType}` };
  }
  if (item.kind === "preference" || item.kind === "correction") {
    return { kind: "adapter", route: "behavior", purpose: "behavior and preference adapter" };
  }
  if (item.kind === "voice_summary") {
    return { kind: "specialist", route: "voice", purpose: "voice continuity specialist" };
  }
  return { kind: "adapter", route: "knowledge", purpose: "knowledge and memory adapter" };
}

function toPlanRecord(item: LearnedItem): ParameterGrowthPlanRecord {
  const base: ParameterGrowthPlanRecord = {
    itemId: item.id,
    kind: item.kind,
    source: item.source,
    confidence: item.confidence,
    contentHash: hashText(item.content),
    metadataHash: hashText(stableJson(item.metadata)),
    canRetrieve: item.retention.canRetrieve,
    canTrain: item.retention.canTrain,
  };
  return item.retention.canRetrieve ? { ...base, contentPreview: preview(item.content) } : base;
}

function blockedItems(items: LearnedItem[]): ParameterGrowthBlockedCandidate[] {
  return items.flatMap((item) => {
    const reason = blockReason(item);
    return reason ? [{ itemId: item.id, kind: item.kind, reason }] : [];
  });
}

function blockReason(item: LearnedItem): string | null {
  if (item.reviewStatus !== "approved") return "item is not approved";
  if (item.training.status !== "queued") return "item is not queued for training";
  if (!item.retention.canTrain) return "item retention policy does not allow training";
  return null;
}

function isTrainableQueuedItem(item: LearnedItem): boolean {
  return blockReason(item) === null;
}

function gateRequirements(target: TargetSpec, sourceKinds: LearningKind[]): string[] {
  const gates = new Set<string>(["contamination", "training_report", "parameter_growth"]);
  if (target.kind === "expert" || sourceKinds.includes("skill")) gates.add("skill");
  if (target.kind === "specialist" && target.route === "tool_protocol") gates.add("protocol");
  if (target.route === "failure_repair") gates.add("protocol");
  if (target.route === "behavior" || sourceKinds.includes("preference") || sourceKinds.includes("correction")) {
    gates.add("behavior");
  }
  if (target.route === "knowledge" || sourceKinds.includes("memory") || sourceKinds.includes("document")) {
    gates.add("knowledge");
    gates.add("memory");
  }
  if (target.route === "voice" || sourceKinds.includes("voice_summary")) gates.add("voice");
  return [...gates].sort();
}

function riskFlags(items: LearnedItem[]): string[] {
  const flags = new Set<string>();
  if (items.length < 20) flags.add("small_batch_overfit_risk");
  if (items.some((item) => item.provenance.userId)) flags.add("first_party_user_data_review_required");
  if (items.some((item) => item.confidence < 0.8)) flags.add("low_confidence_source_present");
  if (items.some((item) => !item.retention.canRetrieve)) flags.add("contains_non_retrievable_training_source");
  return [...flags].sort();
}

function resolveOptions(
  base: ParameterGrowthPlannerOptions,
  override: ParameterGrowthPlannerOptions,
): Required<Pick<ParameterGrowthPlannerOptions, "limit" | "now">> &
  Pick<ParameterGrowthPlannerOptions, "minItemsByKind" | "parameterBudgets"> {
  return {
    limit: override.limit ?? base.limit ?? 500,
    now: override.now ?? base.now ?? (() => new Date().toISOString()),
    minItemsByKind: { ...(base.minItemsByKind ?? {}), ...(override.minItemsByKind ?? {}) },
    parameterBudgets: { ...(base.parameterBudgets ?? {}), ...(override.parameterBudgets ?? {}) },
  };
}

function stringMetadata(metadata: JsonObject, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stableJson(value: JsonValue | JsonObject | unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function preview(content: string): string {
  const normalized = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function dateSlug(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, 14) || "undated";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
