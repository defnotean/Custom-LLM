# Custom LLM Discord Bot Platform

A production-grade foundation for a **local-LLM-powered Discord bot**: structured tool calling designed to scale to 400+ tools, scoped long-term memory (RAG), a safety/moderation layer, and full-fidelity training-data capture for eventually fine-tuning your own open-weight model.

> Built as a foundation, not a finished product. What's real vs. placeholder is documented honestly — see [Status](#status-real-vs-placeholder) and `docs/ARCHITECTURE.md`.

## Features

- **Discord bot** (discord.js v14): mention/DM/reply conversation, `!ai` command set, typing indicators, 2000-char splitting, graceful errors
- **Local LLM first**: any OpenAI-compatible endpoint (Ollama `/v1`, vLLM, LM Studio) + native Ollama, with provider fallback routing
- **Tool system**: Zod-validated args, permission + cooldown + risk/confirmation gates enforced in code, execution logging — 16 starter tools across moderation/utility/memory/discord/example
- **Tool routing**: top-10 candidate retrieval per message (never all tools in the prompt), with deterministic keyword routing or opt-in embedding retrieval
- **Memory**: USER/GUILD/CHANNEL/GLOBAL scopes, policy-gated writes (no secrets, no one-offs), pgvector + Qdrant + in-process stores
- **Live learning ledger**: memory writes, successful tool workflows, and eval failures are captured as learned items; approved skills are retrieved into prompts for immediate reuse
- **Safety**: rate limiting, content screen (placeholder rules), mandatory confirmation for high-risk actions
- **Training capture**: every turn stored with full trace; JSONL export (ChatML / Alpaca / tool-calling / DPO); deterministic synthetic tool examples
- **Ops API** (Fastify): `/health`, `/stats`, `/tools`, `/tools/:name`, `/memory/search`, `/learning/status`, `/learning/items`, `POST /training/export`, `POST /training/feedback/preference`
- **Infra**: Prisma + PostgreSQL, Docker Compose (pgvector/Redis/Qdrant), strict TypeScript, 172 passing tests

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
| `npm run download:datasets` / `npm run prepare:datasets` | Acquire and prepare open SFT datasets with provenance + quality reports |
| `npm run build:sft-mixture` / `npm run build:preference-mixture` | Build production SFT and DPO/preference train/validation mixtures |
| `npm run build:protocol-sft` | Build a contamination-guarded protocol-only scratch SFT set from synthetic tool examples |
| `npm run build:behavior-sft` | Build a held-out-safe persona/social behavior SFT set from project-owned templates |
| `npm run build:router-sft` | Build a separate specialist-router SFT set for MoE-style route/expert gating |
| `npm run analyze:sft-sequences` | Estimate SFT sequence lengths, packed steps, and truncation risk for the QLoRA context budget |
| `npm run build:eval-suite` / `npm run eval:llm` / `npm run eval:predictions` / `npm run eval:gate` | Build held-out protocol/tool evals, collect live model outputs, score prediction JSONL, and enforce promotion gates |
| `npm run eval:tool:tiny` | Run a local scratch Transformer checkpoint against the held-out protocol/tool suite |
| `npm run build:knowledge-eval` / `npm run eval:knowledge:llm` / `npm run eval:knowledge` / `npm run eval:knowledge:gate` | Build held-out knowledge evals, collect live model answers, score reference overlap, and enforce knowledge gates |
| `npm run eval:knowledge:tiny` | Run the promoted local scratch Transformer checkpoint against the held-out knowledge suite |
| `npm run build:behavior-eval` / `npm run eval:behavior:llm` / `npm run eval:behavior:tiny` / `npm run eval:behavior` / `npm run eval:behavior:gate` | Build held-out persona/social-cue evals, collect live or scratch-checkpoint JSON outputs, score behavior requirements, and enforce behavior gates |
| `npm run build:router-eval` / `npm run eval:router:oracle` / `npm run eval:router:tiny` / `npm run eval:router` / `npm run eval:router:gate` | Build and gate held-out specialist routing evals for tool/knowledge/persona/casual/social/boundary routing |
| `npm run check:contamination` | Audit train JSONL against held-out eval suites for exact leakage and high n-gram overlap |
| `npm run train:tiny-transformer` / `npm run train:tiny-char` | Run local from-scratch training smoke baselines, including assistant-loss masking experiments |
| `npm run check:training` | Validate dataset splits, hashes, model artifacts, and training loss movement |
| `npm run report:training-runs` | Rank local training runs and optionally gate a candidate against the best comparable baseline, with attached protocol, knowledge, behavior, and router evidence |
| `npm run check:training-report` | Verify an iteration report is complete for review or strict promotion |
| `npm run check:production-readiness` | Preflight production SFT/DPO datasets, eval reports, and QLoRA configs before GPU training |
| `npm run check:training-configs` | Validate Axolotl/Unsloth production QLoRA config scaffolds and their dataset paths |
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
        → learned-item ledger record for memory/RAG access + future training review
        → skill/eval-failure candidates from tool outcomes + parse/gate failures
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
4. Build the first reproducible dataset/training iteration (`docs/AI_TRAINING_PLAN.md`), pass `npm run check:production-readiness`, then QLoRA-fine-tune the Qwen3 4B Instruct production profile (Unsloth/Axolotl) and evaluate protocol, knowledge, router, and persona/social behavior before shipping.

⚠️ Use only consented data from servers you control — Discord's Developer Policy prohibits training on scraped message content.

## Documentation

| Doc | Contents |
|---|---|
| `docs/ARCHITECTURE.md` | Layers, trust model, decisions log, honest TODO list |
| `docs/PROJECT_SCOPE_AND_ROADMAP.md` | Irene product scope, MoE-style specialist roadmap, current measured status, milestones |
| `docs/LOCAL_LLM_SETUP.md` | Ollama/vLLM/LM Studio setup, models, VRAM guidance |
| `docs/TOOL_REGISTRY.md` | Tool authoring, routing at 400+ tools |
| `docs/TRAINING_DATA.md` | Capture pipeline, export formats, privacy |
| `docs/AI_TRAINING_PLAN.md` | Open dataset acquisition, scratch smoke training, quality gates, scaling path |
| `docs/FINE_TUNING_PLAN.md` | QLoRA plan, frameworks, dataset mixture, metrics |
| `docs/DISCORD_SETUP.md` | App/bot creation, intents, invite, troubleshooting |
| `docs/DEPLOYMENT.md` | Compose deployment, production checklist, scaling path |
| `discord-bot-architecture.md` | Original research document this build follows |

## Status: real vs. placeholder

**Fully working:** boot/degraded modes, Discord conversation + commands, both LLM providers + fallback router, response parsing/repair, tool registry/router/executor with all gates, pgvector + in-process memory stores, memory policy, live-learning ledger capture for memory writes/tool-skill candidates/eval failures, learned-item review/queue ops API, approved-skill prompt retrieval, parameter-growth status accounting, rate limiting, training capture, JSONL export, synthetic generation, protocol/knowledge/behavior/router eval gates, ops API, docker compose, 172 tests.

**Implemented but unverified against live services:** QdrantMemoryStore (REST per docs, no integration test yet).

**Placeholders (interface real, body minimal — all tracked in ARCHITECTURE.md):** content moderation rules, slash commands, memory summarizer worker, per-guild settings enforcement, Redis-backed cooldowns/queue.

## License

Private/unlicensed — set your own before distributing.
