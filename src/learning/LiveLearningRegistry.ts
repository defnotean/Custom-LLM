import type { JsonObject } from "../types/common";
import { newId } from "../utils/ids";

export type LearningKind =
  | "memory"
  | "skill"
  | "preference"
  | "correction"
  | "eval_failure"
  | "voice_summary"
  | "document";

export type LearningAccessPath = "memory_rag" | "skill_registry" | "training_queue" | "parameter_module";
export type LearningReviewStatus = "candidate" | "approved" | "rejected";
export type TrainingPromotionStatus = "not_queued" | "queued" | "trained" | "blocked";

export interface LearningProvenance {
  userId?: string;
  guildId?: string | null;
  channelId?: string | null;
  conversationId?: string;
  memoryId?: string;
  toolLogId?: string;
  trainingExampleId?: string;
  interactionTraceId?: string;
  voiceSessionId?: string;
  sourceItemIds?: string[];
}

export interface LearningRetentionPolicy {
  canRetrieve: boolean;
  canTrain: boolean;
  deleteAt?: string;
}

export interface LearnedItem {
  id: string;
  kind: LearningKind;
  content: string;
  source: string;
  confidence: number;
  reviewStatus: LearningReviewStatus;
  accessPaths: LearningAccessPath[];
  provenance: LearningProvenance;
  retention: LearningRetentionPolicy;
  training: {
    status: TrainingPromotionStatus;
    queuedAt?: string;
    trainedAt?: string;
    datasetId?: string;
    reason?: string;
  };
  parameterModuleIds: string[];
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}

export type ParameterModuleKind =
  | "base_model"
  | "adapter"
  | "router"
  | "specialist"
  | "expert"
  | "merged_checkpoint"
  | "ensemble_member";

export type ParameterModuleStatus = "staged" | "active" | "retired" | "rejected";

export interface ParameterEvalReport {
  kind: "protocol" | "knowledge" | "behavior" | "router" | "memory" | "skill" | "voice" | "composite";
  path: string;
  status: "pass" | "fail" | "warn";
  summary?: string;
}

export interface ParameterModule {
  id: string;
  name: string;
  kind: ParameterModuleKind;
  parameters: number;
  activeParameters: number;
  trainableParameters: number;
  status: ParameterModuleStatus;
  baseModuleId?: string;
  route?: string;
  datasetHashes: string[];
  evalReports: ParameterEvalReport[];
  sourceLearningItemIds: string[];
  rollbackTargetId?: string;
  createdAt: string;
  promotedAt?: string;
  retiredAt?: string;
  metadata: JsonObject;
}

export interface ParameterGrowthSnapshot {
  generatedAt: string;
  baseModelParams: number;
  adapterParams: number;
  routerParams: number;
  specialistParams: number;
  expertParams: number;
  otherParams: number;
  totalSystemParams: number;
  stagedParams: number;
  activeParamsPerRequest: number;
  activeModuleIds: string[];
  stagedModuleIds: string[];
  selectedModuleIds: string[];
}

export interface KnowledgeLearningStatus {
  itemId: string;
  accessPaths: LearningAccessPath[];
  immediatelyRetrievable: boolean;
  queuedForTraining: boolean;
  trainedIntoParameters: boolean;
  parameterModuleIds: string[];
}

export interface LiveLearningRegistryOptions {
  now?: () => string;
  idFactory?: () => string;
  autoQueueConfidence?: number;
}

export class LiveLearningRegistry {
  private readonly learnedItems = new Map<string, LearnedItem>();
  private readonly parameterModules = new Map<string, ParameterModule>();
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly autoQueueConfidence: number;

  constructor(options?: LiveLearningRegistryOptions) {
    this.now = options?.now ?? (() => new Date().toISOString());
    this.idFactory = options?.idFactory ?? newId;
    this.autoQueueConfidence = options?.autoQueueConfidence ?? 0.92;
  }

  recordLearnedItem(input: {
    kind: LearningKind;
    content: string;
    source: string;
    confidence?: number;
    reviewStatus?: LearningReviewStatus;
    accessPaths?: LearningAccessPath[];
    provenance?: LearningProvenance;
    retention?: Partial<LearningRetentionPolicy>;
    metadata?: JsonObject;
  }): LearnedItem {
    const content = input.content.trim();
    if (!content) throw new Error("learned item content is required");
    const confidence = input.confidence ?? 0.5;
    if (confidence < 0 || confidence > 1) throw new Error("learned item confidence must be between 0 and 1");

    const timestamp = this.now();
    const item: LearnedItem = {
      id: this.idFactory(),
      kind: input.kind,
      content,
      source: input.source,
      confidence,
      reviewStatus: input.reviewStatus ?? "candidate",
      accessPaths: unique(input.accessPaths ?? defaultAccessPaths(input.kind)),
      provenance: input.provenance ?? {},
      retention: {
        canRetrieve: input.retention?.canRetrieve ?? true,
        canTrain: input.retention?.canTrain ?? false,
        ...(input.retention?.deleteAt ? { deleteAt: input.retention.deleteAt } : {}),
      },
      training: { status: "not_queued" },
      parameterModuleIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata ?? {},
    };
    this.learnedItems.set(item.id, item);
    return clone(item);
  }

  getLearnedItem(id: string): LearnedItem | null {
    const item = this.learnedItems.get(id);
    return item ? clone(item) : null;
  }

  listLearnedItems(filter?: { kind?: LearningKind; reviewStatus?: LearningReviewStatus }): LearnedItem[] {
    return [...this.learnedItems.values()]
      .filter((item) => (filter?.kind ? item.kind === filter.kind : true))
      .filter((item) => (filter?.reviewStatus ? item.reviewStatus === filter.reviewStatus : true))
      .map((item) => clone(item));
  }

  markReviewed(id: string, status: LearningReviewStatus): LearnedItem {
    const item = this.requireLearnedItem(id);
    item.reviewStatus = status;
    item.updatedAt = this.now();
    if (status === "rejected") {
      item.training = { status: "blocked", reason: "rejected" };
    }
    return clone(item);
  }

  queueForTraining(id: string, options?: { datasetId?: string; reason?: string; force?: boolean }): LearnedItem {
    const item = this.requireLearnedItem(id);
    if (!item.retention.canTrain && !options?.force) {
      throw new Error(`learned item ${id} is not allowed for training`);
    }
    if (item.reviewStatus === "rejected") {
      throw new Error(`learned item ${id} was rejected`);
    }
    if (!options?.force && item.reviewStatus !== "approved" && item.confidence < this.autoQueueConfidence) {
      throw new Error(`learned item ${id} is not approved or high-confidence enough for training`);
    }

    item.training = {
      status: "queued",
      queuedAt: this.now(),
      ...(options?.datasetId ? { datasetId: options.datasetId } : {}),
      ...(options?.reason ? { reason: options.reason } : {}),
    };
    item.accessPaths = unique([...item.accessPaths, "training_queue"]);
    item.updatedAt = this.now();
    return clone(item);
  }

  registerParameterModule(input: {
    name: string;
    kind: ParameterModuleKind;
    parameters: number;
    activeParameters?: number;
    trainableParameters?: number;
    status?: ParameterModuleStatus;
    baseModuleId?: string;
    route?: string;
    datasetHashes?: string[];
    evalReports?: ParameterEvalReport[];
    sourceLearningItemIds?: string[];
    rollbackTargetId?: string;
    metadata?: JsonObject;
  }): ParameterModule {
    if (!input.name.trim()) throw new Error("parameter module name is required");
    assertPositiveInteger(input.parameters, "parameters");
    if (input.activeParameters !== undefined) assertPositiveInteger(input.activeParameters, "activeParameters");
    if (input.trainableParameters !== undefined) assertNonNegativeInteger(input.trainableParameters, "trainableParameters");
    if ([...this.parameterModules.values()].some((module) => module.name === input.name)) {
      throw new Error(`parameter module already exists: ${input.name}`);
    }

    const id = this.idFactory();
    const module: ParameterModule = {
      id,
      name: input.name,
      kind: input.kind,
      parameters: input.parameters,
      activeParameters: input.activeParameters ?? input.parameters,
      trainableParameters: input.trainableParameters ?? (input.kind === "base_model" ? input.parameters : input.parameters),
      status: input.status ?? "staged",
      ...(input.baseModuleId ? { baseModuleId: input.baseModuleId } : {}),
      ...(input.route ? { route: input.route } : {}),
      datasetHashes: input.datasetHashes ?? [],
      evalReports: input.evalReports ?? [],
      sourceLearningItemIds: input.sourceLearningItemIds ?? [],
      ...(input.rollbackTargetId ? { rollbackTargetId: input.rollbackTargetId } : {}),
      createdAt: this.now(),
      metadata: input.metadata ?? {},
    };
    this.parameterModules.set(module.id, module);

    for (const itemId of module.sourceLearningItemIds) {
      this.attachParameterModule(itemId, module.id, { markTrained: module.status === "active" });
    }

    return clone(module);
  }

  getParameterModule(id: string): ParameterModule | null {
    const module = this.parameterModules.get(id);
    return module ? clone(module) : null;
  }

  listParameterModules(filter?: { kind?: ParameterModuleKind; status?: ParameterModuleStatus }): ParameterModule[] {
    return [...this.parameterModules.values()]
      .filter((module) => (filter?.kind ? module.kind === filter.kind : true))
      .filter((module) => (filter?.status ? module.status === filter.status : true))
      .map((module) => clone(module));
  }

  promoteParameterModule(id: string, options: { gateStatus: "pass" | "fail" | "warn"; evalReport?: ParameterEvalReport }): ParameterModule {
    const module = this.requireParameterModule(id);
    if (module.status !== "staged") throw new Error(`parameter module ${id} is not staged`);
    if (options.evalReport) module.evalReports.push(options.evalReport);
    if (options.gateStatus !== "pass") {
      throw new Error(`parameter module ${id} cannot be promoted without passing gates`);
    }
    module.status = "active";
    module.promotedAt = this.now();
    for (const itemId of module.sourceLearningItemIds) {
      this.attachParameterModule(itemId, module.id, { markTrained: true });
    }
    return clone(module);
  }

  retireParameterModule(id: string): ParameterModule {
    const module = this.requireParameterModule(id);
    module.status = "retired";
    module.retiredAt = this.now();
    return clone(module);
  }

  attachParameterModule(itemId: string, moduleId: string, options?: { markTrained?: boolean }): LearnedItem {
    const item = this.requireLearnedItem(itemId);
    this.requireParameterModule(moduleId);
    item.parameterModuleIds = unique([...item.parameterModuleIds, moduleId]);
    item.accessPaths = unique([...item.accessPaths, "parameter_module"]);
    if (options?.markTrained) {
      item.training = {
        ...item.training,
        status: "trained",
        trainedAt: this.now(),
      };
    }
    item.updatedAt = this.now();
    return clone(item);
  }

  getKnowledgeStatus(itemId: string): KnowledgeLearningStatus {
    const item = this.requireLearnedItem(itemId);
    return {
      itemId: item.id,
      accessPaths: [...item.accessPaths],
      immediatelyRetrievable: item.accessPaths.includes("memory_rag") || item.accessPaths.includes("skill_registry"),
      queuedForTraining: item.training.status === "queued",
      trainedIntoParameters: item.parameterModuleIds.length > 0 && item.training.status === "trained",
      parameterModuleIds: [...item.parameterModuleIds],
    };
  }

  getParameterSnapshot(options?: { selectedModuleIds?: string[] }): ParameterGrowthSnapshot {
    return buildParameterGrowthSnapshot([...this.parameterModules.values()], {
      generatedAt: this.now(),
      selectedModuleIds: options?.selectedModuleIds,
    });
  }

  private requireLearnedItem(id: string): LearnedItem {
    const item = this.learnedItems.get(id);
    if (!item) throw new Error(`learned item not found: ${id}`);
    return item;
  }

  private requireParameterModule(id: string): ParameterModule {
    const module = this.parameterModules.get(id);
    if (!module) throw new Error(`parameter module not found: ${id}`);
    return module;
  }
}

export function buildParameterGrowthSnapshot(
  modules: ParameterModule[],
  options?: { generatedAt?: string; selectedModuleIds?: string[] },
): ParameterGrowthSnapshot {
  const active = modules.filter((module) => module.status === "active");
  const staged = modules.filter((module) => module.status === "staged");
  const selectedIds = new Set(options?.selectedModuleIds ?? []);
  const selectedActive = active.filter((module) => selectedIds.has(module.id));
  const alwaysActive = active.filter((module) =>
    ["base_model", "adapter", "router", "merged_checkpoint"].includes(module.kind),
  );
  const perRequestModules = selectedIds.size > 0 ? uniqueModules([...alwaysActive, ...selectedActive]) : active;

  return {
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    baseModelParams: sumParams(active, "base_model"),
    adapterParams: sumParams(active, "adapter"),
    routerParams: sumParams(active, "router"),
    specialistParams: sumParams(active, "specialist"),
    expertParams: sumParams(active, "expert"),
    otherParams: active
      .filter((module) => !["base_model", "adapter", "router", "specialist", "expert"].includes(module.kind))
      .reduce((sum, module) => sum + module.parameters, 0),
    totalSystemParams: active.reduce((sum, module) => sum + module.parameters, 0),
    stagedParams: staged.reduce((sum, module) => sum + module.parameters, 0),
    activeParamsPerRequest: perRequestModules.reduce((sum, module) => sum + module.activeParameters, 0),
    activeModuleIds: active.map((module) => module.id),
    stagedModuleIds: staged.map((module) => module.id),
    selectedModuleIds: [...selectedIds],
  };
}

function defaultAccessPaths(kind: LearningKind): LearningAccessPath[] {
  switch (kind) {
    case "memory":
    case "voice_summary":
    case "document":
      return ["memory_rag"];
    case "skill":
      return ["skill_registry"];
    case "preference":
    case "correction":
    case "eval_failure":
      return ["training_queue"];
  }
}

function sumParams(modules: ParameterModule[], kind: ParameterModuleKind): number {
  return modules.filter((module) => module.kind === kind).reduce((sum, module) => sum + module.parameters, 0);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueModules(modules: ParameterModule[]): ParameterModule[] {
  const seen = new Set<string>();
  const out: ParameterModule[] = [];
  for (const module of modules) {
    if (seen.has(module.id)) continue;
    seen.add(module.id);
    out.push(module);
  }
  return out;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
