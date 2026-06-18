# Tool Registry Guide

How to add, secure, and route tools. The system is designed for 400+ tools; the discipline below is what makes that scale work.

## Adding a tool

Create it in a category file under `src/tools/categories/` or a new category file using `defineTool`, then ensure the category is registered in `src/tools/index.ts`.

```ts
import { z } from "zod";
import { defineTool, toolOk, toolFail } from "../ToolDefinition";

const remindMe = defineTool({
  // snake_case, unique, specific
  name: "remind_user",
  category: "utility",

  // Written like a search document: the router matches user messages against
  // this text. Include synonyms and use-cases, not just a sentence.
  description:
    "Set a reminder for a user: remind them about something after a delay. " +
    "Use for 'remind me', 'set a timer', 'ping me later'.",

  // Realistic user phrasings, used for routing and synthetic training data.
  examples: ["remind me in 20 minutes to stretch", "set a reminder for the raid at 8pm"],

  riskLevel: "low",            // low | medium | high | critical
  requiresConfirmation: false, // high/critical force confirmation regardless
  requiredDiscordPermissions: [], // UPPER_SNAKE member permissions
  cooldownSeconds: 5,
  timeoutMs: 10_000,           // optional; executor default 15s

  // Zod schema = the only path from model output to typed arguments.
  argsSchema: z.object({
    minutes: z.number().int().min(1).max(1440),
    text: z.string().min(1).max(300),
  }),

  execute: async (args, ctx) => {
    // ctx: guildId, channelId, userId, memberPermissions, message?, db?, memory?, logger
    try {
      return toolOk({ scheduled: true, minutes: args.minutes });
    } catch (err) {
      return toolFail(`Could not schedule: ${String(err)}`);
    }
  },
});
```

Rules every tool must follow:

1. **Zod-validate everything** - the executor refuses calls whose args do not parse; never re-validate manually inside `execute`.
2. **Return the envelope** - `toolOk(jsonData)` / `toolFail(message)`. No raw throws for expected failures.
3. **Self-guard context** - check `ctx.message?.guild`, `ctx.memory`, etc. and `toolFail` cleanly when missing.
4. **No secrets in results** - results go into prompts, logs, and training data.

## Risk Levels And Confirmation

| Risk | Meaning | Examples | Confirmation |
|---|---|---|---|
| `low` | Read-only or trivially reversible | ping, server_info, recall_memory | No |
| `medium` | Writes something visible/recoverable | send_message, warn_user, delete one message | No unless flagged |
| `high` | Affects members or is hard to reverse | timeout_user, role changes, bulk deletes | Yes, always while safety is enabled |
| `critical` | Destructive, external, or irreversible | ban, mass actions, external API writes | Yes, always |

`requiresConfirmation: true` forces confirmation at any risk level. The gate lives in `ToolExecutor.requiresConfirmation`: code, not prompt.

## Permissions And Cooldowns

`requiredDiscordPermissions` lists UPPER_SNAKE member permissions, such as `MODERATE_MEMBERS`. `ToolPermissionService` enforces them before execution; `ADMINISTRATOR` bypasses. The ToolRouter also pre-filters candidates by permission so the model is not offered tools the requester cannot run. The bot's own Discord permissions are a separate concern; handle failures in `execute`.

`cooldownSeconds` is per-user-per-tool through `ToolCooldownService`, currently backed by an in-memory store. Redis is the multi-process upgrade path.

## Routing: Why We Never Prompt All 400 Tools

Tool-selection accuracy collapses when models see more than roughly 30-50 tool schemas at once, and 400 schemas would burn thousands of prompt tokens per message. So:

1. `ToolRouter` retrieves the top ~10 candidates per message.
2. Only those candidates are rendered into the prompt; `getToolDescriptionsForPrompt` takes a subset by design.
3. If the router says `likelyNeedsTool: false`, the prompt has no tool section, which keeps casual chat fast.
4. A hallucinated or off-list tool name fails validation and is refused, then logged as training signal.

The retrieval strategy is pluggable through `ToolRetrievalStrategy`:

- `TOOL_ROUTER_STRATEGY=keyword` is the deterministic default and needs no model server.
- `TOOL_ROUTER_STRATEGY=embedding` embeds one search document per tool, embeds each user request, ranks by cosine similarity, blends in keyword score, and falls back to keyword routing if the embedding provider fails.
- With `EMBEDDING_PROVIDER=hashing`, embedding routing is still lexical and intended only for tests/offline development. Use a real embedding model for semantic recall at 400+ tools.

Your investment that survives every strategy: rich descriptions, good examples, and accurate categories.

## Tool Metadata And Ops

- `registry.exportToolMetadata()` powers `GET /tools`, `!ai tools`, and `npm run seed:tools`. The in-code registry stays the execution source of truth.
- Every execution, denial, and failure is logged to `ToolLog` with input/output JSON and latency: your per-tool success-rate data for routing improvements and circuit-breaking later.
- Synthetic training examples per tool come from `npm run generate:examples`, using examples plus the Zod schema.

## Scaling Checklist Toward 400+

- Keep categories meaningful; namespacing by category is the first narrowing layer.
- Write descriptions/examples as if they are the only thing a search engine sees.
- Watch `ToolLog` success rates; disable (`enabled: false`) tools that misbehave.
- When keyword routing starts missing, set `TOOL_ROUTER_STRATEGY=embedding`, use a real embedding model, and compare protocol eval metrics before promoting it.
