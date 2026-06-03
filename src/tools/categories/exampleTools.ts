import { z } from "zod";
import type { RegisteredTool } from "../ToolDefinition";
import { defineTool, toolOk } from "../ToolDefinition";

/**
 * example — reference implementations for tool authors. Copy one of these as
 * a starting point; the full guide lives in docs/TOOL_REGISTRY.md.
 *
 * Anatomy of a good tool:
 *  - name: snake_case, specific ("echo", not "do_thing")
 *  - description: written like a search document — the ToolRouter matches
 *    user messages against it, so include synonyms and use-cases
 *  - examples: realistic user phrasings (also used for routing + synthetic
 *    training data generation)
 *  - argsSchema: Zod schema; the executor validates before execution
 *  - riskLevel/requiresConfirmation/requiredDiscordPermissions/cooldownSeconds:
 *    enforcement metadata, checked in code (never trusted to the model)
 *  - execute: returns toolOk(jsonData) or toolFail(errorMessage)
 */

const echo = defineTool({
  name: "echo",
  category: "example",
  description: "Echo the provided text back. A reference example tool for developers.",
  examples: ["echo hello world", "repeat after me: test"],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 1,
  argsSchema: z.object({
    text: z.string().min(1).max(500),
  }),
  execute: async (args) => toolOk({ echoed: args.text }),
});

const addNumbers = defineTool({
  name: "add_numbers",
  category: "example",
  description: "Add two numbers together. A reference example tool showing numeric arguments.",
  examples: ["add 2 and 3", "what is 41 + 1 using the tool"],
  riskLevel: "low",
  requiresConfirmation: false,
  cooldownSeconds: 1,
  argsSchema: z.object({
    a: z.number(),
    b: z.number(),
  }),
  execute: async (args) => toolOk({ sum: args.a + args.b }),
});

export const exampleTools: RegisteredTool[] = [echo, addNumbers];
