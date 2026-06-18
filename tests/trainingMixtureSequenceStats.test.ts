import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeTrainingMixtureSequences,
  estimateChatMlTokens,
} from "../src/training/quality/TrainingMixtureSequenceStats";

describe("TrainingMixtureSequenceStats", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("estimates assistant-token share separately from prompt tokens", () => {
    const stats = estimateChatMlTokens([
      { role: "system", content: "You are concise." },
      { role: "user", content: "Explain pgvector." },
      { role: "assistant", content: "pgvector stores vector embeddings in Postgres." },
    ]);

    expect(stats.estimatedTokens).toBeGreaterThan(stats.estimatedAssistantTokens);
    expect(stats.estimatedAssistantTokens).toBeGreaterThan(0);
  });

  it("reports sequence length overflows and packed sequence estimates", async () => {
    dir = await mkdtemp(join(tmpdir(), "sequence-stats-"));
    await mkdir(dir, { recursive: true });
    const trainPath = join(dir, "train.jsonl");
    const validationPath = join(dir, "validation.jsonl");
    const longAnswer = Array.from({ length: 80 }, (_, index) => `token${index}`).join(" ");
    await writeFile(
      trainPath,
      `${jsonlRecord("short", "short answer")}\n${jsonlRecord("long", longAnswer)}\n`,
      "utf8",
    );
    await writeFile(validationPath, `${jsonlRecord("val", "validation answer")}\n`, "utf8");

    const report = await analyzeTrainingMixtureSequences({
      trainPath,
      validationPath,
      sequenceLength: 32,
      topLongest: 1,
    });

    expect(report.train.records).toBe(2);
    expect(report.train.overLengthRecords).toBe(1);
    expect(report.train.maxTokenBudgetUsage).toBeGreaterThan(1);
    expect(report.validation.maxTokenBudgetUsage).toBeLessThanOrEqual(1);
    expect(report.train.estimatedPackedSequences).toBeGreaterThan(1);
    expect(report.train.longest[0]).toMatchObject({ id: "long" });
    expect(report.total.estimatedTokens).toBeGreaterThan(report.total.estimatedAssistantTokens);
  });
});

function jsonlRecord(id: string, answer: string): string {
  return JSON.stringify({
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: `Question for ${id}?` },
      { role: "assistant", content: answer },
    ],
    metadata: { id, source: "fixture" },
  });
}
