import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPreferenceMixture,
  type PreferenceSource,
} from "../src/training/mixture/PreferenceMixtureBuilder";

describe("PreferenceMixtureBuilder", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds deterministic DPO train/validation files with provenance, dedupe, and synthetic caps", async () => {
    dir = await mkdtemp(join(tmpdir(), "preference-mixture-"));
    const rawDir = join(dir, "raw");
    const outDir = join(dir, "out");
    await mkdir(rawDir, { recursive: true });

    const feedbackPath = join(rawDir, "feedback.jsonl");
    const syntheticPath = join(rawDir, "synthetic.jsonl");
    await writeJsonl(feedbackPath, [
      dpoRecord("real-1", "prompt 1", "chosen 1", "rejected 1"),
      dpoRecord("real-2", "prompt 2", "chosen 2", "rejected 2"),
      dpoRecord("real-2", "prompt 2", "chosen 2", "rejected 2"),
      dpoRecord("bad", "same", "same", "same"),
    ]);
    await writeJsonl(syntheticPath, [
      syntheticDpo("synth-1", "use ping", "ping", "ping_fake"),
      syntheticDpo("synth-2", "use time", "time", "time_fake"),
      syntheticDpo("synth-3", "use stats", "stats", "stats_fake"),
    ]);

    const report = await buildPreferenceMixture({
      outDir,
      validationRatio: 0.25,
      maxSyntheticShare: 0.5,
      sources: [
        source("feedback", feedbackPath, true, "feedback"),
        source("missing-optional", join(rawDir, "missing.jsonl"), false, "exported_dpo"),
        source("synthetic", syntheticPath, true, "synthetic"),
      ],
    });

    expect(report.total).toBe(4); // 2 real + 2 synthetic capped at 50% share.
    expect(report.train).toBe(3);
    expect(report.validation).toBe(1);
    expect(report.syntheticShare).toBe(0.5);
    expect(report.syntheticOnly).toBe(false);
    expect(report.sources.find((item) => item.name === "missing-optional")).toMatchObject({
      present: false,
      reason: "missing-optional-file",
    });

    const train = await readJsonl(join(outDir, "production-dpo.train.jsonl"));
    const validation = await readJsonl(join(outDir, "production-dpo.validation.jsonl"));
    expect(train).toHaveLength(3);
    expect(validation).toHaveLength(1);
    for (const row of [...train, ...validation]) {
      expect(row).toMatchObject({
        prompt: expect.any(String),
        chosen: expect.any(String),
        rejected: expect.any(String),
        metadata: {
          preferenceHash: expect.any(String),
          sourcePath: expect.any(String),
        },
      });
      expect(row.chosen).not.toBe(row.rejected);
    }
  });

  it("keeps synthetic-only preference pairs but reports that they are synthetic-only", async () => {
    dir = await mkdtemp(join(tmpdir(), "preference-mixture-synthetic-only-"));
    const syntheticPath = join(dir, "synthetic.jsonl");
    await writeJsonl(syntheticPath, [syntheticDpo("synth-1", "use ping", "ping", "ping_fake")]);

    const report = await buildPreferenceMixture({
      outDir: join(dir, "out"),
      validationRatio: 0.5,
      sources: [source("synthetic", syntheticPath, true, "synthetic")],
    });

    expect(report.total).toBe(1);
    expect(report.synthetic).toBe(1);
    expect(report.syntheticOnly).toBe(true);
  });

  it("fails when a required preference source is missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "preference-mixture-missing-"));
    await expect(
      buildPreferenceMixture({
        outDir: join(dir, "out"),
        sources: [source("missing", join(dir, "missing.jsonl"), true, "feedback")],
      }),
    ).rejects.toThrow(/Required preference source is missing/);
  });
});

function source(name: string, path: string, required: boolean, kind: PreferenceSource["kind"]): PreferenceSource {
  return { name, path, required, kind };
}

function dpoRecord(id: string, prompt: string, chosen: string, rejected: string): unknown {
  return {
    prompt,
    chosen,
    rejected,
    metadata: { id, source: "feedback" },
  };
}

function syntheticDpo(id: string, prompt: string, chosenTool: string, rejectedTool: string): unknown {
  return {
    source: "SYNTHETIC",
    inputJson: { userMessage: prompt },
    outputJson: {
      dpo: {
        prompt,
        chosen: JSON.stringify({ type: "tool_call", tool: chosenTool, arguments: {} }),
        rejected: JSON.stringify({ type: "tool_call", tool: rejectedTool, arguments: {} }),
      },
    },
    metadataJson: { id, kind: "dpo_pair", tool: chosenTool },
  };
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown> & { chosen: string; rejected: string }>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown> & { chosen: string; rejected: string });
}
