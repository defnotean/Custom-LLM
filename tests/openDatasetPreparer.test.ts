import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildExternalSftDataset } from "../src/training/external/OpenDatasetPreparer";

describe("OpenDatasetPreparer", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds deterministic train/validation JSONL with filtering and provenance", async () => {
    dir = await mkdtemp(join(tmpdir(), "open-datasets-"));
    const rawDir = join(dir, "raw");
    const outDir = join(dir, "processed");
    await mkdir(rawDir, { recursive: true });

    await writeFile(
      join(rawDir, "databricks-dolly-15k.jsonl"),
      [
        JSON.stringify({
          instruction: "Explain tool routing.",
          context: "",
          response: "Tool routing selects a small set of relevant tools before prompting.",
          category: "open_qa",
        }),
        JSON.stringify({
          instruction: "This has a secret",
          context: "",
          response: "password=super-secret-value",
          category: "bad",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const oasstRows = [
      {
        message_id: "prompt-1",
        parent_id: null,
        text: "What is memory retrieval?",
        role: "prompter",
        lang: "en",
        review_result: true,
        deleted: false,
        rank: null,
      },
      {
        message_id: "assistant-1",
        parent_id: "prompt-1",
        text: "It fetches relevant stored memories before the model answers.",
        role: "assistant",
        lang: "en",
        review_result: true,
        deleted: false,
        rank: 0,
      },
      {
        message_id: "assistant-2",
        parent_id: "missing",
        text: "This should be skipped because its parent is missing.",
        role: "assistant",
        lang: "en",
        review_result: true,
        deleted: false,
        rank: 0,
      },
    ];
    await writeFile(
      join(rawDir, "2023-04-12_oasst_ready.messages.jsonl.gz"),
      gzipSync(oasstRows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
    );

    const summary = await buildExternalSftDataset({
      rawDir,
      outDir,
      maxPerSource: 10,
      validationRatio: 0.5,
    });

    expect(summary.accepted).toBe(2);
    expect(summary.skipped["dolly:sensitive"]).toBe(1);
    expect(summary.bySource.dolly?.accepted).toBe(1);
    expect(summary.bySource.oasst1_ready?.accepted).toBe(1);
    expect(summary.train + summary.validation).toBe(2);

    const allLines = (await readFile(join(outDir, "sft.all.jsonl"), "utf8")).trim().split("\n");
    expect(allLines).toHaveLength(2);
    const first = JSON.parse(allLines[0] ?? "{}") as { messages: Array<{ role: string }>; metadata: { source: string; license: string } };
    expect(first.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    expect(["dolly", "oasst1_ready"]).toContain(first.metadata.source);
    expect(first.metadata.license).toBeTruthy();

    const report = JSON.parse(await readFile(join(outDir, "dataset_report.json"), "utf8")) as { files: unknown[] };
    expect(report.files.length).toBeGreaterThanOrEqual(4);
  });

  it("balances eval seed records across validation sources", async () => {
    dir = await mkdtemp(join(tmpdir(), "open-datasets-balanced-eval-"));
    const rawDir = join(dir, "raw");
    const outDir = join(dir, "processed");
    await mkdir(rawDir, { recursive: true });

    await writeFile(
      join(rawDir, "databricks-dolly-15k.jsonl"),
      Array.from({ length: 6 }, (_, index) =>
        JSON.stringify({
          instruction: `Dolly question ${index}`,
          context: "",
          response: `Dolly answer ${index}`,
          category: "open_qa",
        }),
      ).join("\n") + "\n",
      "utf8",
    );

    const oasstRows = [0, 1].flatMap((index) => [
      {
        message_id: `prompt-${index}`,
        parent_id: null,
        text: `OASST question ${index}`,
        role: "prompter",
        lang: "en",
        review_result: true,
        deleted: false,
        rank: null,
      },
      {
        message_id: `assistant-${index}`,
        parent_id: `prompt-${index}`,
        text: `OASST answer ${index}`,
        role: "assistant",
        lang: "en",
        review_result: true,
        deleted: false,
        rank: 0,
      },
    ]);
    await writeFile(
      join(rawDir, "2023-04-12_oasst_ready.messages.jsonl.gz"),
      gzipSync(oasstRows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
    );

    const summary = await buildExternalSftDataset({
      rawDir,
      outDir,
      maxPerSource: 10,
      validationRatio: 1,
      evalSeedSize: 4,
    });

    expect(summary.evalSeed).toBe(4);
    expect(summary.evalSeedBySource).toEqual({ dolly: 2, oasst1_ready: 2 });

    const seedSources = (await readFile(join(outDir, "eval.seed.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { source: string }).source);
    expect(seedSources).toEqual(["dolly", "oasst1_ready", "dolly", "oasst1_ready"]);
  });

  it("keeps high-overlap train near-duplicates out of the eval seed", async () => {
    dir = await mkdtemp(join(tmpdir(), "open-datasets-eval-contamination-"));
    const rawDir = join(dir, "raw");
    const outDir = join(dir, "processed");
    await mkdir(rawDir, { recursive: true });

    const sharedAnswer =
      "This answer deliberately repeats enough words to produce many shared thirteen token ngrams " +
      "between training and validation examples while still using a different suffix for dedupe.";
    await writeFile(
      join(rawDir, "databricks-dolly-15k.jsonl"),
      Array.from({ length: 80 }, (_, index) =>
        JSON.stringify({
          instruction: "Explain the overlap guard case with a deliberately repeated prompt.",
          context: "",
          response: `${sharedAnswer} Unique suffix ${index}.`,
          category: "open_qa",
        }),
      ).join("\n") + "\n",
      "utf8",
    );
    await writeFile(join(rawDir, "2023-04-12_oasst_ready.messages.jsonl.gz"), gzipSync(""));

    const summary = await buildExternalSftDataset({
      rawDir,
      outDir,
      sources: ["dolly"],
      maxPerSource: 80,
      validationRatio: 0.5,
      evalSeedSize: 10,
    });

    expect(summary.train).toBeGreaterThan(0);
    expect(summary.validation).toBeGreaterThan(0);
    expect(summary.evalSeed).toBe(0);
    expect(summary.evalSeedSkippedHighOverlap).toBe(summary.validation);
    expect(await readFile(join(outDir, "eval.seed.jsonl"), "utf8")).toBe("");
  });
});
