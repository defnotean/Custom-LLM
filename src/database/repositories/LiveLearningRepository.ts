import type {
  LearningKind as DbLearningKind,
  LearningReviewStatus as DbLearningReviewStatus,
  ParameterModuleKind as DbParameterModuleKind,
  ParameterModuleStatus as DbParameterModuleStatus,
  Prisma,
  PrismaClient,
  TrainingPromotionStatus as DbTrainingPromotionStatus,
} from "@prisma/client";
import {
  buildParameterGrowthSnapshot,
  type LearnedItem,
  type LearningAccessPath,
  type LearningKind,
  type LearningProvenance,
  type LearningRetentionPolicy,
  type LearningReviewStatus,
  type ParameterEvalReport,
  type ParameterGrowthSnapshot,
  type ParameterModule,
  type ParameterModuleKind,
  type ParameterModuleStatus,
  type TrainingPromotionStatus,
} from "../../learning/LiveLearningRegistry";
import type { JsonObject, LearningStatsPayload } from "../../types/common";
import { toJsonValue } from "../../types/common";

export interface CreateLearnedItemInput {
  id?: string;
  kind: LearningKind;
  content: string;
  source: string;
  confidence?: number;
  reviewStatus?: LearningReviewStatus;
  accessPaths?: LearningAccessPath[];
  provenance?: LearningProvenance;
  retention?: Partial<LearningRetentionPolicy>;
  training?: Partial<LearnedItem["training"]> & { status?: TrainingPromotionStatus };
  metadata?: JsonObject;
}

export interface CreateParameterModuleInput {
  id?: string;
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
  createdAt?: string;
  promotedAt?: string;
  retiredAt?: string;
  metadata?: JsonObject;
}

export class LiveLearningRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async createLearnedItem(input: CreateLearnedItemInput): Promise<LearnedItem> {
    const content = input.content.trim();
    if (!content) throw new Error("learned item content is required");
    const confidence = input.confidence ?? 0.5;
    assertConfidence(confidence);
    const retention = normalizeRetention(input.retention);
    const training = normalizeTraining(input.training);

    const row = await this.prisma.learnedItem.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        kind: learningKindToDb[input.kind],
        content,
        source: input.source,
        confidence,
        reviewStatus: reviewStatusToDb[input.reviewStatus ?? "candidate"],
        trainingStatus: trainingStatusToDb[training.status],
        accessPathsJson: toInputJson(input.accessPaths ?? defaultAccessPaths(input.kind)),
        provenanceJson: toInputJson(input.provenance ?? {}),
        retentionJson: toInputJson(retention),
        trainingJson: toInputJson(training),
        metadataJson: toInputJson(input.metadata ?? {}),
      },
      include: learnedItemInclude,
    });

    return learnedItemFromRow(row);
  }

  async getLearnedItem(id: string): Promise<LearnedItem | null> {
    const row = await this.prisma.learnedItem.findUnique({
      where: { id },
      include: learnedItemInclude,
    });
    return row ? learnedItemFromRow(row) : null;
  }

  async listLearnedItems(filter?: {
    kind?: LearningKind;
    reviewStatus?: LearningReviewStatus;
    trainingStatus?: TrainingPromotionStatus;
    limit?: number;
  }): Promise<LearnedItem[]> {
    const where: Prisma.LearnedItemWhereInput = {};
    if (filter?.kind) where.kind = learningKindToDb[filter.kind];
    if (filter?.reviewStatus) where.reviewStatus = reviewStatusToDb[filter.reviewStatus];
    if (filter?.trainingStatus) where.trainingStatus = trainingStatusToDb[filter.trainingStatus];

    const rows = await this.prisma.learnedItem.findMany({
      where,
      include: learnedItemInclude,
      orderBy: { createdAt: "asc" },
      ...(filter?.limit ? { take: filter.limit } : {}),
    });
    return rows.map((row) => learnedItemFromRow(row));
  }

  async markReviewed(
    id: string,
    status: LearningReviewStatus,
    options?: { reviewerId?: string | null; reason?: string | null },
  ): Promise<LearnedItem> {
    const existing = await this.getRequiredLearnedItem(id);
    const blockedTraining = { status: "blocked" as const, reason: "rejected" };
    const reviewMetadata =
      options?.reviewerId || options?.reason
        ? {
            ...existing.metadata,
            review: {
              status,
              reviewedAt: this.now(),
              ...(options.reviewerId ? { reviewerId: options.reviewerId } : {}),
              ...(options.reason ? { reason: options.reason } : {}),
            },
          }
        : existing.metadata;
    const row = await this.prisma.learnedItem.update({
      where: { id },
      data: {
        reviewStatus: reviewStatusToDb[status],
        metadataJson: toInputJson(reviewMetadata),
        ...(status === "rejected"
          ? {
              trainingStatus: trainingStatusToDb.blocked,
              trainingJson: toInputJson(blockedTraining),
            }
          : {}),
      },
      include: learnedItemInclude,
    });
    return learnedItemFromRow(row);
  }

  async queueForTraining(
    id: string,
    options?: { datasetId?: string; reason?: string; force?: boolean; autoQueueConfidence?: number },
  ): Promise<LearnedItem> {
    const item = await this.getRequiredLearnedItem(id);
    if (!item.retention.canTrain && !options?.force) {
      throw new Error(`learned item ${id} is not allowed for training`);
    }
    if (item.reviewStatus === "rejected") throw new Error(`learned item ${id} was rejected`);
    const autoQueueConfidence = options?.autoQueueConfidence ?? 0.92;
    if (!options?.force && item.reviewStatus !== "approved" && item.confidence < autoQueueConfidence) {
      throw new Error(`learned item ${id} is not approved or high-confidence enough for training`);
    }

    const training: LearnedItem["training"] = {
      status: "queued",
      queuedAt: this.now(),
      ...(options?.datasetId ? { datasetId: options.datasetId } : {}),
      ...(options?.reason ? { reason: options.reason } : {}),
    };
    const row = await this.prisma.learnedItem.update({
      where: { id },
      data: {
        accessPathsJson: toInputJson(unique([...item.accessPaths, "training_queue"])),
        trainingStatus: trainingStatusToDb.queued,
        trainingJson: toInputJson(training),
      },
      include: learnedItemInclude,
    });
    return learnedItemFromRow(row);
  }

  async createParameterModule(input: CreateParameterModuleInput): Promise<ParameterModule> {
    const name = input.name.trim();
    if (!name) throw new Error("parameter module name is required");
    assertPositiveInteger(input.parameters, "parameters");
    const activeParameters = input.activeParameters ?? input.parameters;
    const trainableParameters = input.trainableParameters ?? input.parameters;
    assertPositiveInteger(activeParameters, "activeParameters");
    assertNonNegativeInteger(trainableParameters, "trainableParameters");

    const row = await this.prisma.parameterModuleRecord.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        name,
        kind: parameterModuleKindToDb[input.kind],
        parameters: BigInt(input.parameters),
        activeParameters: BigInt(activeParameters),
        trainableParameters: BigInt(trainableParameters),
        status: parameterModuleStatusToDb[input.status ?? "staged"],
        ...(input.baseModuleId ? { baseModuleId: input.baseModuleId } : {}),
        ...(input.route ? { route: input.route } : {}),
        datasetHashesJson: toInputJson(input.datasetHashes ?? []),
        evalReportsJson: toInputJson(input.evalReports ?? []),
        sourceLearningItemIdsJson: toInputJson(input.sourceLearningItemIds ?? []),
        ...(input.rollbackTargetId ? { rollbackTargetId: input.rollbackTargetId } : {}),
        ...(input.createdAt ? { createdAt: toDate(input.createdAt) } : {}),
        ...(input.promotedAt ? { promotedAt: toDate(input.promotedAt) } : {}),
        ...(input.retiredAt ? { retiredAt: toDate(input.retiredAt) } : {}),
        metadataJson: toInputJson(input.metadata ?? {}),
      },
    });

    for (const itemId of input.sourceLearningItemIds ?? []) {
      await this.linkLearnedItemToParameterModule(itemId, row.id, { markTrained: row.status === "ACTIVE" });
    }

    return parameterModuleFromRow(row);
  }

  async getParameterModule(id: string): Promise<ParameterModule | null> {
    const row = await this.prisma.parameterModuleRecord.findUnique({ where: { id } });
    return row ? parameterModuleFromRow(row) : null;
  }

  async listParameterModules(filter?: {
    kind?: ParameterModuleKind;
    status?: ParameterModuleStatus;
    limit?: number;
  }): Promise<ParameterModule[]> {
    const where: Prisma.ParameterModuleRecordWhereInput = {};
    if (filter?.kind) where.kind = parameterModuleKindToDb[filter.kind];
    if (filter?.status) where.status = parameterModuleStatusToDb[filter.status];

    const rows = await this.prisma.parameterModuleRecord.findMany({
      where,
      orderBy: { createdAt: "asc" },
      ...(filter?.limit ? { take: filter.limit } : {}),
    });
    return rows.map((row) => parameterModuleFromRow(row));
  }

  async promoteParameterModule(
    id: string,
    options: { gateStatus: "pass" | "fail" | "warn"; evalReport?: ParameterEvalReport },
  ): Promise<ParameterModule> {
    const existing = await this.getRequiredParameterModule(id);
    if (existing.status !== "staged") throw new Error(`parameter module ${id} is not staged`);
    if (options.gateStatus !== "pass") {
      throw new Error(`parameter module ${id} cannot be promoted without passing gates`);
    }

    const promotedAt = this.now();
    const evalReports = options.evalReport ? [...existing.evalReports, options.evalReport] : existing.evalReports;
    const row = await this.prisma.parameterModuleRecord.update({
      where: { id },
      data: {
        status: parameterModuleStatusToDb.active,
        promotedAt: toDate(promotedAt),
        evalReportsJson: toInputJson(evalReports),
      },
    });

    for (const itemId of existing.sourceLearningItemIds) {
      await this.linkLearnedItemToParameterModule(itemId, id, { markTrained: true, trainedAt: promotedAt });
    }

    return parameterModuleFromRow(row);
  }

  async retireParameterModule(id: string): Promise<ParameterModule> {
    const row = await this.prisma.parameterModuleRecord.update({
      where: { id },
      data: {
        status: parameterModuleStatusToDb.retired,
        retiredAt: toDate(this.now()),
      },
    });
    return parameterModuleFromRow(row);
  }

  async linkLearnedItemToParameterModule(
    learnedItemId: string,
    parameterModuleId: string,
    options?: { markTrained?: boolean; trainedAt?: string },
  ): Promise<LearnedItem> {
    const item = await this.getRequiredLearnedItem(learnedItemId);
    await this.prisma.learnedParameterModule.upsert({
      where: { learnedItemId_parameterModuleId: { learnedItemId, parameterModuleId } },
      create: { learnedItemId, parameterModuleId },
      update: {},
    });

    const training = options?.markTrained
      ? {
          ...item.training,
          status: "trained" as const,
          trainedAt: options.trainedAt ?? this.now(),
        }
      : item.training;

    const row = await this.prisma.learnedItem.update({
      where: { id: learnedItemId },
      data: {
        accessPathsJson: toInputJson(unique([...item.accessPaths, "parameter_module"])),
        ...(options?.markTrained
          ? {
              trainingStatus: trainingStatusToDb.trained,
              trainingJson: toInputJson(training),
            }
          : {}),
      },
      include: learnedItemInclude,
    });
    return learnedItemFromRow(row);
  }

  async getParameterSnapshot(options?: { selectedModuleIds?: string[] }): Promise<ParameterGrowthSnapshot> {
    const modules = await this.listParameterModules();
    return buildParameterGrowthSnapshot(modules, {
      generatedAt: this.now(),
      selectedModuleIds: options?.selectedModuleIds,
    });
  }

  async getStats(): Promise<LearningStatsPayload> {
    const [
      learnedItems,
      candidateItems,
      approvedItems,
      queuedItems,
      trainedItems,
      parameterModules,
      activeParameterModules,
      stagedParameterModules,
      snapshot,
    ] = await Promise.all([
      this.prisma.learnedItem.count(),
      this.prisma.learnedItem.count({ where: { reviewStatus: "CANDIDATE" } }),
      this.prisma.learnedItem.count({ where: { reviewStatus: "APPROVED" } }),
      this.prisma.learnedItem.count({ where: { trainingStatus: "QUEUED" } }),
      this.prisma.learnedItem.count({ where: { trainingStatus: "TRAINED" } }),
      this.prisma.parameterModuleRecord.count(),
      this.prisma.parameterModuleRecord.count({ where: { status: "ACTIVE" } }),
      this.prisma.parameterModuleRecord.count({ where: { status: "STAGED" } }),
      this.getParameterSnapshot(),
    ]);

    return {
      learnedItems,
      candidateItems,
      approvedItems,
      queuedItems,
      trainedItems,
      parameterModules,
      activeParameterModules,
      stagedParameterModules,
      totalSystemParams: snapshot.totalSystemParams,
      stagedParams: snapshot.stagedParams,
      activeParamsPerRequest: snapshot.activeParamsPerRequest,
    };
  }

  private async getRequiredLearnedItem(id: string): Promise<LearnedItem> {
    const item = await this.getLearnedItem(id);
    if (!item) throw new Error(`learned item not found: ${id}`);
    return item;
  }

  private async getRequiredParameterModule(id: string): Promise<ParameterModule> {
    const module = await this.getParameterModule(id);
    if (!module) throw new Error(`parameter module not found: ${id}`);
    return module;
  }
}

const learnedItemInclude = {
  parameterLinks: { select: { parameterModuleId: true } },
} satisfies Prisma.LearnedItemInclude;

type LearnedItemRow = {
  id: string;
  kind: DbLearningKind;
  content: string;
  source: string;
  confidence: number;
  reviewStatus: DbLearningReviewStatus;
  trainingStatus: DbTrainingPromotionStatus;
  accessPathsJson: unknown;
  provenanceJson: unknown;
  retentionJson: unknown;
  trainingJson: unknown;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
  parameterLinks?: Array<{ parameterModuleId: string }>;
};

type ParameterModuleRow = {
  id: string;
  name: string;
  kind: DbParameterModuleKind;
  parameters: bigint | number;
  activeParameters: bigint | number;
  trainableParameters: bigint | number;
  status: DbParameterModuleStatus;
  baseModuleId: string | null;
  route: string | null;
  datasetHashesJson: unknown;
  evalReportsJson: unknown;
  sourceLearningItemIdsJson: unknown;
  rollbackTargetId: string | null;
  metadataJson: unknown;
  createdAt: Date;
  promotedAt: Date | null;
  retiredAt: Date | null;
};

function learnedItemFromRow(row: LearnedItemRow): LearnedItem {
  const training = normalizeTraining(trainingObjectFromJson(row.trainingJson, row.trainingStatus));
  return {
    id: row.id,
    kind: learningKindFromDb[row.kind],
    content: row.content,
    source: row.source,
    confidence: row.confidence,
    reviewStatus: reviewStatusFromDb[row.reviewStatus],
    accessPaths: accessPathsFromJson(row.accessPathsJson),
    provenance: asJsonObject(row.provenanceJson) as LearningProvenance,
    retention: retentionFromJson(row.retentionJson),
    training,
    parameterModuleIds: unique(row.parameterLinks?.map((link) => link.parameterModuleId) ?? []),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    metadata: asJsonObject(row.metadataJson),
  };
}

function parameterModuleFromRow(row: ParameterModuleRow): ParameterModule {
  return {
    id: row.id,
    name: row.name,
    kind: parameterModuleKindFromDb[row.kind],
    parameters: safeBigIntToNumber(row.parameters, "parameters"),
    activeParameters: safeBigIntToNumber(row.activeParameters, "activeParameters"),
    trainableParameters: safeBigIntToNumber(row.trainableParameters, "trainableParameters"),
    status: parameterModuleStatusFromDb[row.status],
    ...(row.baseModuleId ? { baseModuleId: row.baseModuleId } : {}),
    ...(row.route ? { route: row.route } : {}),
    datasetHashes: stringArrayFromJson(row.datasetHashesJson),
    evalReports: evalReportsFromJson(row.evalReportsJson),
    sourceLearningItemIds: stringArrayFromJson(row.sourceLearningItemIdsJson),
    ...(row.rollbackTargetId ? { rollbackTargetId: row.rollbackTargetId } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.promotedAt ? { promotedAt: row.promotedAt.toISOString() } : {}),
    ...(row.retiredAt ? { retiredAt: row.retiredAt.toISOString() } : {}),
    metadata: asJsonObject(row.metadataJson),
  };
}

const learningKindToDb: Record<LearningKind, DbLearningKind> = {
  memory: "MEMORY",
  skill: "SKILL",
  preference: "PREFERENCE",
  correction: "CORRECTION",
  eval_failure: "EVAL_FAILURE",
  voice_summary: "VOICE_SUMMARY",
  document: "DOCUMENT",
};

const learningKindFromDb: Record<DbLearningKind, LearningKind> = {
  MEMORY: "memory",
  SKILL: "skill",
  PREFERENCE: "preference",
  CORRECTION: "correction",
  EVAL_FAILURE: "eval_failure",
  VOICE_SUMMARY: "voice_summary",
  DOCUMENT: "document",
};

const reviewStatusToDb: Record<LearningReviewStatus, DbLearningReviewStatus> = {
  candidate: "CANDIDATE",
  approved: "APPROVED",
  rejected: "REJECTED",
};

const reviewStatusFromDb: Record<DbLearningReviewStatus, LearningReviewStatus> = {
  CANDIDATE: "candidate",
  APPROVED: "approved",
  REJECTED: "rejected",
};

const trainingStatusToDb: Record<TrainingPromotionStatus, DbTrainingPromotionStatus> = {
  not_queued: "NOT_QUEUED",
  queued: "QUEUED",
  trained: "TRAINED",
  blocked: "BLOCKED",
};

const trainingStatusFromDb: Record<DbTrainingPromotionStatus, TrainingPromotionStatus> = {
  NOT_QUEUED: "not_queued",
  QUEUED: "queued",
  TRAINED: "trained",
  BLOCKED: "blocked",
};

const parameterModuleKindToDb: Record<ParameterModuleKind, DbParameterModuleKind> = {
  base_model: "BASE_MODEL",
  adapter: "ADAPTER",
  router: "ROUTER",
  specialist: "SPECIALIST",
  expert: "EXPERT",
  merged_checkpoint: "MERGED_CHECKPOINT",
  ensemble_member: "ENSEMBLE_MEMBER",
};

const parameterModuleKindFromDb: Record<DbParameterModuleKind, ParameterModuleKind> = {
  BASE_MODEL: "base_model",
  ADAPTER: "adapter",
  ROUTER: "router",
  SPECIALIST: "specialist",
  EXPERT: "expert",
  MERGED_CHECKPOINT: "merged_checkpoint",
  ENSEMBLE_MEMBER: "ensemble_member",
};

const parameterModuleStatusToDb: Record<ParameterModuleStatus, DbParameterModuleStatus> = {
  staged: "STAGED",
  active: "ACTIVE",
  retired: "RETIRED",
  rejected: "REJECTED",
};

const parameterModuleStatusFromDb: Record<DbParameterModuleStatus, ParameterModuleStatus> = {
  STAGED: "staged",
  ACTIVE: "active",
  RETIRED: "retired",
  REJECTED: "rejected",
};

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

function normalizeRetention(input?: Partial<LearningRetentionPolicy>): LearningRetentionPolicy {
  return {
    canRetrieve: input?.canRetrieve ?? true,
    canTrain: input?.canTrain ?? false,
    ...(typeof input?.deleteAt === "string" ? { deleteAt: input.deleteAt } : {}),
  };
}

function normalizeTraining(input?: Partial<LearnedItem["training"]> & { status?: TrainingPromotionStatus }): LearnedItem["training"] {
  const status = input?.status ?? "not_queued";
  return {
    status,
    ...(typeof input?.queuedAt === "string" ? { queuedAt: input.queuedAt } : {}),
    ...(typeof input?.trainedAt === "string" ? { trainedAt: input.trainedAt } : {}),
    ...(typeof input?.datasetId === "string" ? { datasetId: input.datasetId } : {}),
    ...(typeof input?.reason === "string" ? { reason: input.reason } : {}),
  };
}

function trainingObjectFromJson(value: unknown, fallbackStatus: DbTrainingPromotionStatus): Partial<LearnedItem["training"]> {
  const json = asJsonObject(value);
  const status = typeof json.status === "string" ? runtimeTrainingStatus(json.status) : trainingStatusFromDb[fallbackStatus];
  return {
    status,
    ...(typeof json.queuedAt === "string" ? { queuedAt: json.queuedAt } : {}),
    ...(typeof json.trainedAt === "string" ? { trainedAt: json.trainedAt } : {}),
    ...(typeof json.datasetId === "string" ? { datasetId: json.datasetId } : {}),
    ...(typeof json.reason === "string" ? { reason: json.reason } : {}),
  };
}

function runtimeTrainingStatus(value: string): TrainingPromotionStatus {
  if (value === "queued" || value === "trained" || value === "blocked" || value === "not_queued") return value;
  return "not_queued";
}

function accessPathsFromJson(value: unknown): LearningAccessPath[] {
  const allowed = new Set<LearningAccessPath>(["memory_rag", "skill_registry", "training_queue", "parameter_module"]);
  return stringArrayFromJson(value).filter((item): item is LearningAccessPath => allowed.has(item as LearningAccessPath));
}

function retentionFromJson(value: unknown): LearningRetentionPolicy {
  const json = asJsonObject(value);
  return {
    canRetrieve: typeof json.canRetrieve === "boolean" ? json.canRetrieve : true,
    canTrain: typeof json.canTrain === "boolean" ? json.canTrain : false,
    ...(typeof json.deleteAt === "string" ? { deleteAt: json.deleteAt } : {}),
  };
}

function evalReportsFromJson(value: unknown): ParameterEvalReport[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ParameterEvalReport => Boolean(item) && typeof item === "object");
}

function stringArrayFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value ?? {});
  if (json && typeof json === "object" && !Array.isArray(json)) return json as JsonObject;
  return {};
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return toJsonValue(value) as Prisma.InputJsonValue;
}

function toDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ISO date: ${value}`);
  return date;
}

function safeBigIntToNumber(value: bigint | number, label: string): number {
  const asBigInt = typeof value === "bigint" ? value : BigInt(value);
  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }
  return Number(asBigInt);
}

function assertConfidence(value: number): void {
  if (value < 0 || value > 1) throw new Error("learned item confidence must be between 0 and 1");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
