import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONTAMINATION_TRAIN_PATHS,
  auditDataContamination,
} from "../src/training/quality/DataContaminationAudit";

describe("DataContaminationAudit", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("includes behavior and router specialist SFT in the default train paths", () => {
    expect(DEFAULT_CONTAMINATION_TRAIN_PATHS).toEqual(
      expect.arrayContaining([
        "training/data/behavior/sft.train.jsonl",
        "training/data/router/sft.train.jsonl",
      ]),
    );
  });

  it("passes when train and eval records are separated", async () => {
    const fixture = await writeFixture({
      train: [chatRecord("train-1", "How do I bake bread?", "Use flour, water, yeast, salt, and time.")],
      evalRows: [knowledgeCase("eval-1", "Name a planet", "Mars is a planet.")],
    });

    const report = await auditDataContamination({
      trainPaths: [fixture.trainPath],
      evalPaths: [fixture.evalPath],
      ngramSize: 4,
      overlapThreshold: 0.8,
    });

    expect(report.status).toBe("pass");
    expect(report.exactIdMatches).toHaveLength(0);
    expect(report.exactTextMatches).toHaveLength(0);
    expect(report.highOverlapMatches).toHaveLength(0);
  });

  it("fails on exact eval id and text leakage", async () => {
    const leaked = chatRecord("leaked-id", "What is pgvector?", "A PostgreSQL extension for vector search.");
    const fixture = await writeFixture({
      train: [leaked],
      evalRows: [knowledgeCase("leaked-id", "What is pgvector?", "A PostgreSQL extension for vector search.")],
    });

    const report = await auditDataContamination({
      trainPaths: [fixture.trainPath],
      evalPaths: [fixture.evalPath],
      ngramSize: 4,
    });

    expect(report.status).toBe("fail");
    expect(report.exactIdMatches).toHaveLength(1);
    expect(report.exactTextMatches).toHaveLength(1);
    expect(report.failures.join(" ")).toMatch(/exact id matches/);
  });

  it("fails on high n-gram overlap even when ids differ", async () => {
    const shared =
      "The local Discord AI platform retrieves memories, selects candidate tools, validates arguments, and records training traces.";
    const fixture = await writeFixture({
      train: [chatRecord("train-overlap", shared, "It then replies after all code-level gates pass.")],
      evalRows: [knowledgeCase("eval-overlap", shared, "It then replies after all code-level gates pass.")],
    });

    const report = await auditDataContamination({
      trainPaths: [fixture.trainPath],
      evalPaths: [fixture.evalPath],
      ngramSize: 5,
      overlapThreshold: 0.75,
    });

    expect(report.status).toBe("fail");
    expect(report.highOverlapMatches[0]).toMatchObject({
      trainId: "train-overlap",
      evalId: "eval-overlap",
      reason: "high_ngram_overlap",
    });
  });

  it("loads JSON eval suites that store cases in an object", async () => {
    dir = await mkdtemp(join(tmpdir(), "contamination-audit-"));
    await mkdir(dir, { recursive: true });
    const trainPath = join(dir, "train.jsonl");
    const evalPath = join(dir, "memory-continuity.eval.json");
    await writeJsonl(trainPath, [
      chatRecord("train-json-suite", "How do I bake bread?", "Use flour, water, yeast, salt, and time."),
    ]);
    await writeFile(
      evalPath,
      `${JSON.stringify(
        {
          cases: [
            {
              id: "memory:case:owner-forget",
              kind: "forget",
              description: "A user can delete their own USER memory and it disappears from recall.",
              metadata: {},
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const report = await auditDataContamination({
      trainPaths: [trainPath],
      evalPaths: [evalPath],
      ngramSize: 4,
    });

    expect(report.status).toBe("pass");
    expect(report.evalRecords).toBe(1);
  });

  async function writeFixture(options: { train: unknown[]; evalRows: unknown[] }): Promise<{
    trainPath: string;
    evalPath: string;
  }> {
    dir = await mkdtemp(join(tmpdir(), "contamination-audit-"));
    await mkdir(dir, { recursive: true });
    const trainPath = join(dir, "train.jsonl");
    const evalPath = join(dir, "eval.jsonl");
    await writeJsonl(trainPath, options.train);
    await writeJsonl(evalPath, options.evalRows);
    return { trainPath, evalPath };
  }
});

function chatRecord(id: string, prompt: string, answer: string): unknown {
  return {
    messages: [
      { role: "system", content: "You are a test assistant." },
      { role: "user", content: prompt },
      { role: "assistant", content: answer },
    ],
    metadata: { id, source: "fixture", split: "train" },
  };
}

function knowledgeCase(id: string, prompt: string, expected: string): unknown {
  return {
    id,
    source: "fixture",
    prompt,
    expected,
    metadata: { source: "fixture" },
  };
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}
