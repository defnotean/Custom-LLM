import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeMemoryContinuityEvalSuite,
  type MemoryContinuityEvalCase,
  type MemoryContinuityEvalSuite,
} from "../src/training/eval/MemoryContinuityEvalSuite";
import { checkMemoryContinuityCoverageReadiness } from "../src/training/quality/MemoryContinuityCoverageReadiness";

describe("MemoryContinuityCoverageReadiness", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes the checked-in memory continuity coverage suite", async () => {
    const suitePath = await writeDefaultSuite();

    const report = await checkMemoryContinuityCoverageReadiness({ suitePath });

    expect(report.status).toBe("pass");
    expect(report.summary.total).toBe(12);
    expect(report.summary.byKind.scope_isolation).toBe(3);
    expect(report.summary.byKind.forget).toBe(3);
    expect(report.summary.policyRejectionCases).toBe(2);
    expect(report.summary.learnedItemCases).toBe(2);
    expect(checkStatus(report.checks, "memory-coverage-scenario:implicit-preference-capture")).toBe("pass");
    expect(checkStatus(report.checks, "memory-coverage-scenario:explicit-learned-item-capture")).toBe("pass");
  });

  it("fails when policy rejection coverage is removed", async () => {
    const suitePath = await writeDefaultSuite();
    const suite = await readSuite(suitePath);
    suite.cases = suite.cases.filter((item) => item.kind !== "policy_rejection");
    await writeSuite(suitePath, suite);

    const report = await checkMemoryContinuityCoverageReadiness({ suitePath, minTotalCases: 0 });

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "memory-coverage-scenario:secret-rejection")).toBe("fail");
    expect(checkStatus(report.checks, "memory-coverage-scenario:oneoff-rejection")).toBe("fail");
  });

  it("fails when duplicate case ids are introduced", async () => {
    const suitePath = await writeDefaultSuite();
    const suite = await readSuite(suitePath);
    const first = suite.cases[0];
    const second = suite.cases[1];
    if (!first || !second) throw new Error("Expected memory continuity fixture rows");
    suite.cases[1] = { ...second, id: first.id };
    await writeSuite(suitePath, suite);

    const report = await checkMemoryContinuityCoverageReadiness({ suitePath });

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "memory-coverage-unique-ids")).toBe("fail");
  });

  async function writeDefaultSuite(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "memory-coverage-"));
    const suitePath = join(dir, "memory-continuity.eval.json");
    await writeMemoryContinuityEvalSuite(suitePath);
    return suitePath;
  }
});

async function readSuite(path: string): Promise<MemoryContinuityEvalSuite> {
  return JSON.parse(await readFile(path, "utf8")) as MemoryContinuityEvalSuite;
}

async function writeSuite(path: string, suite: { cases: MemoryContinuityEvalCase[] }): Promise<void> {
  await writeFile(path, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
}

function checkStatus(checks: Array<{ id: string; status: string }>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}
