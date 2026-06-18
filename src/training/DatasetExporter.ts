import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { toChatMLRecord } from "./formats/chatml";
import { toToolCallingRecord, type DpoRecord } from "./formats/toolCallingJsonl";
import { toAlpacaRecord } from "./formats/alpaca";

/**
 * Exports stored TrainingExample rows into training-ready JSONL files:
 *   exports/training/chatml.jsonl           (plain conversational turns)
 *   exports/training/tool-calling.jsonl     (full tool trajectories)
 *   exports/training/dpo-placeholder.jsonl  (synthetic/exported preference pairs)
 *   exports/training/preference-feedback.jsonl (explicit reviewed feedback pairs)
 *
 * DPO status (honest): real preference pairs require human feedback
 * (UserFeedback rows / 👍👎 reactions), which this foundation collects but
 * has no volume of yet. Synthetic pairs from generate-tool-examples.ts
 * (valid tool call vs hallucinated tool) are exported when present; rows
 * without pair data are skipped, never fabricated.
 */

export interface ExportableExampleRow {
  id: string;
  source: string;
  format: string;
  inputJson: unknown;
  outputJson: unknown;
  qualityScore: number | null;
  reviewed: boolean;
  metadataJson: unknown;
}

export interface ExampleSource {
  listAll(limit?: number): Promise<ExportableExampleRow[]>;
}

export interface ExportableFeedbackPreferenceRow {
  id: string;
  conversationId: string;
  userId: string | null;
  rating: number | null;
  feedbackText: string | null;
  prompt: string;
  chosen: string;
  rejected: string;
  reviewed: boolean;
  metadataJson: unknown;
}

export interface FeedbackPreferenceSource {
  listReviewedPreferencePairs(limit?: number): Promise<ExportableFeedbackPreferenceRow[]>;
}

export interface ExportSummary {
  files: Array<{ path: string; lines: number }>;
  totalExamples: number;
  skipped: number;
  feedbackPreferences: number;
}

const exampleInputSchema = z
  .object({
    systemPrompt: z.string().default(""),
    userMessage: z.string().default(""),
  })
  .passthrough();

const exampleOutputSchema = z
  .object({
    finalResponse: z.string().default(""),
    parseOk: z.boolean().nullable().default(null),
    toolCall: z
      .object({
        name: z.string(),
        arguments: z.record(z.unknown()).default({}),
        reason: z.string().optional(),
      })
      .nullable()
      .default(null),
    toolResult: z.unknown().optional(),
    dpo: z
      .object({ prompt: z.string(), chosen: z.string(), rejected: z.string() })
      .nullable()
      .optional(),
  })
  .passthrough();
const metadataSchema = z.record(z.unknown());

export interface DatasetExporterOptions {
  source: ExampleSource;
  feedbackSource?: FeedbackPreferenceSource;
  logger: Logger;
  /** Exclude examples below this quality score (default 0.3). */
  minQualityScore?: number;
}

export class DatasetExporter {
  constructor(private readonly options: DatasetExporterOptions) {}

  async exportAll(outDir: string): Promise<ExportSummary> {
    const rows = await this.options.source.listAll();
    const minQuality = this.options.minQualityScore ?? 0.3;

    const chatml: string[] = [];
    const alpaca: string[] = [];
    const toolCalling: string[] = [];
    const dpo: string[] = [];
    const feedbackDpo: string[] = [];
    let skipped = 0;

    for (const row of rows) {
      const input = exampleInputSchema.safeParse(row.inputJson ?? {});
      const output = exampleOutputSchema.safeParse(row.outputJson ?? {});
      if (!input.success || !output.success) {
        skipped++;
        continue;
      }
      const inp = input.data;
      const out = output.data;

      if (row.qualityScore !== null && row.qualityScore < minQuality) {
        skipped++;
        continue;
      }

      // DPO pairs (explicitly marked rows only).
      if (out.dpo) {
        const metadata = metadataSchema.safeParse(row.metadataJson);
        const record: DpoRecord = {
          ...out.dpo,
          metadata: {
            ...(metadata.success ? metadata.data : {}),
            id: row.id,
            source: row.source,
            reviewed: row.reviewed,
            qualityScore: row.qualityScore,
          },
        };
        if (row.source === "FEEDBACK") {
          if (!row.reviewed) {
            skipped++;
            continue;
          }
          feedbackDpo.push(JSON.stringify(record));
        } else {
          dpo.push(JSON.stringify(record));
        }
        continue;
      }

      if (out.toolCall && row.format === "TOOL_CALLING_JSONL") {
        if (inp.userMessage.length === 0 || out.finalResponse.length === 0) {
          skipped++;
          continue;
        }
        toolCalling.push(
          JSON.stringify(
            toToolCallingRecord({
              systemPrompt: inp.systemPrompt,
              userMessage: inp.userMessage,
              toolName: out.toolCall.name,
              toolArguments: out.toolCall.arguments,
              ...(out.toolCall.reason ? { toolCallReason: out.toolCall.reason } : {}),
              toolResultJson: JSON.stringify(out.toolResult ?? null),
              finalResponse: out.finalResponse,
            }),
          ),
        );
        continue;
      }

      // Plain conversational example. Skip turns where the model failed the
      // output protocol — we don't want to teach format violations.
      if (out.parseOk === false) {
        skipped++;
        continue;
      }
      if (inp.userMessage.length === 0 || out.finalResponse.length === 0) {
        skipped++;
        continue;
      }
      const src = {
        systemPrompt: inp.systemPrompt,
        userMessage: inp.userMessage,
        assistantResponse: out.finalResponse,
      };
      chatml.push(JSON.stringify(toChatMLRecord(src)));
      alpaca.push(JSON.stringify(toAlpacaRecord(src)));
    }
    const explicitFeedbackPreferences = await this.loadFeedbackPreferenceRecords();
    feedbackDpo.push(...explicitFeedbackPreferences.map((record) => JSON.stringify(record)));

    await mkdir(outDir, { recursive: true });
    const files: ExportSummary["files"] = [];
    const writes: Array<[string, string[]]> = [
      ["chatml.jsonl", chatml],
      ["alpaca.jsonl", alpaca],
      ["tool-calling.jsonl", toolCalling],
      ["dpo-placeholder.jsonl", dpo],
      ["preference-feedback.jsonl", feedbackDpo],
    ];
    for (const [name, lines] of writes) {
      const path = join(outDir, name);
      await writeFile(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
      files.push({ path, lines: lines.length });
    }

    this.options.logger.info(
      { total: rows.length, skipped, files: files.map((f) => `${f.path}:${f.lines}`) },
      "training export complete",
    );
    return {
      files,
      totalExamples: rows.length - skipped,
      skipped,
      feedbackPreferences: feedbackDpo.length,
    };
  }

  private async loadFeedbackPreferenceRecords(): Promise<DpoRecord[]> {
    const rows = await this.options.feedbackSource?.listReviewedPreferencePairs();
    if (!rows) return [];
    return rows.flatMap((row) => {
      if (!row.reviewed || row.chosen.trim() === row.rejected.trim()) return [];
      const metadata = metadataSchema.safeParse(row.metadataJson);
      return [
        {
          prompt: row.prompt,
          chosen: row.chosen,
          rejected: row.rejected,
          metadata: {
            ...(metadata.success ? metadata.data : {}),
            id: row.id,
            conversationId: row.conversationId,
            userId: row.userId,
            rating: row.rating,
            feedbackText: row.feedbackText,
            source: "FEEDBACK",
            reviewed: true,
          },
        },
      ];
    });
  }
}
