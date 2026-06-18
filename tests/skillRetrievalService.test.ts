import { describe, expect, it } from "vitest";
import { SkillRetrievalService } from "../src/learning/SkillRetrievalService";
import type { LearnedItem } from "../src/learning/LiveLearningRegistry";

describe("SkillRetrievalService", () => {
  it("retrieves only approved retrievable skill hints and ranks by tool/query relevance", async () => {
    const calls: unknown[] = [];
    const service = new SkillRetrievalService({
      listLearnedItems: async (filter) => {
        calls.push(filter);
        return [
          learnedSkill({
            id: "skill-ping",
            content: "Skill candidate from a successful tool interaction.\nIntent: ping health check\nTool: ping",
            confidence: 0.8,
            metadata: { toolName: "ping" },
          }),
          learnedSkill({
            id: "skill-wipe",
            content: "Tool: risky_wipe",
            confidence: 1,
            metadata: { toolName: "risky_wipe" },
          }),
          learnedSkill({ id: "candidate", reviewStatus: "candidate", metadata: { toolName: "ping" } }),
          learnedSkill({ id: "hidden", accessPaths: [], metadata: { toolName: "ping" } }),
        ];
      },
    });

    const hints = await service.retrieve({
      query: "can you ping and check if you are alive",
      candidateToolNames: ["ping"],
      topK: 2,
    });

    expect(calls).toEqual([{ kind: "skill", reviewStatus: "approved", limit: 50 }]);
    expect(hints.map((hint) => hint.id)).toEqual(["skill-ping"]);
    expect(hints[0]).toMatchObject({ toolName: "ping", source: "tool_success" });
    expect(hints[0]?.content).toContain("Tool: ping");
  });
});

function learnedSkill(overrides: Partial<LearnedItem> = {}): LearnedItem {
  return {
    id: "skill-1",
    kind: "skill",
    content: "Skill candidate",
    source: "tool_success",
    confidence: 0.7,
    reviewStatus: "approved",
    accessPaths: ["skill_registry"],
    provenance: {},
    retention: { canRetrieve: true, canTrain: true },
    training: { status: "not_queued" },
    parameterModuleIds: [],
    createdAt: "2026-06-18T16:00:00.000Z",
    updatedAt: "2026-06-18T16:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}
