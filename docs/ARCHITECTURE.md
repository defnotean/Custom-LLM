# Architecture

A local-LLM-powered Discord bot platform built to scale to 400+ tools and to capture every interaction as future fine-tuning data. The companion research document (`discord-bot-architecture.md` at the repo root) explains *why* this shape; this document explains *what is built*.

## Message flow

```
Discord message
  → messageCreate handler          (src/discord/events/messageCreate.ts)
  → context builder                (src/discord/utils/discordContext.ts)
  → pending-confirmation check     (AgentController — "yes"/"no" resolution)
  → safety pre-check               (SafetyService: rate limit + content screen)
  → memory retrieval (top ~5)      (MemoryService → vector store)
  → tool candidate retrieval (~10) (ToolRouter — NEVER the whole registry)
  → parameter activation (top ~3)  (active promoted growth modules)
  → skill retrieval (top ~3)       (approved LearnedItem skill hints)
  → prompt builder                 (systemPrompt + tool/memory/parameter/skill/safety sections)
  → LLM call                       (LLMRouter → OpenAI-compatible / Ollama)
  → response parser                (parseAssistantResponse: JSON + repair + Zod)
  → tool gates                     (validate args → permissions → cooldown → risk/confirmation)
  → tool executor                  (ToolExecutor, with timeout)
  → follow-up LLM turn             (tool result → natural reply; template fallback)
  → Discord reply                  (typing indicator, 2000-char splitting)
  → conversation + training log    (TrainingDataLogger → Conversation + TrainingExample)
  → optional memory write-back     (MemoryPolicy decides)
  → learned-item ledger record     (LiveLearningRepository, when DB is available)
  → skill/eval-failure candidates  (InteractionLearningCapture)
  → parameter-growth plan          (scheduled planner for approved queued learning)
```

Casual chat takes the **fast path**: when the ToolRouter reports `likelyNeedsTool: false`, the prompt contains no tool section and there is no second LLM turn — one model call, minimal context.

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| Discord | `src/discord/` | Gateway events, context normalization, prefix commands, typing/splitting |
| Voice & Presence | planned `src/discord/voice/` | Bot identity, status, voice-channel join/leave, TTS playback, opt-in STT/transcription |
| Orchestration | `src/ai/orchestration/` | AgentController + thin agents (conversation, tool-router, memory, safety, evaluation) |
| LLM | `src/ai/llm/` | Provider abstraction, OpenAI-compatible + native Ollama, fallback router |
| Parsing | `src/ai/parsing/` | JSON extraction/repair, strict action-protocol validation |
| Prompts | `src/ai/prompts/` | Versioned system prompt, tool/memory/parameter/skill/safety sections |
| Tools | `src/tools/` | Registry, router, executor, permission/cooldown services, categories |
| Memory | `src/memory/` | Service + policy + embedding providers + stores (pgvector/Qdrant/in-memory) |
| Live Learning | `src/learning/`, `src/database/repositories/LiveLearningRepository.ts` | Runtime learning ledger, persisted learned-item records, immediate memory/skill access, parameter-module accounting and activation |
| Safety | `src/safety/` | Rate limiting, moderation screen (placeholder), confirmation gating |
| Training | `src/training/` | Full-fidelity interaction capture, JSONL exporters, synthetic generation, parameter-growth planning and staging gates |
| Persistence | `src/database/`, `prisma/` | Prisma models + repositories |
| API | `src/server/` | Fastify ops API (health/tools/memory/learning/training/stats) |
| Jobs | `src/jobs/` | In-process queue scaffold + workers |

### Trust model (non-negotiable)

The LLM's output is **data, not authority**:

1. Output must parse into one of four protocol shapes (`message`, `tool_call`, `confirmation_request`, `clarification`); anything else degrades to plain text and is logged as a format failure.
2. A `tool_call` only executes after, in order: tool exists → tool enabled → Zod argument validation → member permission check → cooldown check → risk/confirmation gate. All in code (`ToolExecutor`), none delegated to the model.
3. High/critical-risk tools always require explicit user confirmation while safety is enabled.
4. User content, tool output, and retrieved memory are all treated as untrusted prompt inputs (injection surface); the safety section + code gates assume hostile text.

### Discord identity boundary

Irene is designed to feel like a persistent Discord presence, but the supported implementation is a Discord application/bot account, not automation of a normal user account. A bot account can own Irene's name, avatar, status, text messages, typing indicators, and planned voice presence. Normal user-token automation/self-bot behavior is outside this architecture.

Voice features are planned as an opt-in bot capability: join allowed voice channels, play TTS, receive voice data for speech-to-text, and pass transcripts into the same router/tool/memory gates used for text. Raw audio should be transient by default; durable summaries, transcripts, and training examples require explicit guild policy and review.

### Live learning boundary

Irene should not be a closed-door model that only improves after manual restarts. The architecture needs two live learning paths:

- **Immediate knowledge path:** approved memories, summaries, documents, corrections, preferences, and skill recipes are written to durable stores and indexed for retrieval while Irene is running.
- **Parameter growth path:** reviewed data feeds a background learner that can train adapters, specialists, router heads, or experts. New modules are staged, evaluated, registered, and hot-loaded only after gates pass, with rollback available.

Memory retrieval is not the same thing as model-weight learning. Durable memories make Irene more useful immediately, but they do not increase parameter count. Parameter count grows only when the deployed architecture gains trainable modules: adapters, router heads, specialists, experts, ensembles, or a bigger base model. The runtime should track base parameters, adapter parameters, specialist/expert parameters, total deployed parameters, and active parameters per request.

The current runtime can also activate promoted parameter-module records per request: active non-base modules are selected by query/tool relevance, their retrievable source learning is added to the prompt, and the trace records which modules were active. This is the live control-plane behavior. Real LoRA adapter or specialist checkpoint loading now has a checked apply client and a compatible local control endpoint; production weight loading still needs a backend adapter that attaches those artifacts to the chosen model server.

Queued reviewed learning now has trainer handoff artifacts too. `ParameterGrowthPlanner` scans approved `queued` learned items, groups them into adapter/specialist/expert batches, records source ids and hashes, estimates parameter budgets, lists gates, flags risks, and writes manifests under `training/plans/parameter-growth/` when run by the scheduled job or `npm run plan:parameter-growth`. `ParameterGrowthPlanGate` checks that a plan is ready, within parameter budget, structurally consistent, and risk-reviewed before any trainer consumes it. `ParameterGrowthDatasetBuilder` then re-fetches source learned items, verifies hashes and retention, and writes per-batch JSONL under `training/data/parameter-growth/`. `ParameterGrowthDatasetQuality` validates the emitted manifest, file hashes, record schema, batch counts, unique ids, and obvious secret patterns. After a trainer produces module artifacts, `ParameterModuleStagingGate` verifies the staging manifest, dataset manifest hash, dataset-source ids, artifact hashes, eval-report hashes, required eval passes, parameter budget, and rollback target before the module should be registered. `ParameterModuleStagingService` backs `POST /learning/parameter-modules/stage-from-manifest`, so the checked manifest can create a staged module with runtime eval summaries and full staging evidence preserved in metadata. `ParameterModulePromotionGate` then blocks activation unless the staged module still has rollback metadata, source ids, dataset hashes, passing staging evidence, no failed eval reports, and required runtime eval passes for its module type. `ParameterModuleHotloadPlanner` emits `training/plans/parameter-hotload/latest.json` from active modules so a model server can load exactly the promoted artifacts and rollback targets; `ParameterModuleHotloadManifestQuality` validates that handoff's status, accounting, required artifacts, eval statuses, and artifact hashes before loader consumption; `ParameterModuleHotloadService` dry-runs or posts the checked `parameter-module-hotload-apply-v1` payload to a configured private loader endpoint; `ParameterHotloadControlServer` provides the local compatible receiver with status and rollback state. These artifacts are not automatic learning; they are the reproducible contract the trainer and hot-loader must satisfy.

### Tool routing at 400+ tools

LLM tool-selection accuracy collapses past ~30–50 in-context tools, so the registry is never rendered wholesale into a prompt. The `ToolRetrievalStrategy` interface isolates retrieval. The default implementation is deterministic keyword/category/example scoring with permission pre-filtering. `TOOL_ROUTER_STRATEGY=embedding` enables embedding retrieval over stable tool search documents, blends cosine similarity with the keyword score, and falls back to keyword routing if the embedding provider fails. No agent-layer changes are required. Tool descriptions/examples are deliberately written like search documents because they feed both strategies.

### Ports & adapters

The orchestration layer depends on minimal interfaces (`MemoryPort`, `SafetyPort`, `TrainingSink` in `src/types/ai.ts`; `ToolMemoryAccess` in `ToolDefinition.ts`) rather than concrete services. Services satisfy them structurally. This keeps every stage testable with fakes (see `tests/agentController.test.ts`) and lets the bot boot with any subsystem disabled.

### Graceful degradation

| Missing dependency | Behavior |
|---|---|
| Database unreachable | Bot runs; conversations/tool logs/training capture disabled (loud warning) |
| Vector store init fails | Falls back to in-process memory store (non-persistent) |
| Embedding endpoint down | Falls back to in-process store; memory effectively session-only |
| No `DISCORD_TOKEN` | API-only mode (useful for development) |
| LLM endpoint down | Friendly error reply per message; trace still logged |

## Decisions log

| # | Decision | Rationale |
|---|---|---|
| 1 | TypeScript CommonJS (`module: commonjs`) | Avoids ESM `.js`-extension friction across ~80 files; all deps (discord.js 14, fastify 5, prisma 6, pino 9) are CJS-compatible; `node dist/` runs directly |
| 2 | Engagement: mention / DM / reply / `!ai` prefix only | Spam + cost control; per-guild channel allowlists reserved in `GuildProfile.settingsJson` (TODO: enforcement) |
| 3 | Cooldowns/rate limits in-process behind store interfaces | Single-process correctness now; Redis store is a drop-in for multi-process (interfaces: `CooldownStore`, rate-limit map) |
| 4 | In-process job queue (`InProcessJobQueue`) | Real scheduling semantics without infra; BullMQ/Redis is the documented production swap with the same `JobQueue` interface |
| 5 | pgvector DDL at store init, not in Prisma migrations | Prisma lacks a vector type; runtime `CREATE EXTENSION/TABLE IF NOT EXISTS` keeps `migrate deploy` clean and lets missing pgvector degrade instead of block |
| 6 | Qdrant keeps a relational copy of memories in Postgres when available | Qdrant stays a rebuildable index; user data lives in the relational store (deletion requests, audits) |
| 7 | Tool-role messages mapped to labeled user messages for OpenAI-compatible providers | Maximum compatibility across local servers with inconsistent `tool` role support; native tool wire-format is a future optimization |
| 8 | Training capture stores the full system prompt per example | Disk-cheap, fidelity-expensive to lose; exports can filter/dedupe later |
| 9 | DPO export only emits explicit pairs (synthetic valid-vs-hallucinated, reviewed feedback preferred-vs-rejected) | Never fabricate preference data |
| 10 | `API_PORT`/`API_HOST` added beyond the spec env list | The API server needs a bind address; documented in `.env.example` |
| 11 | discord.js permission names normalized to UPPER_SNAKE | Spec/tool definitions use `MODERATE_MEMBERS` style; conversion at the Discord boundary (`toUpperSnake`) |
| 12 | Bot identity name "Irene" hardcoded at composition root | Product identity is intentionally fixed to Irene/she-her for consistency; per-guild style overrides can still live in `GuildProfile.settingsJson` later without changing identity |

## Placeholders & TODOs (honest status)

| Area | Status |
|---|---|
| Content moderation (`ModerationRules`) | **Placeholder** — minimal regex screen. Production: Llama Guard via local endpoint + Discord AutoMod + provider moderation |
| Slash commands (`interactionCreate`) | **Placeholder** — replies with a pointer to `!ai`; registration script + defer/followUp flow not built |
| Memory summarizer worker | **Placeholder** — scheduled and observable, performs no writes; intended: rolling channel summaries + memory consolidation |
| Embedding-based tool routing | **Implemented, opt-in** via `TOOL_ROUTER_STRATEGY=embedding`; use a real embedding model for semantic recall and compare eval metrics before promotion |
| QdrantMemoryStore | **Implemented, not integration-tested** — REST calls per documented API; exercise against `docker compose up qdrant` before relying on it |
| `summarize_channel_recent_messages` | Returns raw transcript; the follow-up LLM turn summarizes. Dedicated summarization pass TODO |
| `get_guild_stats` | Structural stats only; activity metrics (messages/day) TODO |
| `warn_user` | Records to tool log + DMs; dedicated warnings table TODO |
| Per-guild settings enforcement (channel allowlists, disabled tools) | Schema + cache exist (`GuildRepository`); enforcement TODO |
| Redis usage | Provisioned in compose, not yet consumed (see decisions #3/#4) |
| LLM-assisted memory extraction (Mem0-style ADD/UPDATE/DELETE/NOOP) | Heuristic policy shipping; LLM extraction slots behind `maybeExtractMemoryFromConversation` |
| Voice presence, STT, and TTS | **Planned** - use bot voice connections for compliant join/speak/listen behavior; requires opt-in retention policy and evals |
| Live memory/skill learning | **Memory + interaction capture + review API + skill retrieval implemented** - memory writes are retrievable immediately; tool workflows become skill candidates; `/learning/items` reviews/queues candidates; approved skills are retrieved into prompts as workflow hints; richer UI TODO |
| Lifelong parameter-growth loop | **Accounting + persistence + planning + gating + data handoff + quality checks + staging evidence + promotion readiness + hotload handoff checks/apply client/control endpoint + activation implemented** - parameter modules can be staged from checked manifests, readiness-gate-promoted, counted, persisted, reported through `/learning/status`, managed through `/learning/parameter-modules`, linked to source learned items, planned/gated/exported/checked from approved queued learning, staging-checked from trainer artifacts, emitted as checked model-server hotload manifests, applied to the local/private loader-control contract, and retrieved into prompts when active/relevant; background trainer/real model-server backend adapter TODO |
| Sharding | Not needed until ~2,500 guilds; design is stateless-ready except in-process cooldown/pending-confirmation maps (move to Redis first) |
