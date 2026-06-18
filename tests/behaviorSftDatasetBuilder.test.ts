import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBehaviorSftDataset } from "../src/training/mixture/BehaviorSftDatasetBuilder";

describe("BehaviorSftDatasetBuilder", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("builds deterministic behavior SFT ChatML with JSON assistant actions", async () => {
    const fixture = await writeEvalFixture([]);
    const outDir = join(fixture.root, "behavior");

    const report = await buildBehaviorSftDataset({
      evalSuitePath: fixture.evalPath,
      outDir,
      variantsPerSeed: 2,
      validationShare: 0.25,
      botName: "Irene",
    });

    expect(report.accepted).toBeGreaterThan(20);
    expect(report.train + report.validation).toBe(report.accepted);
    expect(report.validation).toBeGreaterThan(0);
    expect(report.augmented).toBeGreaterThan(0);
    expect(report.skippedEvalOverlap).toBe(0);
    expect(report.byRoute.persona).toBeGreaterThan(0);
    expect(report.byRoute.social_cue).toBeGreaterThan(0);
    expect(report.byRoute.boundary).toBeGreaterThan(0);

    const trainRows = await readJsonl(join(outDir, "sft.train.jsonl"));
    const validationRows = await readJsonl(join(outDir, "sft.validation.jsonl"));
    expect(trainRows).toHaveLength(report.train);
    expect(validationRows).toHaveLength(report.validation);

    const first = trainRows[0] as ChatRecord;
    expect(first.messages[0]).toMatchObject({ role: "system" });
    expect(first.messages[0]?.content).toContain("You present as she/her");
    expect(first.messages[0]?.content).toContain("Output format - STRICT");
    expect(first.messages[1]).toMatchObject({ role: "user" });
    expect(first.messages[2]).toMatchObject({ role: "assistant" });
    expect(JSON.parse(first.messages[2]?.content ?? "{}")).toMatchObject({ type: expect.any(String) });
    expect(first.metadata).toMatchObject({
      source: "synthetic_behavior",
      license: "project-owned",
      split: "train",
      heldoutEvalGuard: "exact-prompt-match",
    });
    expect(new Set([...trainRows, ...validationRows].map((row) => (row as ChatRecord).metadata.id)).size).toBe(
      report.accepted,
    );
    expect(validationRows.every((row) => (row as ChatRecord).metadata.split === "validation")).toBe(true);
  });

  it("skips exact held-out eval prompts and reports duplicates separately", async () => {
    const fixture = await writeEvalFixture(["what should I call you?", "talk to me like a person"]);
    const outDir = join(fixture.root, "behavior");

    const report = await buildBehaviorSftDataset({
      evalSuitePath: fixture.evalPath,
      outDir,
      variantsPerSeed: 3,
    });

    expect(report.skippedEvalOverlap).toBe(2);
    expect(report.skippedDuplicates).toBe(0);
    const allRows = await readJsonl(join(outDir, "sft.all.jsonl"));
    const prompts = allRows.map((row) => String((row as ChatRecord).messages[1]?.content).toLowerCase());
    expect(prompts).not.toContain("what should i call you?");
    expect(prompts).not.toContain("talk to me like a person");
  });

  async function writeEvalFixture(prompts: string[]): Promise<{ root: string; evalPath: string }> {
    dir = await mkdtemp(join(tmpdir(), "behavior-sft-"));
    const evalPath = join(dir, "behavior.eval.jsonl");
    const rows = prompts.map((prompt, index) => ({ id: `eval-${index}`, prompt }));
    await writeFile(evalPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    return { root: dir, evalPath };
  }
});

interface ChatRecord {
  messages: Array<{ role: string; content: string }>;
  metadata: Record<string, unknown>;
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}
