import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  evaluateSkillRetrievalSuite,
  writeSkillRetrievalEvalSuite,
  type SkillRetrievalEvalSuite,
} from "../src/training/eval/SkillRetrievalEvalSuite";
import type { LearnedItem } from "../src/learning/LiveLearningRegistry";

describe("SkillRetrievalEvalSuite", () => {
  it("builds and scores the deterministic skill retrieval suite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-retrieval-eval-"));
    const suitePath = join(dir, "skill-retrieval.eval.json");

    const summary = await writeSkillRetrievalEvalSuite(suitePath);
    const report = await evaluateSkillRetrievalSuite(suitePath);

    expect(summary.cases).toBe(10);
    expect(summary.skills).toBe(8);
    expect(summary.byKind.negative).toBe(2);
    expect(report.recallAtK).toBe(1);
    expect(report.precisionAtK).toBe(1);
    expect(report.top1Accuracy).toBe(1);
    expect(report.noHitAccuracy).toBe(1);
    expect(report.forbiddenHits).toBe(0);
    expect(report.failures).toEqual([]);
  });

  it("flags missing expected skills and unexpected retrievals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-retrieval-eval-"));
    const suitePath = join(dir, "bad-skill-retrieval.eval.json");
    const suite: SkillRetrievalEvalSuite = {
      skills: [skill("skill:wrong", "ping", "Use ping for health checks.")],
      cases: [
        {
          id: "skill:case:missing",
          kind: "direct_tool",
          query: "ping health",
          candidateToolNames: ["ping"],
          expectedSkillIds: ["skill:expected"],
          forbiddenSkillIds: ["skill:wrong"],
          topK: 3,
          metadata: {},
        },
      ],
    };
    await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");

    const report = await evaluateSkillRetrievalSuite(suitePath);

    expect(report.recallAtK).toBe(0);
    expect(report.precisionAtK).toBe(0);
    expect(report.forbiddenHits).toBe(1);
    expect(report.failures.map((failure) => failure.reason)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing expected"),
        expect.stringContaining("retrieved unexpected"),
        expect.stringContaining("retrieved forbidden"),
      ]),
    );
  });
});

function skill(id: string, toolName: string, content: string): LearnedItem {
  return {
    id,
    kind: "skill",
    content,
    source: "tool_success",
    confidence: 0.9,
    reviewStatus: "approved",
    accessPaths: ["skill_registry"],
    provenance: {},
    retention: { canRetrieve: true, canTrain: true },
    training: { status: "not_queued" },
    parameterModuleIds: [],
    createdAt: "2026-06-18T17:00:00.000Z",
    updatedAt: "2026-06-18T17:00:00.000Z",
    metadata: { toolName },
  };
}
