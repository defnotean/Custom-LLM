import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  evaluateMemoryContinuitySuite,
  writeMemoryContinuityEvalSuite,
  type MemoryContinuityEvalSuite,
} from "../src/training/eval/MemoryContinuityEvalSuite";

describe("MemoryContinuityEvalSuite", () => {
  it("builds and scores the deterministic memory continuity suite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-continuity-eval-"));
    const suitePath = join(dir, "memory-continuity.eval.json");

    const summary = await writeMemoryContinuityEvalSuite(suitePath);
    const report = await evaluateMemoryContinuitySuite(suitePath);

    expect(summary.cases).toBe(17);
    expect(summary.byKind.scope_isolation).toBe(3);
    expect(summary.byKind.forget).toBe(3);
    expect(summary.byKind.llm_extraction).toBe(5);
    expect(report.passRate).toBe(1);
    expect(report.storedExpectedRate).toBe(1);
    expect(report.recallHitRate).toBe(1);
    expect(report.isolationPassRate).toBe(1);
    expect(report.forgetPassRate).toBe(1);
    expect(report.policyRejectionPassRate).toBe(1);
    expect(report.learnedItemPassRate).toBe(1);
    expect(report.byKind.llm_extraction?.passRate).toBe(1);
    expect(report.failures).toEqual([]);
  });

  it("flags suite cases without an implemented evaluator", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-continuity-eval-"));
    const suitePath = join(dir, "bad-memory-continuity.eval.json");
    const suite: MemoryContinuityEvalSuite = {
      cases: [
        {
          id: "memory:case:not-implemented",
          kind: "explicit_recall",
          description: "Unsupported case id should fail closed.",
          metadata: {},
        },
      ],
    };
    await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");

    const report = await evaluateMemoryContinuitySuite(suitePath);

    expect(report.passRate).toBe(0);
    expect(report.recallHitRate).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.reasons[0]).toContain("no evaluator");
  });
});
