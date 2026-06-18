import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSftMixture, type MixtureSource } from "../src/training/mixture/SftMixtureBuilder";

describe("SftMixtureBuilder", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds a deterministic mixture, reports missing optional sources, dedupes, and caps synthetic rows", async () => {
    dir = await mkdtemp(join(tmpdir(), "sft-mixture-"));
    const rawDir = join(dir, "raw");
    const outDir = join(dir, "mixture");
    await mkdir(rawDir, { recursive: true });

    const openTrain = join(rawDir, "open-train.jsonl");
    const openVal = join(rawDir, "open-val.jsonl");
    const synthetic = join(rawDir, "synthetic.jsonl");
    await writeJsonl(openTrain, [
      chatRecord("open-1", "train", "open_sft", "hello", "hi"),
      chatRecord("open-2", "train", "open_sft", "weather", "sunny"),
      chatRecord("open-2", "train", "open_sft", "weather", "sunny"),
    ]);
    await writeJsonl(openVal, [chatRecord("val-1", "validation", "open_sft", "test", "ok")]);
    await writeJsonl(synthetic, [
      syntheticRecord("synth-1", "ping", "Pong."),
      syntheticRecord("synth-2", "help", "Here is help."),
      syntheticRecord("synth-3", "stats", "Here are stats."),
    ]);

    const report = await buildSftMixture({
      outDir,
      maxSyntheticShare: 0.5,
      trainSources: [
        source("open", openTrain, true, "open_sft"),
        source("missing-optional", join(rawDir, "missing.jsonl"), false, "bot_log"),
        source("synthetic", synthetic, false, "synthetic"),
      ],
      validationSources: [source("validation", openVal, true, "open_sft")],
    });

    expect(report.train).toBe(4); // 2 open + 2 synthetic at max 50% share.
    expect(report.validation).toBe(1);
    expect(report.syntheticTrainShare).toBe(0.5);
    expect(report.sources.find((item) => item.name === "missing-optional")).toMatchObject({
      present: false,
      reason: "missing-optional-file",
    });

    const trainLines = (await readFile(join(outDir, "production-sft.train.jsonl"), "utf8")).trim().split("\n");
    expect(trainLines).toHaveLength(4);
    const records = trainLines.map((line) => JSON.parse(line) as { metadata: { mixtureSource: string; split: string } });
    expect(records.every((record) => record.metadata.split === "train")).toBe(true);
    expect(records.filter((record) => record.metadata.mixtureSource === "synthetic")).toHaveLength(2);
  });

  it("fails when a required source is missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "sft-mixture-missing-"));
    await expect(
      buildSftMixture({
        outDir: join(dir, "out"),
        trainSources: [source("missing", join(dir, "missing.jsonl"), true, "open_sft")],
        validationSources: [],
      }),
    ).rejects.toThrow(/Required mixture source is missing/);
  });

  it("filters records above the configured estimated token budget", async () => {
    dir = await mkdtemp(join(tmpdir(), "sft-mixture-token-budget-"));
    const rawDir = join(dir, "raw");
    const outDir = join(dir, "mixture");
    await mkdir(rawDir, { recursive: true });

    const openTrain = join(rawDir, "open-train.jsonl");
    const openVal = join(rawDir, "open-val.jsonl");
    await writeJsonl(openTrain, [
      chatRecord("short", "train", "open_sft", "hello", "short answer"),
      chatRecord("long", "train", "open_sft", "hello", Array.from({ length: 120 }, (_, index) => `token${index}`).join(" ")),
    ]);
    await writeJsonl(openVal, [chatRecord("val-1", "validation", "open_sft", "test", "ok")]);

    const report = await buildSftMixture({
      outDir,
      maxEstimatedTokens: 64,
      trainSources: [source("open", openTrain, true, "open_sft")],
      validationSources: [source("validation", openVal, true, "open_sft")],
    });

    expect(report.train).toBe(1);
    expect(report.maxEstimatedTokens).toBe(64);
    expect(report.sources.find((item) => item.name === "open")).toMatchObject({
      accepted: 1,
      skipped: 1,
      skippedOverLength: 1,
    });

    const trainLines = (await readFile(join(outDir, "production-sft.train.jsonl"), "utf8")).trim().split("\n");
    expect(trainLines).toHaveLength(1);
    expect(JSON.parse(trainLines[0] ?? "{}")).toMatchObject({ metadata: { id: "short" } });
  });
});

function source(name: string, path: string, required: boolean, kind: MixtureSource["kind"]): MixtureSource {
  return { name, path, required, kind };
}

function chatRecord(id: string, split: "train" | "validation", sourceName: string, user: string, assistant: string): unknown {
  return {
    messages: [
      { role: "system", content: "You are useful." },
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    ],
    metadata: { id, split, source: sourceName, license: "test" },
  };
}

function syntheticRecord(id: string, user: string, assistant: string): unknown {
  return {
    inputJson: { systemPrompt: "Use tools safely.", userMessage: user },
    outputJson: { finalResponse: assistant, toolCall: null },
    metadataJson: { id, kind: "synthetic" },
  };
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}
