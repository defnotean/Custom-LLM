import type { RegisteredTool } from "../../tools/ToolDefinition";
import type { ToolRegistry } from "../../tools/ToolRegistry";
import { requiredArgKeys, sampleFromSchema } from "../../tools/schemaIntrospect";
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
    const argKeys = requiredArgKeys(tool.argsSchema);
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

    // 3. Argument-explicit direct request -> successful call.
    examples.push(
      this.toolCallExample(tool, `run exact tool ${tool.name}`, sampleArgs,
        { ok: true, data: { note: "synthetic success" } },
        `Done — ${tool.name.replace(/_/g, " ")} completed.`, "direct_exact_tool_name"),
    );

    if (argKeys.length > 0) {
      const argsText = argumentPromptText(sampleArgs, argKeys);
      if (argsText) {
        examples.push(
          this.toolCallExample(tool, `run ${tool.name.replace(/_/g, " ")} with ${argsText}`, sampleArgs,
            { ok: true, data: { note: "synthetic success" } },
            `Done — ${tool.name.replace(/_/g, " ")} completed.`, "direct_with_args", sampleArgs),
        );
      }
    }

    for (const phrase of directHardCases(tool)) {
      examples.push(
        this.toolCallExample(tool, phrase, sampleArgs, { ok: true, data: { note: "synthetic success" } },
          `Done — ${tool.name.replace(/_/g, " ")} completed.`, "direct_hard_case"),
      );
    }

    // 4. Failed call → honest failure reporting.
    examples.push(
      this.toolCallExample(tool, userPhrase, sampleArgs,
        { ok: false, error: "synthetic failure: upstream returned an error" },
        `That didn't work — ${tool.name.replace(/_/g, " ")} failed (upstream error). Want me to try again?`,
        "failure"),
    );

    // 5. Missing required argument → clarification, not a guessed call.
    if (argKeys.length > 0) {
      const missingArg = argKeys[0];
      if (!missingArg) return examples;
      const clarificationJson = JSON.stringify({
        type: "clarification",
        content: `Sure — I need ${missingArg} to run ${tool.name}. What should it be?`,
      });
      examples.push(this.chatExample(
        `${tool.name.replace(/_/g, " ")} please`,
        clarificationJson,
        "missing_argument", tool.name,
        { missingArg },
      ));
      for (const phrase of missingArgumentHardCases(tool)) {
        examples.push(this.chatExample(
          phrase,
          clarificationJson,
          "missing_argument_hard_case", tool.name,
          { missingArg },
        ));
      }
    }

    // 6. Permission denied → polite refusal.
    if (tool.requiredDiscordPermissions && tool.requiredDiscordPermissions.length > 0) {
      const denialJson = JSON.stringify({
        type: "message",
        content: `You need the ${tool.requiredDiscordPermissions.join(", ")} permission for that, so I can't run it for you.`,
      });
      examples.push(this.chatExample(
        userPhrase,
        denialJson,
        "permission_denied", tool.name,
      ));
      const argsText = argumentPromptText(sampleArgs, argKeys);
      if (argsText) {
        examples.push(this.chatExample(
          `attempt ${tool.name.replace(/_/g, " ")} using ${argsText}`,
          denialJson,
          "permission_denied_with_args", tool.name,
          { providedArgs: sampleArgs },
        ));
        for (const phrase of permissionDeniedWithArgCases(tool, argsText)) {
          examples.push(this.chatExample(
            phrase,
            denialJson,
            "permission_denied_with_args_hard_case", tool.name,
            { providedArgs: sampleArgs },
          ));
        }
      }
      for (const phrase of permissionDeniedHardCases(tool)) {
        examples.push(this.chatExample(phrase, denialJson, "permission_denied_hard_case", tool.name));
      }
    }

    // 7. Confirmation-gated tools → confirmation_request shape.
    if (tool.requiresConfirmation) {
      const confirmationJson = JSON.stringify({
        type: "confirmation_request",
        content: `This will run ${tool.name} (${tool.riskLevel} risk). Confirm?`,
        pending_tool_call: { tool: tool.name, arguments: sampleArgs },
      });
      examples.push(this.chatExample(
        userPhrase,
        confirmationJson,
        "confirmation_request", tool.name,
      ));
      const argsText = argumentPromptText(sampleArgs, argKeys);
      if (argsText) {
        examples.push(this.chatExample(
          `prepare ${tool.name.replace(/_/g, " ")} using ${argsText}`,
          confirmationJson,
          "confirmation_request_with_args", tool.name,
          { providedArgs: sampleArgs },
        ));
        for (const phrase of confirmationWithArgCases(tool, argsText)) {
          examples.push(this.chatExample(
            phrase,
            confirmationJson,
            "confirmation_request_with_args_hard_case", tool.name,
            { providedArgs: sampleArgs },
          ));
        }
      }
      for (const phrase of confirmationHardCases(tool)) {
        examples.push(this.chatExample(phrase, confirmationJson, "confirmation_request_hard_case", tool.name));
      }
    }

    // 8. DPO pair: chosen = valid call; rejected = hallucinated tool name.
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
      metadataJson: this.metadata("dpo_pair", tool),
    });

    return examples;
  }

  /** No-tool cases: casual chat must NOT trigger tool calls. */
  private noToolExamples(): SyntheticExample[] {
    const cases: Array<[string, string]> = [
      ["lol that was wild", "haha right? what a moment"],
      ["good morning everyone", "morning! hope it's a good one"],
      ["what do you think about pineapple pizza", "controversial but honestly? it slaps. fight me"],
      ["that was a wild moment", "yeah, that got intense fast"],
      ["is pineapple pizza actually good", "depends who you ask, but I respect the debate"],
      ["thanks for the help", "anytime"],
      ["how are you doing today", "doing fine and ready to help"],
      ["quick thought: meetings are too long", "hard to argue with that"],
      ["no command here, just chatting", "got it, just chatting"],
      ["what's your favorite color", "probably green today"],
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
    providedArgs?: JsonObject,
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
      metadataJson: this.metadata(kind, tool, providedArgs),
    };
  }

  private chatExample(
    userMessage: string,
    assistantJson: string,
    kind: string,
    tool: string | null,
    metadataPatch: JsonObject = {},
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
      metadataJson: tool ? { ...this.metadata(kind, this.registry.getTool(tool) ?? null), ...metadataPatch } : { kind, ...metadataPatch },
    };
  }

  private metadata(kind: string, tool: RegisteredTool | null, providedArgs?: JsonObject): JsonObject {
    if (!tool) return { kind };
    const metadata: JsonObject = {
      kind,
      tool: tool.name,
      requiresConfirmation: tool.requiresConfirmation,
      requiredPermissions: tool.requiredDiscordPermissions ?? [],
      requiredArgs: requiredArgKeys(tool.argsSchema),
    };
    if (providedArgs && Object.keys(providedArgs).length > 0) metadata.providedArgs = providedArgs;
    return metadata;
  }
}

function argumentPromptText(args: JsonObject, keys: string[]): string {
  return keys
    .filter((key) => Object.prototype.hasOwnProperty.call(args, key))
    .map((key) => `${key}=${formatPromptValue(args[key])}`)
    .join(", ");
}

function formatPromptValue(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  return JSON.stringify(value);
}

function directHardCases(tool: RegisteredTool): string[] {
  const extras = tool.examples?.slice(2) ?? [];
  const byTool: Record<string, string[]> = {
    add_numbers: ["add 4 and 7", "sum 8 plus 2"],
    current_time: ["what time is it right now", "tell me the current time"],
    delete_message: ["remove that message from chat", "delete message 987654321"],
    echo: ["echo test message", "repeat this sentence"],
    forget_memory: ["forget memory abc123", "delete that saved memory"],
    get_user_info: ["look up @member", "when did @member join"],
    recall_memory: ["search my memories for project notes", "what do you remember about my preferences"],
    remember_fact: ["remember my favorite color is green", "store that my timezone is CST"],
    send_message: ["post hello in #general", "send this update to announcements"],
    summarize_channel_recent_messages: ["summarize recent messages", "catch me up on chat"],
    timeout_user: ["timeout @member for 5 minutes", "give them a 30 minute timeout for spam"],
    warn_user: ["warn @member for spam", "give @member a warning"],
  };
  return [...new Set([...extras, ...(byTool[tool.name] ?? [])])];
}

function missingArgumentHardCases(tool: RegisteredTool): string[] {
  const byTool: Record<string, string[]> = {
    add_numbers: ["add some numbers for me", "sum a couple numbers"],
    delete_message: ["delete a message", "remove a chat message"],
    echo: ["echo something for me", "repeat something back"],
    forget_memory: ["forget a memory", "delete a saved memory"],
    get_user_info: ["look up a user", "get info about someone"],
    recall_memory: ["search memory", "recall something from memory"],
    remember_fact: ["remember something for me", "store a new fact"],
    send_message: ["send a message", "post an update"],
    timeout_user: ["timeout someone", "mute a user"],
    warn_user: ["warn someone", "give a warning"],
  };
  return byTool[tool.name] ?? [];
}

function permissionDeniedHardCases(tool: RegisteredTool): string[] {
  const byTool: Record<string, string[]> = {
    delete_message: ["remove that message from chat", "delete message 987654321"],
    send_message: ["post hello in #general", "send this update to announcements"],
    summarize_channel_recent_messages: ["summarize recent messages", "catch me up on chat"],
    timeout_user: ["timeout @member for 5 minutes", "mute @member for spam"],
    warn_user: ["warn @member for spam", "give @member a warning"],
  };
  return byTool[tool.name] ?? [];
}

function permissionDeniedWithArgCases(tool: RegisteredTool, argsText: string): string[] {
  const toolWords = tool.name.replace(/_/g, " ");
  const byTool: Record<string, string[]> = {
    delete_message: [`try to execute ${toolWords} with ${argsText}`, `please do ${toolWords} using ${argsText}`],
    send_message: [`try to execute ${toolWords} with ${argsText}`, `please do ${toolWords} using ${argsText}`],
    summarize_channel_recent_messages: [`try to execute ${toolWords} with ${argsText}`],
    timeout_user: [`try to execute ${toolWords} with ${argsText}`, `attempt moderation ${toolWords} using ${argsText}`],
    warn_user: [`try to execute ${toolWords} with ${argsText}`, `attempt moderation ${toolWords} using ${argsText}`],
  };
  return byTool[tool.name] ?? [];
}

function confirmationHardCases(tool: RegisteredTool): string[] {
  const byTool: Record<string, string[]> = {
    timeout_user: ["timeout @member for 5 minutes", "mute @member for spam", "give @member a 30 minute timeout"],
  };
  return byTool[tool.name] ?? [];
}

function confirmationWithArgCases(tool: RegisteredTool, argsText: string): string[] {
  const toolWords = tool.name.replace(/_/g, " ");
  const byTool: Record<string, string[]> = {
    timeout_user: [
      `ask for confirmation before ${toolWords} using ${argsText}`,
      `prepare risky ${toolWords} with ${argsText}`,
      `start ${toolWords} with ${argsText} after I confirm`,
    ],
  };
  return byTool[tool.name] ?? [];
}
