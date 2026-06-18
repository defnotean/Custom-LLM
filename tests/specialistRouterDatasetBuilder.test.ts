import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildSpecialistRouterDataset } from "../src/training/router/SpecialistRouterDatasetBuilder";

describe("SpecialistRouterDatasetBuilder", () => {
  it("builds router-only ChatML and skips exact held-out eval prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "router-sft-"));
    const evalSuitePath = join(dir, "specialist-routing.eval.jsonl");
    const outDir = join(dir, "router");
    await writeFile(
      evalSuitePath,
      `${JSON.stringify({ id: "heldout", prompt: "what pronouns do you use?" })}\n`,
      "utf8",
    );

    const report = await buildSpecialistRouterDataset({
      evalSuitePath,
      outDir,
      validationShare: 0.25,
      variantsPerSeed: 1,
    });
    const trainRows = await readJsonl(join(outDir, "sft.train.jsonl"));
    const allRows = await readJsonl(join(outDir, "sft.all.jsonl"));
    const first = trainRows[0] as {
      messages: Array<{ role: string; content: string }>;
      metadata: Record<string, unknown>;
    };

    expect(report.accepted).toBeGreaterThan(0);
    expect(report.skippedEvalOverlap).toBe(1);
    expect(report.byRoute.tool_protocol).toBeGreaterThan(0);
    expect(first.messages[0]?.content).toContain("You are a specialist router");
    expect(first.messages[2]?.content).toContain("\"route\"");
    expect(first.metadata.source).toBe("synthetic_specialist_router");
    expect(allRows.some((row) => JSON.stringify(row).includes("what pronouns do you use?"))).toBe(false);
  });
});

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}
