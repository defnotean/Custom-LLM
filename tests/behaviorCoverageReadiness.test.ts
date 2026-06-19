import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBehaviorEvalCases,
  type BehaviorEvalCase,
} from "../src/training/eval/BehaviorEvalSuite";
import { checkBehaviorCoverageReadiness } from "../src/training/quality/BehaviorCoverageReadiness";

describe("BehaviorCoverageReadiness", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes the checked-in Irene persona and social behavior suite", async () => {
    const suitePath = await writeSuite(buildBehaviorEvalCases());

    const report = await checkBehaviorCoverageReadiness({ suitePath });

    expect(report.status).toBe("pass");
    expect(report.summary.total).toBe(11);
    expect(report.summary.byKind.persona_identity).toBe(2);
    expect(report.summary.byRoute.persona).toBe(3);
    expect(report.summary.noToolContracts).toBe(11);
    expect(checkStatus(report.checks, "behavior-coverage-scenario:persona-identity-pronouns")).toBe("pass");
    expect(checkStatus(report.checks, "behavior-coverage-scenario:no-corporate-refusal-voice")).toBe("pass");
  });

  it("fails when she/her identity coverage is removed", async () => {
    const suitePath = await writeSuite(buildBehaviorEvalCases().filter((item) => item.kind !== "persona_identity"));

    const report = await checkBehaviorCoverageReadiness({ suitePath, minTotalCases: 0 });

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "behavior-coverage-scenario:persona-identity-pronouns")).toBe("fail");
    expect(report.scenarios.find((scenario) => scenario.id === "persona-identity-pronouns")).toMatchObject({
      count: 0,
      minCases: 2,
    });
  });

  async function writeSuite(rows: BehaviorEvalCase[]): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "behavior-coverage-"));
    const suitePath = join(dir, "behavior.eval.jsonl");
    await mkdir(dir, { recursive: true });
    await writeFile(suitePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    return suitePath;
  }
});

function checkStatus(checks: Array<{ id: string; status: string }>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}
