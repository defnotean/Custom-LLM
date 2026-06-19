# Custom LLM Discord Bot Platform

A production-grade foundation for a **local-LLM-powered Discord bot**: structured tool calling designed to scale to 400+ tools, scoped long-term memory (RAG), a safety/moderation layer, and full-fidelity training-data capture for eventually fine-tuning your own open-weight model.

> Built as a foundation, not a finished product. What's real vs. placeholder is documented honestly — see [Status](#status-real-vs-placeholder) and `docs/ARCHITECTURE.md`.

## Features

- **Discord bot** (discord.js v14): mention/DM/reply conversation, `!ai` command set, configurable Irene presence, opt-in voice join/leave plus speech queue commands, typing indicators, 2000-char splitting, graceful errors
- **Local LLM first + strict SubQ/SSA long context**: any OpenAI-compatible endpoint (Ollama `/v1`, vLLM, LM Studio, SubQ private API) + native Ollama, with normal provider fallback; long-context scaling requires the named SubQ/subquadratic sparse-attention path unless dense fallback is explicitly enabled for development
- **Tool system**: Zod-validated args, per-guild disabled-tool policy, permission + cooldown + risk/confirmation gates enforced in code, execution logging — 16 starter tools across moderation/utility/memory/discord/example
- **Tool routing**: top-10 candidate retrieval per message (never all tools in the prompt), with deterministic keyword routing or opt-in embedding retrieval
- **Memory**: USER/GUILD/CHANNEL/GLOBAL scopes, policy-gated writes (no secrets, no one-offs), pgvector + Qdrant + in-process stores, plus deterministic memory-continuity coverage and promotion gates
- **Live learning ledger**: memory writes, rolling channel summaries, successful tool workflows, and eval failures are captured as learned items; approved skills and active parameter modules are retrieved into prompts for immediate reuse; queued learning can be planned, exported, trainer-dispatched to a private control endpoint, staged, promoted, checked, and applied to a hotload control endpoint
- **Subquadratic sparse-attention path**: SubQ can be configured as a named long-context provider, scratch training has an experimental local/log sparse-attention mode for SSA-style smoke tests, and long-context retrieval has its own promotion gate
- **Safety**: async rate limiting with optional Redis-backed shared cooldown/rate-limit/confirmation/job state, operational boundary screen, mandatory confirmation for high-risk actions
- **Training capture**: every turn stored with full trace; JSONL export (ChatML / Alpaca / tool-calling / DPO); deterministic synthetic tool examples
- **Voice readiness**: opt-in guild/channel voice policy, session state, Discord Voice join/leave path, provider-backed speech queue, HTTP TTS/STT endpoint contracts, Discord playback adapter, admin listening/transcription policy controls, beta Discord audio receive bridge, and a held-out voice eval gate; production VAD/decoding/live Discord validation remain gated
- **Ops API** (Fastify): `/health`, `/stats`, `/tools`, `/tools/:name`, `/memory/search`, `/learning/review`, `/learning/status`, `/learning/items`, `/learning/items/batch-review`, `/learning/parameter-growth/plan`, `/learning/parameter-growth/dataset`, `/learning/parameter-training/dispatch`, `/learning/parameter-modules`, `/learning/parameter-modules/stage-from-manifest`, `/learning/parameter-hotload/apply`, `/learning/parameter-snapshot`, `POST /training/export`, `POST /training/feedback/preference`
- **Infra**: Prisma + PostgreSQL, Docker Compose (pgvector/Redis/Qdrant), optional Redis-backed cooldown/rate-limit/confirmation/job state, strict TypeScript, 410 passing tests

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
Run `npm run register:discord-commands` after setting `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` to publish the `/ai input:<text>` slash command; set `DISCORD_GUILD_ID` for fast guild-scoped registration during development.

## Commands

| Command | What it does |
|---|---|
| `!ai ping` | Run the ping tool end-to-end |
| `!ai tools` / `!ai tool <name>` | Browse the tool registry |
| `!ai memory recall <query>` / `!ai memory remember <text>` | Long-term memory |
| `!ai settings show|allow-channel|disable-tool|enable-tool` | Admin-only server policy controls |
| `!ai voice status|policy|enable|disable|join|leave|say|listen|stop-speaking` | Opt-in voice presence, speech queue, and listening/transcription policy management |
| `!ai export-training` | Export training JSONL (admin) |
| `!ai stats` / `!ai health` / `!ai help` | Ops info |
| `/ai input:<text>` | Slash-command entrypoint for the same chat and deterministic command paths |

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` / `npm start` / `npm run build` | Run (watch) / run compiled / compile |
| `npm run typecheck` / `npm test` | Strict TS check / Vitest suite |
| `npm run test-llm` | Smoke-test the configured LLM + embedding endpoints |
| `npm run register:discord-commands` | Register `/ai input:<text>` slash command globally or to `DISCORD_GUILD_ID` |
| `npm run export:training` | Write `exports/training/*.jsonl` from logged interactions |
| `npm run plan:parameter-growth` | Write a parameter-growth training-batch manifest from approved queued learned items |
| `npm run check:parameter-growth-plan` | Gate a parameter-growth plan before any trainer consumes it |
| `npm run build:parameter-growth-data` | Build gated parameter-growth JSONL handoff data from the live learned-item store |
| `npm run check:parameter-growth-data` | Verify parameter-growth data manifests, hashes, record schema, and obvious secret leakage |
| `npm run dispatch:parameter-training` | Re-check and dry-run or POST checked parameter-growth data to a private trainer endpoint |
| `npm run run:parameter-trainer` | Plan, dry-run/execute, or import a SubQ/SSA-compatible parameter trainer run |
| `npm run serve:parameter-trainer` | Run the local trainer control endpoint with auth, status, quality re-checks, and state-only or command backend |
| `npm run check:parameter-module-staging` | Verify trained parameter-module staging manifests, artifact hashes, eval passes, source ids, and rollback metadata |
| `npm run build:parameter-hotload` | Emit a model-server hotload manifest for active promoted modules with staging artifacts |
| `npm run check:parameter-hotload` | Verify hotload manifest status, request accounting, required artifacts, and artifact hashes before loader consumption |
| `npm run apply:parameter-hotload` | Validate and dry-run or POST a checked hotload manifest to `PARAMETER_HOTLOAD_ENDPOINT` |
| `npm run serve:parameter-hotload` | Run the local hotload control endpoint with state-only or HTTP model-server backend, status, auth, and rollback hooks |
| `npm run serve:model-adapter-sidecar` | Run the private vLLM/Ollama adapter sidecar that receives `parameter-hotload-backend-v1` load/rollback requests |
| `npm run validate:model-adapter-sidecar` | Dry-run or live-check the private model-adapter sidecar with a hash-checked hotload manifest |
| `npm run download:datasets` / `npm run prepare:datasets` | Acquire and prepare open SFT datasets with provenance + quality reports |
| `npm run check:dataset-governance` | Verify raw dataset provenance, licenses, source balance, output hashes, synthetic share, and secret/PII scans |
| `npm run build:sft-mixture` / `npm run build:preference-mixture` | Build production SFT and DPO/preference train/validation mixtures |
| `npm run build:protocol-sft` | Build a contamination-guarded protocol-only scratch SFT set from synthetic tool examples |
| `npm run build:behavior-sft` | Build a held-out-safe persona/social behavior SFT set from project-owned templates |
| `npm run build:router-sft` | Build a separate specialist-router SFT set for MoE-style route/expert gating |
| `npm run analyze:sft-sequences` | Estimate SFT sequence lengths, packed steps, and truncation risk for the QLoRA context budget |
| `npm run build:eval-suite` / `npm run eval:llm` / `npm run eval:predictions` / `npm run eval:gate` | Build held-out protocol/tool evals, collect live model outputs, score prediction JSONL, and enforce promotion gates |
| `npm run check:tool-protocol-coverage` | Verify BFCL-style tool protocol suite coverage across required args, permissions, confirmation, multi-turn, no-tool, and prompt-injection families |
| `npm run eval:tool:tiny` | Run a local scratch Transformer checkpoint against the held-out protocol/tool suite |
| `npm run build:knowledge-eval` / `npm run eval:knowledge:llm` / `npm run eval:knowledge` / `npm run eval:knowledge:gate` | Build held-out knowledge evals, collect live model answers, score reference overlap, and enforce knowledge gates |
| `npm run check:knowledge-coverage` | Verify knowledge suite source balance, context-grounded cases, technical/code cases, long prompts, long-form answers, concise answers, unique rows, and reference hashes |
| `npm run eval:knowledge:tiny` | Run the promoted local scratch Transformer checkpoint against the held-out knowledge suite |
| `npm run build:behavior-eval` / `npm run eval:behavior:llm` / `npm run eval:behavior:tiny` / `npm run eval:behavior` / `npm run eval:behavior:gate` | Build held-out persona/social-cue evals, collect live or scratch-checkpoint JSON outputs, score behavior requirements, and enforce behavior gates |
| `npm run check:behavior-coverage` | Verify behavior suite coverage for she/her identity, affective voice, casual slang/opinion, social support/repair, candid boundaries, and tool abstention |
| `npm run build:voice-eval` / `npm run eval:voice:oracle` / `npm run eval:voice` / `npm run eval:voice:gate` | Build and gate voice transcript, speaker-attribution, turn-taking, latency, social-timing, and retention-policy eval cases |
| `npm run check:voice-coverage` | Verify voice suite coverage for transcription, speaker/crosstalk attribution, turn-taking, latency, social timing, raw-audio retention, and training-review policy |
| `npm run build:router-eval` / `npm run eval:router:oracle` / `npm run eval:router:tiny` / `npm run eval:router` / `npm run eval:router:gate` | Build and gate held-out specialist routing evals for tool/knowledge/persona/casual/social/boundary routing |
| `npm run check:router-coverage` | Verify MoE router suite coverage across tool protocol, knowledge, persona, casual, social-cue, boundary, and expert-family routes |
| `npm run build:tool-router-eval` / `npm run eval:tool-router` / `npm run eval:tool-router:gate` | Build and gate candidate-tool retrieval so expected tools land in top-N and permission-filtered tools stay hidden |
| `npm run build:skill-eval` / `npm run eval:skill` / `npm run eval:skill:gate` | Build and gate approved-skill retrieval evals so learned workflow hints stay precise and do not leak unapproved skills |
| `npm run build:memory-eval` / `npm run eval:memory` / `npm run eval:memory:gate` | Build and gate memory continuity evals for remember/recall, scope isolation, forgetting, policy rejection, and learned-item capture |
| `npm run check:memory-coverage` | Verify memory continuity coverage for immediate recall, implicit capture, scope isolation, forgetting, policy rejection, and learned-item capture |
| `npm run build:long-context-eval` / `npm run eval:long-context:oracle` / `npm run eval:long-context:llm` / `npm run eval:long-context` / `npm run eval:long-context:gate` | Build and gate synthetic needle, synthetic repo-artifact, real repo snapshot, and multi-file repo reasoning evals for the SubQ/subquadratic sparse-attention path |
| `npm run check:contamination` | Audit train JSONL against held-out eval suites for exact leakage and high n-gram overlap |
| `npm run train:tiny-transformer` / `npm run train:tiny-char` | Run local from-scratch training smoke baselines, including assistant-loss masking experiments |
| `npm run check:training` | Validate dataset splits, hashes, model artifacts, and training loss movement |
| `npm run report:training-runs` | Rank local training runs and optionally gate a candidate against the best comparable baseline, with attached protocol, knowledge, behavior, and router evidence |
| `npm run check:training-report` | Verify an iteration report is complete for review or strict promotion |
| `npm run check:production-readiness` | Preflight production SFT/DPO datasets, contamination, tool protocol coverage, knowledge coverage, behavior coverage, voice coverage, router coverage, memory coverage, eval gates, SubQ/SSA contract, memory/skill continuity, and QLoRA configs before GPU training |
| `npm run check:training-configs` | Validate Axolotl/Unsloth production QLoRA config scaffolds and their dataset paths |
| `npm run check:subq-architecture` | Verify the SubQ/SSA architecture contract: long-context suite metadata, SubQ routing, local sparse trainer/evaluator support, and sparse edge budget |
| `npm run check:redis-runtime` | Live-smoke Redis-backed cooldowns, rate limits, pending confirmations, and scheduled/repeating jobs with an isolated key prefix |
| `npm run check:qdrant-memory` | Live-smoke Qdrant collection setup, scoped memory write/search, point lookup/delete, and cleanup with an isolated collection |
| `npm run generate:examples` | Deterministic synthetic tool examples (JSONL + DB) |
| `npm run seed:tools` | Sync registry metadata into `ToolDefinitionRecord` |
| `npm run prisma:migrate` | Apply migrations |

## How a message flows

```
message → context → safety precheck → memory retrieval (top 5)
        → tool candidates (top 10, permission-filtered)
        → approved skills + active growth modules → prompt → LLM
        → JSON parse (repair + Zod) → gates: args/permission/cooldown/confirmation
        → execute → follow-up LLM turn → reply
        → conversation + training trace logged → policy-gated memory write
        → learned-item ledger record for memory/RAG access + future training review
        → scheduled channel-summary consolidation into retrievable memory
        → skill/eval-failure candidates from tool outcomes + parse/gate failures
        → parameter-module activation trace for promoted growth modules
        → scheduled parameter-growth batch plan for approved queued learning
        → gated parameter-growth data + checked/private trainer control dispatch
        → module staging evidence before promotion
        → checked/applied hotload handoff for active model-server artifacts
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
4. Build the first reproducible dataset/training iteration (`docs/AI_TRAINING_PLAN.md`), pass `npm run check:dataset-governance`, `npm run check:knowledge-coverage`, `npm run check:behavior-coverage`, `npm run check:voice-coverage`, `npm run check:router-coverage`, `npm run check:memory-coverage`, `npm run check:subq-architecture`, and `npm run check:production-readiness`, then QLoRA-fine-tune the Qwen3 4B Instruct production profile (Unsloth/Axolotl), evaluate protocol, knowledge, router, persona/social behavior, memory continuity, long-context retrieval if using SubQ/SSA, dry-run `npm run dispatch:parameter-training`, plan/import through `npm run run:parameter-trainer`, and run `npm run check:parameter-module-staging` before shipping a trained module.

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

**Fully working:** boot/degraded modes, Discord conversation + prefix commands, `/ai input:<text>` slash-command registration/handler, admin settings commands for text allowlists and disabled tools, per-guild text-channel allowlist enforcement, per-guild disabled-tool routing/command/executor enforcement, configurable Irene presence, voice policy/session scaffold, opt-in voice join/leave command path, provider-backed voice speech queue with cooldown/depth/stop gates, HTTP TTS/STT provider contracts, Discord playback adapter, listening/transcription policy commands, buffered-audio transcription gate, beta Discord receive bridge, voice eval gate, both LLM providers + normal fallback and strict SubQ/SSA long-context router, response parsing/repair, tool registry/router/executor with all gates, Redis-backed cooldown/rate-limit/confirmation/job runtime state when enabled, pgvector + in-process memory stores, memory policy, operational boundary screen for credentials/secret exfiltration/mass mentions/doxxing/credential theft/tool-gate bypass, live-learning ledger capture for memory writes/rolling channel summaries/tool-skill candidates/eval failures, memory continuity gate, skill retrieval gate, learned-item browser review console plus single and batch review/queue ops API, on-demand parameter-growth plan/dataset/trainer-dispatch ops API, approved-skill prompt retrieval, active parameter-module prompt activation, parameter-growth planning/gating/data handoff/quality checks/trainer dispatch contract/backend-aware trainer control endpoint/command trainer backend/SubQ-aware trainer execution runner/module staging and promotion gates/stage-from-manifest API/hotload handoff quality checks/apply client/backend-aware control endpoint/generic HTTP model-server backend adapter/vLLM+Ollama model-adapter sidecar/status accounting/direct validation client and ops API, rate limiting, training capture, JSONL export, synthetic generation, protocol/knowledge/behavior/router/tool-router/skill/memory/long-context/voice eval gates, BFCL-style tool protocol coverage readiness, knowledge coverage readiness, behavior coverage readiness, voice coverage readiness, router coverage readiness, memory continuity coverage readiness, SubQ/SSA architecture contract and sparse-attention budget checks, dataset governance and contamination readiness checks, adversarial no-tool, expanded multi-turn confirmation/correction, and prompt-injection protocol cases, ops API, docker compose, 410 tests.

**Implemented but unverified against live services:** QdrantMemoryStore now has fake-fetch coverage plus a live smoke command, but still needs to be run against your deployed Qdrant before production; Redis runtime-state and job-queue paths now have fake-client coverage plus a live smoke command, but still need to be run against your deployed Redis before production; model-adapter sidecar provider calls have a dry-run/live validation client, but still need a run against a real vLLM/Ollama process.

**Placeholders (interface real, body minimal - all tracked in ARCHITECTURE.md):** production voice VAD/decoding/speaker-attribution evals.

## License

Private/unlicensed — set your own before distributing.
