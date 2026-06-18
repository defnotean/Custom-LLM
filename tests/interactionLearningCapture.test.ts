import { describe, expect, it } from "vitest";
import { InteractionLearningCapture } from "../src/learning/InteractionLearningCapture";
import type { InteractionTrace } from "../src/types/ai";
import { testLogger } from "./helpers";

describe("InteractionLearningCapture", () => {
  it("captures successful tool calls as skill candidates", async () => {
    const inputs: unknown[] = [];
    const capture = new InteractionLearningCapture(
      {
        createLearnedItem: async (input) => {
          inputs.push(input);
          return { id: "learned-skill" } as never;
        },
      },
      testLogger,
    );

    await capture.captureInteraction(
      {
        ...baseTrace(),
        toolCall: { name: "ping", arguments: {}, reason: "user asked" },
        toolResult: { ok: true, data: { pong: true } },
        toolSuccess: true,
        candidateToolNames: ["ping"],
        finalResponse: "pong",
      },
      { conversationId: "conversation-1", trainingExampleId: "training-1" },
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: "skill",
      source: "tool_success",
      accessPaths: ["skill_registry"],
      provenance: {
        conversationId: "conversation-1",
        trainingExampleId: "training-1",
        interactionTraceId: "trace-1",
      },
      retention: { canRetrieve: true, canTrain: true },
      metadata: { toolName: "ping", candidateTools: ["ping"] },
    });
    expect(inputs[0]).toMatchObject({
      content: expect.stringContaining("Skill candidate from a successful tool interaction."),
    });
  });

  it("captures parse and tool failures as eval failure candidates", async () => {
    const inputs: unknown[] = [];
    const capture = new InteractionLearningCapture(
      {
        createLearnedItem: async (input) => {
          inputs.push(input);
          return { id: "learned-failure" } as never;
        },
      },
      testLogger,
    );

    await capture.captureInteraction({
      ...baseTrace(),
      parseOk: false,
      rawModelOutput: "not json",
      errors: ["parse: no json object"],
      finalResponse: "not json",
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: "eval_failure",
      source: "parse_failure",
      accessPaths: ["training_queue"],
      retention: { canRetrieve: true, canTrain: true },
      metadata: { failureType: "parse_failure", parseOk: false },
    });
  });

  it("redacts obvious secrets from learned content", async () => {
    const inputs: Array<{ content: string }> = [];
    const capture = new InteractionLearningCapture(
      {
        createLearnedItem: async (input) => {
          inputs.push(input);
          return { id: "learned-failure" } as never;
        },
      },
      testLogger,
    );

    await capture.captureInteraction({
      ...baseTrace(),
      userMessage: "use api key: sk-thisshouldnotbestored123456",
      parseOk: false,
      errors: ["parse: api_key=sk-thisshouldnotbestored123456"],
      finalResponse: "sk-thisshouldnotbestored123456",
    });

    expect(inputs[0]?.content).not.toContain("sk-thisshouldnotbestored123456");
    expect(inputs[0]?.content).toContain("[redacted]");
    expect(JSON.stringify(inputs[0])).not.toContain("sk-thisshouldnotbestored123456");
  });
});

function baseTrace(): InteractionTrace {
  return {
    id: "trace-1",
    createdAt: "2026-06-18T14:20:00.000Z",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    username: "tester",
    discordMessageId: "message-1",
    userMessage: "ping please",
    systemPromptVersion: "test",
    systemPrompt: "system",
    memoriesRetrieved: [],
    candidateToolNames: [],
    likelyNeedsTool: false,
    parseOk: true,
    parsedAction: { type: "message", content: "ok" },
    finalResponse: "ok",
    errors: [],
  };
}
