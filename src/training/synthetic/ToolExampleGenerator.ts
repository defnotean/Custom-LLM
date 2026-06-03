import type { RegisteredTool } from "../../tools/ToolDefinition";
import type { ToolRegistry } from "../../tools/ToolRegistry";
import { describeArgsSchema, sampleFromSchema } from "../../tools/schemaIntrospect";
import { SYSTEM_PROMPT_VERSION } from "../../ai/prompts/systemPrompt";
import type { JsonObject, JsonValue } from "../../types/common";

/**
 * Deterministic synthetic training-example generation from the live tool
 * registry. No external APIs, no randomness — templates only. These examples
 * teach the *format* (valid JSON, correct schemas, refusal/clarification
 * shapes); they are scaffolding until real logged interactions accumulate.
 * Mark of honesty: every example is tagged source=SYNTHETIC so dataset
 * builds can cap their share of the mixture (see docs/FINE_TUNING_PLAN.md).
 */

export interface SyntheticExample {
  source: "SYNTHETIC";
  format: "CHATML" | "TOOL_CALLING_JSONL";
  inputJson: JsonObject;
  outputJson: JsonObject;
  qualityScore: number;
  metadataJson: JsonObject;
}

const SYNTHETIC_SYSTEM_PROMPT =
  `[synthetic:${SYSTEM_PROMPT_VERSION}] You are a Discord assistant with tool access. ` +
  `Respond ONLY as JSON using one of: message / tool_call / confirmation_request / clarification.`;

export class ToolExampleGenerator {
  constructor(private readonly registry: ToolRegistry) {}

  generateAll(): SyntheticExample[] {
    const out: SyntheticExample[] = [];
    for (const tool of this.registry.listTools()) {
      out.push(...this.generateForTool(tool));
    }
    out.push(...this.noToolExamples());
    return out;
  }

  generateForTool(tool: RegisteredTool): SyntheticExample[] {
    const examples: SyntheticExample[] = [];
    const sampleArgs = (sampleFromSchema(tool.argsSchema) ?? {}) as JsonObject;
    const argKeys = Object.keys(describeArgsSchema(tool.argsSchema));
    const userPhrase = tool.examples?.[0] ?? `use the ${tool.name} tool`;
    const casualPhrase = tool.examples?.[1] ?? `hey can you ${tool.name.replace(/_/g, " ")} for me`;

    // 1. Direct request → successful call.
    examples.push(
      this.toolCallExample(tool, userPhrase, sampleArgs, { ok: true, data: { note: "synthetic success" } },
        `Done — ${tool.name.replace(/_/g, " ")} completed.`, "direct_success"),
    );

    // 2. Casual phrasing → successful call.
    examples.push(
      this.toolCallExample(tool, casualPhrase, sampleArgs, { ok: true, data: { note: "synthetic success" } },
        `On it. ${tool.name.replace(/_/g, " ")} done.`, "casual_success"),
    );

    // 3. Failed call → honest failure reporting.
    examples.push(
      this.toolCallExample(tool, userPhrase, sampleArgs,
        { ok: false, error: "synthetic failure: upstream returned an error" },
        `That didn't work — ${tool.name.replace(/_/g, " ")} failed (upstream error). Want me to try again?`,
        "failure"),
    );

    // 4. Missing required argument → clarification, not a guessed call.
    if (argKeys.length > 0) {
      examples.push(this.chatExample(
        `${tool.name.replace(/_/g, " ")} please`,
        JSON.stringify({
          type: "clarification",
          content: `Sure — I need ${argKeys[0]} to run ${tool.name}. What should it be?`,
        }),
        "missing_argument", tool.name,
      ));
    }

    // 5. Permission denied → polite refusal.
    if (tool.requiredDiscordPermissions && tool.requiredDiscordPermissions.length > 0) {
      examples.push(this.chatExample(
        userPhrase,
        JSON.stringify({
          type: "message",
          content: `You need the ${tool.requiredDiscordPermissions.join(", ")} permission for that, so I can't run it for you.`,
        }),
        "permission_denied", tool.name,
      ));
    }

    // 6. Confirmation-gated tools → confirmation_request shape.
    if (tool.requiresConfirmation) {
      examples.push(this.chatExample(
        userPhrase,
        JSON.stringify({
          type: "confirmation_request",
          content: `This will run ${tool.name} (${tool.riskLevel} risk). Confirm?`,
          pending_tool_call: { tool: tool.name, arguments: sampleArgs },
        }),
        "confirmation_request", tool.name,
      ));
    }

    // 7. DPO pair: chosen = valid call; rejected = hallucinated tool name.
    examples.push({
      source: "SYNTHETIC",
      format: "TOOL_CALLING_JSONL",
      inputJson: { systemPrompt: SYNTHETIC_SYSTEM_PROMPT, userMessage: userPhrase },
      outputJson: {
        finalResponse: "",
        parseOk: true,
        toolCall: null,
        dpo: {
          prompt: userPhrase,
          chosen: JSON.stringify({ type: "tool_call", tool: tool.name, arguments: sampleArgs }),
          rejected: JSON.stringify({
            type: "tool_call",
            tool: `${tool.name}_v2_real`,
            arguments: { anything: true },
          }),
        },
      },
      qualityScore: 0.6,
      metadataJson: { kind: "dpo_pair", tool: tool.name },
    });

    return examples;
  }

  /** No-tool cases: casual chat must NOT trigger tool calls. */
  private noToolExamples(): SyntheticExample[] {
    const cases: Array<[string, string]> = [
      ["lol that was wild", "haha right? what a moment"],
      ["good morning everyone", "morning! hope it's a good one"],
      ["what do you think about pineapple pizza", "controversial but honestly? it slaps. fight me"],
    ];
    return cases.map(([user, reply]) =>
      this.chatExample(user, JSON.stringify({ type: "message", content: reply }), "no_tool", null),
    );
  }

  private toolCallExample(
    tool: RegisteredTool,
    userMessage: string,
    args: JsonObject,
    result: JsonValue,
    finalResponse: string,
    kind: string,
  ): SyntheticExample {
    return {
      source: "SYNTHETIC",
      format: "TOOL_CALLING_JSONL",
      inputJson: {
        systemPrompt: SYNTHETIC_SYSTEM_PROMPT,
        userMessage,
        candidateTools: [tool.name],
        likelyNeedsTool: true,
      },
      outputJson: {
        parseOk: true,
        toolCall: { name: tool.name, arguments: args, reason: kind },
        toolResult: result,
        toolSuccess: typeof result === "object" && result !== null && "ok" in result
          ? Boolean((result as { ok?: unknown }).ok)
          : true,
        finalResponse,
      },
      qualityScore: 0.6,
      metadataJson: { kind, tool: tool.name },
    };
  }

  private chatExample(
    userMessage: string,
    assistantJson: string,
    kind: string,
    tool: string | null,
  ): SyntheticExample {
    return {
      source: "SYNTHETIC",
      format: "CHATML",
      inputJson: {
        systemPrompt: SYNTHETIC_SYSTEM_PROMPT,
        userMessage,
        candidateTools: tool ? [tool] : [],
        likelyNeedsTool: tool !== null,
      },
      outputJson: {
        parseOk: true,
        toolCall: null,
        finalResponse: assistantJson,
      },
      qualityScore: 0.55,
      metadataJson: { kind, ...(tool ? { tool } : {}) },
    };
  }
}
