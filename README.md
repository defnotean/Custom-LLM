# Custom LLM Discord Bot Platform

A production-grade foundation for a **local-LLM-powered Discord bot**: structured tool calling designed to scale to 400+ tools, scoped long-term memory (RAG), a safety/moderation layer, and full-fidelity training-data capture for eventually fine-tuning your own open-weight model.

> Built as a foundation, not a finished product. What's real vs. placeholder is documented honestly — see [Status](#status-real-vs-placeholder) and `docs/ARCHITECTURE.md`.

## Features

- **Discord bot** (discord.js v14): mention/DM/reply conversation, `!ai` command set, typing indicators, 2000-char splitting, graceful errors
- **Local LLM first**: any OpenAI-compatible endpoint (Ollama `/v1`, vLLM, LM Studio) + native Ollama, with provider fallback routing
- **Tool system**: Zod-validated args, permission + cooldown + risk/confirmation gates enforced in code, execution logging — 16 starter tools across moderation/utility/memory/discord/example
- **Tool routing**: top-10 candidate retrieval per message (never all tools in the prompt), embedding-strategy-ready
- **Memory**: USER/GUILD/CHANNEL/GLOBAL scopes, policy-gated writes (no secrets, no one-offs), pgvector + Qdrant + in-process stores
- **Safety**: rate limiting, content screen (placeholder rules), mandatory confirmation for high-risk actions
- **Training capture**: every turn stored with full trace; JSONL export (ChatML / Alpaca / tool-calling / DPO); deterministic synthetic tool examples
- **Ops API** (Fastify): `/health`, `/stats`, `/tools`, `/tools/:name`, `/memory/search`, `POST /training/export`
- **Infra**: Prisma + PostgreSQL, Docker Compose (pgvector/Redis/Qdrant), strict TypeScript, 63 passing tests

## Quickstart

Prereqs: Node 20+, Docker, ~10 GB disk for a 7B model.

```bash
# 1. Infrastructure (Postgres+pgvector, Redis, Qdrant)
docker compose up -d

# 2. Local LLM (Ollama shown; vLLM/LM Studio also supported — docs/LOCAL_LLM_SETUP.md)
ollama pull qwen2.5:7b-instruct
ollama pull nomic-embed-text

# 3. Configure
cp .env.example .env       # set DISCORD_TOKEN (docs/DISCORD_SETUP.md); defaults fit the compose setup

# 4. Install + database
npm install
npx prisma migrate deploy

# 5. Verify the LLM endpoint
npm run test-llm           # expects: "✔ chat completion ok — pong"

# 6. Run
npm run dev
```

Then in Discord: `!ai ping`, `!ai help`, or just @mention the bot. Without a `DISCORD_TOKEN` the app runs in API-only mode; without a database it runs with persistence disabled (loud warnings, no crashes).

## Commands

| Command | What it does |
|---|---|
| `!ai ping` | Run the ping tool end-to-end |
| `!ai tools` / `!ai tool <name>` | Browse the tool registry |
| `!ai memory recall <query>` / `!ai memory remember <text>` | Long-term memory |
| `!ai export-training` | Export training JSONL (admin) |
| `!ai stats` / `!ai health` / `!ai help` | Ops info |

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` / `npm start` / `npm run build` | Run (watch) / run compiled / compile |
| `npm run typecheck` / `npm test` | Strict TS check / Vitest suite |
| `npm run test-llm` | Smoke-test the configured LLM + embedding endpoints |
| `npm run export:training` | Write `exports/training/*.jsonl` from logged interactions |
| `npm run generate:examples` | Deterministic synthetic tool examples (JSONL + DB) |
| `npm run seed:tools` | Sync registry metadata into `ToolDefinitionRecord` |
| `npm run prisma:migrate` | Apply migrations |

## How a message flows

```
message → context → safety precheck → memory retrieval (top 5)
        → tool candidates (top 10, permission-filtered) → prompt → LLM
        → JSON parse (repair + Zod) → gates: args/permission/cooldown/confirmation
        → execute → follow-up LLM turn → reply
        → conversation + training trace logged → policy-gated memory write
```

Key invariant: **the model's output is never executed directly** — every tool call passes code-level validation, permission, cooldown, and risk gates. Casual chat skips the tool/memory machinery for speed. Full detail: `docs/ARCHITECTURE.md`.

## Adding a tool (30 seconds)

```ts
// src/tools/categories/utilityTools.ts
const coinFlip = defineTool({
  name: "coin_flip",
  category: "utility",
  description: "Flip a coin: returns heads or tails. Use for coin toss, 50/50 decisions.",
  examples: ["flip a coin", "heads or tails?"],
  riskLevel: "low",
  requiresConfirmation: false,
  argsSchema: z.object({}),
  execute: async () => toolOk({ result: Math.random() < 0.5 ? "heads" : "tails" }),
});
// add to the exported array — registered, routed, documented, and
// synthetic-example-covered automatically.
```

Full guide (risk levels, permissions, cooldowns, routing): `docs/TOOL_REGISTRY.md`.

## Training data → your own model

1. Run the bot; every interaction is captured (`docs/TRAINING_DATA.md`).
2. `npm run export:training` → ChatML / Alpaca / tool-calling / DPO JSONL.
3. Review + redact + hold out an eval set.
4. QLoRA-fine-tune a 7–14B open-weight model (Unsloth/Axolotl) and evaluate tool-call accuracy before shipping — the full plan is `docs/FINE_TUNING_PLAN.md`.

⚠️ Use only consented data from servers you control — Discord's Developer Policy prohibits training on scraped message content.

## Documentation

| Doc | Contents |
|---|---|
| `docs/ARCHITECTURE.md` | Layers, trust model, decisions log, honest TODO list |
| `docs/LOCAL_LLM_SETUP.md` | Ollama/vLLM/LM Studio setup, models, VRAM guidance |
| `docs/TOOL_REGISTRY.md` | Tool authoring, routing at 400+ tools |
| `docs/TRAINING_DATA.md` | Capture pipeline, export formats, privacy |
| `docs/FINE_TUNING_PLAN.md` | QLoRA plan, frameworks, dataset mixture, metrics |
| `docs/DISCORD_SETUP.md` | App/bot creation, intents, invite, troubleshooting |
| `docs/DEPLOYMENT.md` | Compose deployment, production checklist, scaling path |
| `discord-bot-architecture.md` | Original research document this build follows |

## Status: real vs. placeholder

**Fully working:** boot/degraded modes, Discord conversation + commands, both LLM providers + fallback router, response parsing/repair, tool registry/router/executor with all gates, pgvector + in-process memory stores, memory policy, rate limiting, training capture, JSONL export, synthetic generation, ops API, docker compose, 63 tests.

**Implemented but unverified against live services:** QdrantMemoryStore (REST per docs, no integration test yet).

**Placeholders (interface real, body minimal — all tracked in ARCHITECTURE.md):** content moderation rules, slash commands, memory summarizer worker, embedding-based tool routing, per-guild settings enforcement, Redis-backed cooldowns/queue.

## License

Private/unlicensed — set your own before distributing.
