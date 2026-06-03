# Tool Registry Guide

How to add, secure, and route tools. The system is designed for 400+ tools; the discipline below is what makes that scale work.

## Adding a tool

Create it in a category file under `src/tools/categories/` (or a new category file) using `defineTool`, then ensure the category is registered in `src/tools/index.ts`.

```ts
import { z } from "zod";
import { defineTool, toolOk, toolFail } from "../ToolDefinition";

const remindMe = defineTool({
  // snake_case, unique, specific
  name: "remind_user",
  category: "utility",

  // Written like a SEARCH DOCUMENT: the router matches user messages against
  // this text. Include synonyms and use-cases, not just a sentence.
  description:
    "Set a reminder for a user: remind them about something after a delay. " +
    "Use for 'remind me', 'set a timer', 'ping me later'.",

  // Realistic user phrasings — used for routing AND synthetic training data.
  examples: ["remind me in 20 minutes to stretch", "set a reminder for the raid at 8pm"],

  riskLevel: "low",            // low | medium | high | critical
  requiresConfirmation: false, // high/critical force confirmation regardless
  requiredDiscordPermissions: [], // UPPER_SNAKE member permissions
  cooldownSeconds: 5,
  timeoutMs: 10_000,           // optional; executor default 15s

  // Zod schema = the ONLY path from model output to typed arguments.
  argsSchema: z.object({
    minutes: z.number().int().min(1).max(1440),
    text: z.string().min(1).max(300),
  }),

  execute: async (args, ctx) => {
    // ctx: guildId, channelId, userId, memberPermissions, message?, db?, memory?, logger
    try {
      // ... do the thing ...
      return toolOk({ scheduled: true, minutes: args.minutes });
    } catch (err) {
      return toolFail(`Could not schedule: ${String(err)}`);
    }
  },
});
```

Rules every tool must follow:

1. **Zod-validate everything** — the executor refuses calls whose args don't parse; never re-validate manually inside `execute`.
2. **Return the envelope** — `toolOk(jsonData)` / `toolFail(message)`. No raw throws for expected failures (throws become `toolFail` automatically, but explicit is better).
3. **Self-guard context** — check `ctx.message?.guild`, `ctx.memory`, etc. and `toolFail` cleanly when missing.
4. **No secrets in results** — results go into prompts, logs, and training data.

## Risk levels & confirmation

| Risk | Meaning | Examples | Confirmation |
|---|---|---|---|
| `low` | Read-only / trivially reversible | ping, server_info, recall_memory | No |
| `medium` | Writes something visible/recoverable | send_message, warn_user, delete one message | No (unless flagged) |
| `high` | Affects members or is hard to reverse | timeout_user, role changes, bulk deletes | **Yes, always** (while safety enabled) |
| `critical` | Destructive / external / irreversible | ban, mass actions, external API writes | **Yes, always** |

`requiresConfirmation: true` forces confirmation at any risk level. The gate lives in `ToolExecutor.requiresConfirmation` — code, not prompt.

## Permissions & cooldowns

`requiredDiscordPermissions` lists UPPER_SNAKE **member** permissions (e.g. `MODERATE_MEMBERS`). Enforced by `ToolPermissionService` before execution; `ADMINISTRATOR` bypasses. The ToolRouter also pre-filters candidates by permission so the model isn't offered tools the requester can't run. Note: the bot's *own* Discord permissions are a separate concern — handle failures in `execute` (discord.js throws).

`cooldownSeconds` is per-user-per-tool (`ToolCooldownService`, in-memory store; Redis store is the multi-process upgrade path).

## Routing — why we never prompt all 400 tools

Tool-selection accuracy collapses when models see more than ~30–50 tool schemas at once, and 400 schemas would burn thousands of prompt tokens per message. So:

1. `ToolRouter` retrieves the **top ~10 candidates** per message (keyword/category/example scoring + permission filter).
2. Only those candidates are rendered into the prompt (`getToolDescriptionsForPrompt` takes a subset by design).
3. If the router says `likelyNeedsTool: false`, the prompt has **no tool section** — the casual-chat fast path.
4. A hallucinated or off-list tool name fails validation and is refused (and logged as training signal).

The retrieval strategy is pluggable (`ToolRetrievalStrategy`): the planned embedding retriever (embed descriptions+examples → ANN search per message → optional rerank) replaces keyword scoring without touching the agent layer. Your investment that survives that upgrade: **rich descriptions, good examples, accurate categories.**

## Tool metadata & ops

- `registry.exportToolMetadata()` powers `GET /tools`, `!ai tools`, and `npm run seed:tools` (syncs `ToolDefinitionRecord` rows for ops/dashboards; the in-code registry stays the execution source of truth).
- Every execution (success, failure, denial) is logged to `ToolLog` with input/output JSON and latency — your per-tool success-rate data for routing improvements and circuit-breaking later.
- Synthetic training examples per tool come from `npm run generate:examples` (uses `examples` + the Zod schema).

## Scaling checklist (toward 400+)

- Namespacing by category is the Stage-A narrowing layer — keep categories meaningful.
- Write descriptions/examples as if they're the only thing a search engine sees.
- Watch `ToolLog` success rates; disable (enabled: false) tools that misbehave.
- When keyword routing starts missing, implement the embedding strategy — the seam is ready.
