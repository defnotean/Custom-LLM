import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LearnedItem } from "../../learning/LiveLearningRegistry";
import type { ChatMessage } from "../../types/ai";
import type { JsonObject } from "../../types/common";
import {
  applyParameterGrowthPlanGate,
  type ParameterGrowthGateResult,
  type ParameterGrowthGateThresholds,
} from "./ParameterGrowthPlanGate";
import type { ParameterGrowthBatch, ParameterGrowthPlan } from "./ParameterGrowthPlanner";

export interface ParameterGrowthDatasetSource {
  getLearnedItem(id: string): Promise<LearnedItem | null>;
}

export interface ParameterGrowthDatasetBuilderOptions {
  outDir: string;
  gateThresholds?: Partial<ParameterGrowthGateThresholds>;
  now?: () => string;
}

export interface ParameterGrowthTrainingRecord {
  id: string;
  batchId: string;
  itemId: string;
  target: {
    kind: ParameterGrowthBatch["targetKind"];
    route?: string;
    moduleName: string;
    datasetId: string;
  };
  messages: ChatMessage[];
  source: {
    kind: LearnedItem["kind"];
    source: string;
    confidence: number;
    content: string;
    metadata: JsonObject;
  };
  quality: {
    reviewStatus: LearnedItem["reviewStatus"];
    trainingStatus: LearnedItem["training"]["status"];
    contentHash: string;
    metadataHash: string;
    canRetrieve: boolean;
    canTrain: boolean;
  };
}

export interface ParameterGrowthDatasetFile {
  batchId: string;
  path: string;
  lines: number;
  bytes: number;
  sha256: string;
}

export interface ParameterGrowthDatasetManifest {
  id: string;
  planId: string;
  generatedAt: string;
  gate: ParameterGrowthGateResult;
  files: ParameterGrowthDatasetFile[];
  batches: Array<{
    batchId: string;
    targetKind: ParameterGrowthBatch["targetKind"];
    route?: string;
    records: number;
    moduleName: string;
    datasetId: string;
  }>;
}

export interface ParameterGrowthDatasetBuildResult {
  manifestPath: string;
  manifest: ParameterGrowthDatasetManifest;
}

export class ParameterGrowthDatasetBuilder {
  constructor(private readonly source: ParameterGrowthDatasetSource) {}

  async build(plan: ParameterGrowthPlan, options: ParameterGrowthDatasetBuilderOptions): Promise<ParameterGrowthDatasetBuildResult> {
    const gate = applyParameterGrowthPlanGate({ plan, thresholds: options.gateThresholds });
    if (gate.status !== "pass") {
      throw new Error(`parameter growth plan gate failed: ${gate.failures.map((failure) => failure.code).join(", ")}`);
    }

    const generatedAt = options.now?.() ?? new Date().toISOString();
    const outDir = join(options.outDir, plan.id);
    await mkdir(outDir, { recursive: true });

    const files: ParameterGrowthDatasetFile[] = [];
    const batchSummaries: ParameterGrowthDatasetManifest["batches"] = [];
    for (const batch of plan.batches.filter((candidate) => candidate.status === "ready")) {
      const records = await this.recordsForBatch(batch);
      const path = join(outDir, `${batch.id}.jsonl`);
      const body = records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
      await writeFile(path, body, "utf8");
      files.push({ batchId: batch.id, path, lines: records.length, ...(await fileInfo(path)) });
      batchSummaries.push({
        batchId: batch.id,
        targetKind: batch.targetKind,
        ...(batch.route ? { route: batch.route } : {}),
        records: records.length,
        moduleName: batch.moduleName,
        datasetId: batch.datasetId,
      });
    }

    const manifest: ParameterGrowthDatasetManifest = {
      id: `parameter-growth-dataset-${dateSlug(generatedAt)}-${hashText(plan.id).slice(0, 8)}`,
      planId: plan.id,
      generatedAt,
      gate,
      files,
      batches: batchSummaries,
    };
    const manifestPath = join(outDir, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { manifestPath, manifest };
  }

  private async recordsForBatch(batch: ParameterGrowthBatch): Promise<ParameterGrowthTrainingRecord[]> {
    const records: ParameterGrowthTrainingRecord[] = [];
    for (const planRecord of batch.records) {
      const item = await this.source.getLearnedItem(planRecord.itemId);
      if (!item) throw new Error(`learned item not found for parameter growth dataset: ${planRecord.itemId}`);
      assertItemMatchesPlan(item, planRecord);
      records.push(toTrainingRecord(batch, item, planRecord.contentHash, planRecord.metadataHash));
    }
    return records;
  }
}

function toTrainingRecord(
  batch: ParameterGrowthBatch,
  item: LearnedItem,
  contentHash: string,
  metadataHash: string,
): ParameterGrowthTrainingRecord {
  return {
    id: `${batch.id}:${item.id}`,
    batchId: batch.id,
    itemId: item.id,
    target: {
      kind: batch.targetKind,
      ...(batch.route ? { route: batch.route } : {}),
      moduleName: batch.moduleName,
      datasetId: batch.datasetId,
    },
    messages: [
      {
        role: "system",
        content:
          "You are Irene. This is reviewed parameter-growth training material. Preserve tool gates, consent, safety boundaries, and the she/her Irene persona.",
      },
      {
        role: "user",
        content: `Reviewed ${item.kind} learning item for ${batch.purpose}:\n${item.content}`,
      },
      {
        role: "assistant",
        content: buildExpectedAssistantContent(item, batch),
      },
    ],
    source: {
      kind: item.kind,
      source: item.source,
      confidence: item.confidence,
      content: item.content,
      metadata: item.metadata,
    },
    quality: {
      reviewStatus: item.reviewStatus,
      trainingStatus: item.training.status,
      contentHash,
      metadataHash,
      canRetrieve: item.retention.canRetrieve,
      canTrain: item.retention.canTrain,
    },
  };
}

function buildExpectedAssistantContent(item: LearnedItem, batch: ParameterGrowthBatch): string {
  if (item.kind === "skill") {
    const toolName = typeof item.metadata.toolName === "string" ? item.metadata.toolName : batch.route;
    return `Use this reviewed skill as training signal for ${toolName ?? "tool workflow"} decisions. It must not bypass candidate-tool, permission, cooldown, confirmation, or safety gates.`;
  }
  if (item.kind === "eval_failure") {
    return "Use this failure as a regression case: avoid the captured mistake, preserve strict JSON protocol, and keep tool execution gated by code.";
  }
  if (item.kind === "preference" || item.kind === "correction") {
    return "Use this reviewed preference or correction to improve Irene's future behavior while preserving identity, privacy, and safety boundaries.";
  }
  if (item.kind === "memory" || item.kind === "document") {
    return "Use this reviewed knowledge only where relevant, and keep deletion/retention provenance intact.";
  }
  if (item.kind === "voice_summary") {
    return "Use this reviewed voice-session learning only under the configured voice retention policy.";
  }
  return "Use this reviewed learning item as scoped training signal for the target parameter module.";
}

function assertItemMatchesPlan(
  item: LearnedItem,
  planRecord: { itemId: string; contentHash: string; metadataHash: string },
): void {
  if (item.reviewStatus !== "approved") throw new Error(`learned item ${item.id} is not approved`);
  if (item.training.status !== "queued") throw new Error(`learned item ${item.id} is not queued for training`);
  if (!item.retention.canTrain) throw new Error(`learned item ${item.id} is not allowed for training`);
  if (hashText(item.content) !== planRecord.contentHash) {
    throw new Error(`learned item ${item.id} content hash changed since plan creation`);
  }
  if (hashText(stableJson(item.metadata)) !== planRecord.metadataHash) {
    throw new Error(`learned item ${item.id} metadata hash changed since plan creation`);
  }
}

async function fileInfo(path: string): Promise<{ bytes: number; sha256: string }> {
  const body = await readFile(path);
  return {
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function stableJson(value: unknown): string {
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

function dateSlug(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, 14) || "undated";
}
