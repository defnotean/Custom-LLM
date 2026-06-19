import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentController,
  type BehaviorGuardrailPort,
  type SpecialistRouterPort,
} from "../src/ai/orchestration/AgentController";
import { ToolRouterAgent } from "../src/ai/orchestration/ToolRouterAgent";
import { SafetyAgent } from "../src/ai/orchestration/SafetyAgent";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { ToolRouter } from "../src/tools/ToolRouter";
import { ToolExecutor } from "../src/tools/ToolExecutor";
import { ToolPermissionService } from "../src/tools/ToolPermissionService";
import { ToolCooldownService } from "../src/tools/ToolCooldownService";
import { defineTool, toolOk } from "../src/tools/ToolDefinition";
import { SafetyService } from "../src/safety/SafetyService";
import {
  InMemoryPendingConfirmationStore,
  type PendingConfirmationStore,
} from "../src/ai/orchestration/PendingConfirmationStore";
import type { BotMessageContext } from "../src/types/discord";
import type { InteractionTrace, ParameterModuleHint, SkillHint } from "../src/types/ai";
import { MockLLMProvider, testLogger } from "./helpers";
import { respondWithHeuristicBehaviorGuardrail } from "../src/ai/behavior/HeuristicBehaviorResponder";
import { routeWithHeuristicSpecialistRouter } from "../src/ai/routing/HeuristicSpecialistRouter";

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerTool(
    defineTool({
      name: "ping",
      category: "utility",
      description: "Check whether the bot is alive. ping pong latency check",
      examples: ["ping", "are you alive"],
      riskLevel: "low",
      requiresConfirmation: false,
      argsSchema: z.object({}),
      execute: async () => toolOk({ pong: true }),
    }),
  );
  registry.registerTool(
    defineTool({
      name: "risky_wipe",
      category: "moderation",
      description: "Dangerous destructive wipe action for testing confirmation gates",
      examples: ["wipe everything"],
      riskLevel: "high",
      requiresConfirmation: true,
      argsSchema: z.object({}),
      execute: async () => toolOk({ wiped: true }),
    }),
  );
  return registry;
}

function makeCtx(content: string): BotMessageContext {
  return {
    guildId: "g1",
    guildName: "Test Guild",
    channelId: "c1",
    channelName: "general",
    userId: "u1",
    username: "tester",
    displayName: "Tester",
    messageId: "m1",
    content,
    isDM: false,
    mentionsBot: true,
    memberPermissions: ["ADMINISTRATOR"],
  };
}

function makeController(
  llmResponses: string[],
  traces: InteractionTrace[],
  options?: {
    trainingResult?: { conversationId?: string; trainingExampleId?: string };
    learning?: {
      captureInteraction(trace: InteractionTrace, training?: { conversationId?: string; trainingExampleId?: string }): Promise<void>;
    } | null;
    skillRetriever?:
      | {
          retrieve(input: {
            query: string;
            candidateToolNames?: string[];
            specialistRoute?: string;
            specialistExpert?: string;
            topK?: number;
          }): Promise<SkillHint[]>;
        }
      | null;
    parameterActivator?: {
      retrieve(input: {
        query: string;
        candidateToolNames?: string[];
        specialistRoute?: string;
        specialistExpert?: string;
        topK?: number;
      }): Promise<ParameterModuleHint[]>;
    } | null;
    specialistRouter?: SpecialistRouterPort | null;
    behaviorGuardrail?: BehaviorGuardrailPort | null;
    pendingConfirmations?: PendingConfirmationStore;
  },
) {
  const registry = makeRegistry();
  const executor = new ToolExecutor({
    registry,
    permissions: new ToolPermissionService(),
    cooldowns: new ToolCooldownService(),
    logger: testLogger,
    safetyEnabled: true,
  });
  const llm = new MockLLMProvider(llmResponses);
  const controller = new AgentController({
    llm,
    registry,
    executor,
    toolRouterAgent: new ToolRouterAgent(registry, new ToolRouter(registry)),
    skillRetriever: options?.skillRetriever ?? null,
    parameterActivator: options?.parameterActivator ?? null,
    specialistRouter: options?.specialistRouter ?? null,
    safetyAgent: new SafetyAgent(new SafetyService(testLogger, { enabled: true })),
    training: {
      logInteraction: async (trace) => {
        traces.push(trace);
        return options?.trainingResult ?? {};
      },
    },
    learning: options?.learning ?? null,
    behaviorGuardrail: options?.behaviorGuardrail ?? null,
    pendingConfirmations: options?.pendingConfirmations,
    logger: testLogger,
    botName: "TestBot",
    toolCallingEnabled: true,
  });
  return { controller, llm };
}

describe("AgentController", () => {
  const heuristicSpecialistRouter: SpecialistRouterPort = {
    route: ({ prompt }) => routeWithHeuristicSpecialistRouter({ prompt }),
  };

  it("handles plain conversation (fast path) and logs a trace", async () => {
    const traces: InteractionTrace[] = [];
    const { controller, llm } = makeController(
      ['{"type":"message","content":"hey! not much, you?"}'],
      traces,
    );

    const reply = await controller.handleDiscordMessage(makeCtx("hey what's up"));
    expect(reply.content).toBe("hey! not much, you?");

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      userMessage: "hey what's up",
      parseOk: true,
      finalResponse: "hey! not much, you?",
    });
    // Fast path: single LLM call, no tool section for casual chat.
    expect(llm.requests).toHaveLength(1);
  });

  it("uses the behavior guardrail for specific no-tool persona prompts", async () => {
    const traces: InteractionTrace[] = [];
    const { controller, llm } = makeController([], traces, {
      behaviorGuardrail: {
        respond: ({ prompt, likelyNeedsTool }) =>
          respondWithHeuristicBehaviorGuardrail({ prompt, likelyNeedsTool }),
      },
    });

    const reply = await controller.handleDiscordMessage(makeCtx("what pronouns should people use for you?"));

    expect(reply.content).toBe("She/her. Keep it simple.");
    expect(llm.requests).toHaveLength(0);
    expect(traces[0]).toMatchObject({
      parseOk: true,
      finalResponse: "She/her. Keep it simple.",
      model: "heuristic_behavior_responder_v1",
      behaviorGuardrail: {
        model: "heuristic_behavior_responder_v1",
        matchedRule: "persona-pronouns",
      },
      parsedAction: { type: "message", content: "She/her. Keep it simple." },
    });
  });

  it("traces specialist routing for persona prompts without requiring a tool", async () => {
    const traces: InteractionTrace[] = [];
    const { controller, llm } = makeController(
      ['{"type":"message","content":"She/her. Keep it simple."}'],
      traces,
      { specialistRouter: heuristicSpecialistRouter },
    );

    const reply = await controller.handleDiscordMessage(makeCtx("what pronouns should people use for you?"));

    expect(reply.content).toBe("She/her. Keep it simple.");
    expect(llm.requests).toHaveLength(1);
    expect(traces[0]?.specialistRouter).toMatchObject({
      route: "persona",
      expert: "conversation",
      model: "heuristic_specialist_router_v1",
      matchedRule: "persona-identity-style",
    });
    expect(traces[0]?.toolCall).toBeUndefined();
  });

  it("passes specialist route context into learned retrieval ports", async () => {
    const traces: InteractionTrace[] = [];
    const skillInputs: unknown[] = [];
    const parameterInputs: unknown[] = [];
    const { controller } = makeController(
      ['{"type":"message","content":"She/her. Keep it simple."}'],
      traces,
      {
        specialistRouter: heuristicSpecialistRouter,
        skillRetriever: {
          retrieve: async (input) => {
            skillInputs.push(input);
            return [];
          },
        },
        parameterActivator: {
          retrieve: async (input) => {
            parameterInputs.push(input);
            return [];
          },
        },
      },
    );

    await controller.handleDiscordMessage(makeCtx("what pronouns should people use for you?"));

    expect(skillInputs[0]).toMatchObject({
      specialistRoute: "persona",
      specialistExpert: "conversation",
    });
    expect(parameterInputs[0]).toMatchObject({
      specialistRoute: "persona",
      specialistExpert: "conversation",
    });
    expect(traces[0]?.specialistRouter).toMatchObject({ route: "persona" });
  });

  it("does not let the behavior guardrail steal tool requests", async () => {
    const traces: InteractionTrace[] = [];
    const { controller, llm } = makeController(
      [
        '{"type":"tool_call","tool":"ping","arguments":{},"reason":"user asked"}',
        '{"type":"message","content":"pong through the tool path"}',
      ],
      traces,
      {
        behaviorGuardrail: {
          respond: ({ prompt, likelyNeedsTool }) =>
            respondWithHeuristicBehaviorGuardrail({ prompt, likelyNeedsTool }),
        },
      },
    );

    const reply = await controller.handleDiscordMessage(makeCtx("ping please, are you alive?"));

    expect(reply.content).toBe("pong through the tool path");
    expect(llm.requests).toHaveLength(2);
    expect(traces[0]?.behaviorGuardrail).toBeUndefined();
    expect(traces[0]?.toolCall).toMatchObject({ name: "ping" });
  });

  it("executes a tool call end-to-end with a follow-up turn", async () => {
    const traces: InteractionTrace[] = [];
    const { controller, llm } = makeController(
      [
        '{"type":"tool_call","tool":"ping","arguments":{},"reason":"user asked"}',
        '{"type":"message","content":"pong! all systems go"}',
      ],
      traces,
    );

    const reply = await controller.handleDiscordMessage(makeCtx("ping please, are you alive?"));
    expect(reply.content).toBe("pong! all systems go");
    expect(llm.requests).toHaveLength(2);

    const trace = traces[0];
    expect(trace?.toolCall).toMatchObject({ name: "ping" });
    expect(trace?.toolSuccess).toBe(true);
    expect(trace?.candidateToolNames).toContain("ping");
  });

  it("gates high-risk tools behind confirmation, then executes on 'yes'", async () => {
    const traces: InteractionTrace[] = [];
    const { controller } = makeController(
      [
        '{"type":"tool_call","tool":"risky_wipe","arguments":{},"reason":"requested"}',
        '{"type":"message","content":"done — wiped."}',
      ],
      traces,
    );

    const first = await controller.handleDiscordMessage(makeCtx("wipe everything now"));
    expect(first.content).toMatch(/confirm|yes/i);
    expect(first.trace.toolDenied).toBe("confirmation_required");

    const second = await controller.handleDiscordMessage(makeCtx("yes"));
    expect(second.content).toBe("done — wiped.");
    expect(second.trace.toolSuccess).toBe(true);
  });

  it("resolves pending confirmations from a shared confirmation store", async () => {
    const pendingConfirmations = new InMemoryPendingConfirmationStore();
    const firstTraces: InteractionTrace[] = [];
    const secondTraces: InteractionTrace[] = [];
    const first = makeController(
      ['{"type":"tool_call","tool":"risky_wipe","arguments":{},"reason":"requested"}'],
      firstTraces,
      { pendingConfirmations },
    );
    const second = makeController(
      ['{"type":"message","content":"done from shared pending state"}'],
      secondTraces,
      { pendingConfirmations },
    );

    const confirmation = await first.controller.handleDiscordMessage(makeCtx("wipe everything now"));
    expect(confirmation.trace.toolDenied).toBe("confirmation_required");

    const confirmed = await second.controller.handleDiscordMessage(makeCtx("yes"));
    expect(confirmed.content).toBe("done from shared pending state");
    expect(confirmed.trace.toolSuccess).toBe(true);
    expect(confirmed.trace.toolCall).toMatchObject({ name: "risky_wipe" });
  });

  it("traces tool-protocol specialist routing while preserving normal tool gates", async () => {
    const traces: InteractionTrace[] = [];
    const { controller, llm } = makeController(
      [
        '{"type":"tool_call","tool":"ping","arguments":{},"reason":"user asked"}',
        '{"type":"message","content":"pong through the tool path"}',
      ],
      traces,
      { specialistRouter: heuristicSpecialistRouter },
    );

    const reply = await controller.handleDiscordMessage(makeCtx("ping please, are you alive?"));

    expect(reply.content).toBe("pong through the tool path");
    expect(llm.requests).toHaveLength(2);
    expect(traces[0]?.specialistRouter).toMatchObject({
      route: "tool_protocol",
      expert: "tool",
      model: "heuristic_specialist_router_v1",
      matchedRule: "tool-discord-action",
    });
    expect(traces[0]?.toolCall).toMatchObject({ name: "ping" });
    expect(traces[0]?.toolSuccess).toBe(true);
  });

  it("cancels a pending confirmation on 'no'", async () => {
    const traces: InteractionTrace[] = [];
    const { controller } = makeController(
      ['{"type":"tool_call","tool":"risky_wipe","arguments":{}}'],
      traces,
    );
    await controller.handleDiscordMessage(makeCtx("wipe everything"));
    const second = await controller.handleDiscordMessage(makeCtx("no"));
    expect(second.content).toMatch(/cancelled/i);
  });

  it("refuses hallucinated tools without executing anything", async () => {
    const traces: InteractionTrace[] = [];
    const { controller } = makeController(
      ['{"type":"tool_call","tool":"made_up_tool","arguments":{}}'],
      traces,
    );
    const reply = await controller.handleDiscordMessage(makeCtx("do the secret thing"));
    expect(reply.content).toMatch(/can't use/i);
    expect(traces[0]?.toolDenied).toBe("not_in_candidate_set");
    expect(traces[0]?.errors).toContain("tool_not_in_candidate_set: made_up_tool");
  });

  it("captures successful tool traces for live learning after training logging", async () => {
    const traces: InteractionTrace[] = [];
    const captures: Array<{ trace: InteractionTrace; training?: { conversationId?: string; trainingExampleId?: string } }> = [];
    const { controller } = makeController(
      [
        '{"type":"tool_call","tool":"ping","arguments":{},"reason":"user asked"}',
        '{"type":"message","content":"pong"}',
      ],
      traces,
      {
        trainingResult: { conversationId: "conversation-1", trainingExampleId: "training-1" },
        learning: {
          captureInteraction: async (trace, training) => {
            captures.push({ trace, training });
          },
        },
      },
    );

    await controller.handleDiscordMessage(makeCtx("ping please, are you alive?"));

    expect(captures).toHaveLength(1);
    expect(captures[0]?.trace.toolCall).toMatchObject({ name: "ping" });
    expect(captures[0]?.trace.toolSuccess).toBe(true);
    expect(captures[0]?.training).toEqual({ conversationId: "conversation-1", trainingExampleId: "training-1" });
  });

  it("injects approved learned skills into the first model prompt", async () => {
    const traces: InteractionTrace[] = [];
    const { controller, llm } = makeController(
      ['{"type":"tool_call","tool":"ping","arguments":{},"reason":"learned skill says ping fits"}', '{"type":"message","content":"pong"}'],
      traces,
      {
        skillRetriever: {
          retrieve: async (input) => {
            expect(input).toMatchObject({ query: "ping please, are you alive?", candidateToolNames: expect.arrayContaining(["ping"]) });
            return [
              {
                id: "skill-ping",
                content: "Use ping for lightweight health checks.",
                source: "tool_success",
                confidence: 0.9,
                score: 4.9,
                toolName: "ping",
              },
            ];
          },
        },
      },
    );

    await controller.handleDiscordMessage(makeCtx("ping please, are you alive?"));

    const systemMessage = llm.requests[0]?.messages[0]?.content ?? "";
    expect(systemMessage).toContain("Relevant learned skills");
    expect(systemMessage).toContain("Use ping for lightweight health checks.");
    expect(traces[0]?.skillsRetrieved).toEqual([
      {
        id: "skill-ping",
        content: "Use ping for lightweight health checks.",
        source: "tool_success",
        confidence: 0.9,
        score: 4.9,
        toolName: "ping",
      },
    ]);
  });

  it("injects active learned parameter modules into the first model prompt", async () => {
    const traces: InteractionTrace[] = [];
    const moduleHint: ParameterModuleHint = {
      id: "module-tool-expert",
      name: "discord tool-call expert",
      kind: "expert",
      route: "ping",
      parameters: 775_358,
      activeParameters: 775_358,
      score: 4.58,
      sourceLearningItemIds: ["learned-skill-1"],
      sourceSummaries: ["Use ping for lightweight health checks before deeper diagnostics."],
    };
    const { controller, llm } = makeController(
      ['{"type":"tool_call","tool":"ping","arguments":{},"reason":"active module says ping fits"}', '{"type":"message","content":"pong"}'],
      traces,
      {
        parameterActivator: {
          retrieve: async (input) => {
            expect(input).toMatchObject({ query: "ping please, are you alive?", candidateToolNames: expect.arrayContaining(["ping"]) });
            return [moduleHint];
          },
        },
      },
    );

    await controller.handleDiscordMessage(makeCtx("ping please, are you alive?"));

    const systemMessage = llm.requests[0]?.messages[0]?.content ?? "";
    expect(systemMessage).toContain("Active learned parameter modules");
    expect(systemMessage).toContain("discord tool-call expert");
    expect(systemMessage).toContain("Use ping for lightweight health checks");
    expect(traces[0]?.parameterModulesActivated).toEqual([moduleHint]);
  });

  it("degrades to plain message when the model ignores the JSON protocol", async () => {
    const traces: InteractionTrace[] = [];
    const { controller } = makeController(["just plain text, no json at all"], traces);
    const reply = await controller.handleDiscordMessage(makeCtx("hello"));
    expect(reply.content).toBe("just plain text, no json at all");
    expect(traces[0]?.parseOk).toBe(false); // captured as a format-failure example
  });

  it("survives a total LLM outage with a friendly error", async () => {
    const traces: InteractionTrace[] = [];
    const { controller } = makeController([], traces); // empty queue → provider throws
    const reply = await controller.handleDiscordMessage(makeCtx("hello"));
    expect(reply.content).toMatch(/went wrong/i);
    expect(traces[0]?.errors.length).toBeGreaterThan(0);
  });

  it("blocks flagged content at the safety precheck", async () => {
    const traces: InteractionTrace[] = [];
    const { controller, llm } = makeController([], traces);
    const reply = await controller.handleDiscordMessage(
      makeCtx("hey @everyone check this out"),
    );
    expect(reply.content).toMatch(/not going to do that/i);
    expect(llm.requests).toHaveLength(0); // never reached the model
  });
});
