import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeEvalCase } from "../src/training/eval/KnowledgeEvalSuite";
import { checkKnowledgeCoverageReadiness } from "../src/training/quality/KnowledgeCoverageReadiness";

describe("KnowledgeCoverageReadiness", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes the checked-in balanced knowledge suite", async () => {
    const suitePath = await copyCheckedInSuite();

    const report = await checkKnowledgeCoverageReadiness({ suitePath });

    expect(report.status).toBe("pass");
    expect(report.summary.total).toBe(200);
    expect(report.summary.bySource).toMatchObject({ dolly: 99, oasst1_ready: 101 });
    expect(report.summary.contextGroundedCases).toBeGreaterThanOrEqual(25);
    expect(report.summary.technicalCases).toBeGreaterThanOrEqual(15);
    expect(report.summary.expectedHashMatches).toBe(200);
    expect(checkStatus(report.checks, "knowledge-coverage-scenario:technical-code")).toBe("pass");
    expect(checkStatus(report.checks, "knowledge-coverage-expected-hashes")).toBe("pass");
  });

  it("fails when source coverage collapses to one dataset", async () => {
    const suitePath = await copyCheckedInSuite();
    const rows = await readSuite(suitePath);
    await writeSuite(
      suitePath,
      rows.filter((item) => item.source !== "dolly"),
    );

    const report = await checkKnowledgeCoverageReadiness({ suitePath, minTotalCases: 0 });

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "knowledge-coverage-scenario:source-dolly")).toBe("fail");
  });

  it("fails when expected-answer hashes no longer match references", async () => {
    const suitePath = await copyCheckedInSuite();
    const rows = await readSuite(suitePath);
    const first = rows[0];
    if (!first) throw new Error("Expected checked-in knowledge suite to contain rows");
    rows[0] = { ...first, expected: `${first.expected} stale` };
    await writeSuite(suitePath, rows);

    const report = await checkKnowledgeCoverageReadiness({ suitePath });

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "knowledge-coverage-expected-hashes")).toBe("fail");
  });

  async function copyCheckedInSuite(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "knowledge-coverage-"));
    const suitePath = join(dir, "knowledge.eval.jsonl");
    await writeFile(suitePath, await readFile("training/evals/knowledge.eval.jsonl", "utf8"), "utf8");
    return suitePath;
  }
});

async function readSuite(path: string): Promise<KnowledgeEvalCase[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as KnowledgeEvalCase);
}

async function writeSuite(path: string, rows: KnowledgeEvalCase[]): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function checkStatus(checks: Array<{ id: string; status: string }>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}
