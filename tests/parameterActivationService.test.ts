import { describe, expect, it } from "vitest";
import { ParameterActivationService } from "../src/learning/ParameterActivationService";
import type { LearnedItem, ParameterModule } from "../src/learning/LiveLearningRegistry";

describe("ParameterActivationService", () => {
  it("retrieves active growth modules with relevant retrievable source knowledge", async () => {
    const modules: ParameterModule[] = [
      parameterModule({
        id: "base-1",
        name: "qwen3-4b",
        kind: "base_model",
        parameters: 4_000_000_000,
        activeParameters: 4_000_000_000,
        sourceLearningItemIds: [],
      }),
      parameterModule({
        id: "expert-1",
        name: "discord tool-call expert",
        kind: "expert",
        route: "ping",
        parameters: 775_358,
        activeParameters: 775_358,
        sourceLearningItemIds: ["learned-1"],
        metadata: { toolName: "ping", tags: ["health", "tool"] },
      }),
      parameterModule({
        id: "staged-1",
        name: "inactive social specialist",
        kind: "specialist",
        status: "staged",
        sourceLearningItemIds: ["learned-2"],
      }),
    ];
    const items = new Map<string, LearnedItem>([
      [
        "learned-1",
        learnedItem({
          id: "learned-1",
          content: "Use ping for lightweight health checks before deeper diagnostics.",
        }),
      ],
      [
        "learned-2",
        learnedItem({
          id: "learned-2",
          content: "Inactive specialist source.",
        }),
      ],
    ]);

    const service = new ParameterActivationService({
      listParameterModules: async () => modules,
      getLearnedItem: async (id) => items.get(id) ?? null,
    });

    const hints = await service.retrieve({
      query: "can you ping and check health?",
      candidateToolNames: ["ping"],
    });

    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      id: "expert-1",
      name: "discord tool-call expert",
      kind: "expert",
      route: "ping",
      sourceSummaries: ["Use ping for lightweight health checks before deeper diagnostics."],
    });
  });

  it("does not expose non-retrievable source content", async () => {
    const service = new ParameterActivationService({
      listParameterModules: async () => [
        parameterModule({
          id: "adapter-1",
          name: "private preference adapter",
          kind: "adapter",
          sourceLearningItemIds: ["learned-private"],
          metadata: { tags: ["private", "preference"] },
        }),
      ],
      getLearnedItem: async () =>
        learnedItem({
          id: "learned-private",
          content: "Private source text.",
          retention: { canRetrieve: false, canTrain: true },
        }),
    });

    const hints = await service.retrieve({ query: "private preference behavior" });

    expect(hints).toHaveLength(1);
    expect(hints[0]?.sourceSummaries).toEqual([]);
  });

  it("uses specialist route context to activate matching promoted specialists", async () => {
    const service = new ParameterActivationService({
      listParameterModules: async () => [
        parameterModule({
          id: "persona-specialist",
          name: "identity response specialist",
          kind: "specialist",
          route: "persona",
          sourceLearningItemIds: ["persona-source"],
          metadata: { tags: ["identity"] },
        }),
        parameterModule({
          id: "knowledge-specialist",
          name: "technical answer specialist",
          kind: "specialist",
          route: "knowledge",
          sourceLearningItemIds: ["knowledge-source"],
          metadata: { tags: ["technical"] },
        }),
      ],
      getLearnedItem: async (id) =>
        learnedItem({
          id,
          content: id === "persona-source" ? "Keep identity answers short and consistent." : "Explain concepts.",
        }),
    });

    const hints = await service.retrieve({
      query: "what should people call you?",
      specialistRoute: "persona",
      specialistExpert: "conversation",
    });

    expect(hints.map((hint) => hint.id)).toEqual(["persona-specialist"]);
    expect(hints[0]).toMatchObject({ route: "persona", kind: "specialist" });
  });
});

function parameterModule(overrides: Partial<ParameterModule> = {}): ParameterModule {
  return {
    id: "module-1",
    name: "module",
    kind: "adapter",
    parameters: 12_000_000,
    activeParameters: 12_000_000,
    trainableParameters: 12_000_000,
    status: "active",
    datasetHashes: [],
    evalReports: [],
    sourceLearningItemIds: [],
    createdAt: "2026-06-18T15:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function learnedItem(overrides: Partial<LearnedItem> = {}): LearnedItem {
  return {
    id: "learned-1",
    kind: "skill",
    content: "Learned source content.",
    source: "tool_trace",
    confidence: 0.9,
    reviewStatus: "approved",
    accessPaths: ["skill_registry", "training_queue", "parameter_module"],
    provenance: {},
    retention: { canRetrieve: true, canTrain: true },
    training: { status: "trained" },
    parameterModuleIds: ["module-1"],
    createdAt: "2026-06-18T15:00:00.000Z",
    updatedAt: "2026-06-18T15:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}
