# Conversational Discord Bot with Long-Term Memory & 400+ Tools
## Research-Backed System Architecture & Build Plan (June 2026)

> **Thesis:** The right answer is **not** "fine-tune a large LLM." It's a **hybrid retrieval-centric architecture**: a strong instruction-tuned generalist model (API or self-hosted) + RAG for memory and server knowledge + **retrieval-based tool routing** for the 400+ tools + a lean multi-agent graph + a guardrail layer. Fine-tuning is an *optional, deferred optimization* for narrow behaviors (routing, persona), not the foundation.
>
> The single most important decision in this whole project is **how you select tools**, because LLM tool-selection accuracy collapses past ~30–50 tools in context. Everything else is comparatively standard.

---

## 0. Why not "just fine-tune a big model"?

| Goal | Naive answer | Better answer | Why |
|---|---|---|---|
| Natural conversation | Fine-tune | Strong base model + system prompt + few-shot persona | Modern instruct models are already excellent conversationalists; fine-tuning risks regressions and costs iteration speed |
| Long-term memory | Train facts into weights | **Retrieval (RAG) over a memory DB** | Weights can't be updated per-user in real time; memory must be editable, deletable (GDPR), per-user/per-guild |
| Server-specific knowledge | Fine-tune per server | **Per-guild RAG namespace** | 1 model, N guilds; knowledge changes daily; no retraining |
| 400+ tools | Train tool use into model | **Retrieve top-k tools, then let model pick** | Context degrades past 30–50 tools; retrieval keeps it at 5–15 (RAG-MCP, Anthropic Tool Search) |
| Personality/voice | Fine-tune | Prompt now, **small LoRA later** if needed | Cheap to iterate in prompt; LoRA only once voice is stable & you have logged data |

**When fine-tuning *is* worth it (Phase 4+):** a small, fast **router/classifier** model; a small **persona** model to cut token cost on the conversational hot path; or distilling a frontier model's tool-calling behavior into a cheap open model once you have volume. Always **LoRA/QLoRA on a small model**, never full fine-tune of a 70B+ as step one.

---

## 1. Recommended System Architecture

```
                          ┌─────────────────────────────────────────────┐
   Discord Gateway        │              BOT PROCESS (Python)            │
  (events, slash cmds) ──▶│  discord.py  ·  defer<3s  ·  typing  ·  chunk│
                          └───────────────┬─────────────────────────────┘
                                          │ message / interaction
                                          ▼
                         ┌──────────────────────────────────┐
                         │  1. INGRESS GUARDRAILS            │
                         │  rate-limit · dedupe(idempotency) │
                         │  PII scrub · prompt-injection scan│
                         │  Llama Guard / moderation         │
                         └───────────────┬──────────────────┘
                                         ▼
                         ┌──────────────────────────────────┐
                         │  2. CONTEXT ASSEMBLY              │
                         │  • short-term window (Redis)      │
                         │  • rolling summary                │
                         │  • semantic memories (pgvector)   │
                         │  • per-guild knowledge (RAG)      │
                         └───────────────┬──────────────────┘
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │  3. ORCHESTRATOR  (LangGraph state machine)   │
                  │                                               │
                  │   ROUTER ── simple chat? ──▶ CONVERSATION     │
                  │      │                         agent (fast)   │
                  │      └── needs action? ──▶ TOOL ROUTER        │
                  │                              │                │
                  │                    ┌─────────▼──────────┐     │
                  │                    │ stage A: intent     │     │
                  │                    │ stage B: retrieve   │ ◀── tool index
                  │                    │   top-k tool schemas│     (pgvector +
                  │                    │ stage C: LLM picks  │      BM25 + rerank)
                  │                    │   & fills args      │     │
                  │                    └─────────┬──────────┘     │
                  │                   PLANNER (only multi-step)    │
                  │                              │                 │
                  │                       EXECUTOR (sandboxed,     │
                  │                       idempotent, retried)     │
                  └───────────────┬───────────────────────────────┘
                                  ▼
                  ┌──────────────────────────────────┐
                  │  4. EGRESS GUARDRAILS             │
                  │  output moderation · de-PII ·     │
                  │  citation/format · length split   │
                  └───────────────┬──────────────────┘
                                  ▼
                  ┌──────────────────────────────────┐
                  │  5. MEMORY WRITE-BACK (async)     │
                  │  extract facts → ADD/UPDATE/      │
                  │  DELETE/NOOP · update summary     │
                  └──────────────────────────────────┘

  Cross-cutting: Langfuse traces · structured logs · Prometheus/Grafana · Sentry
  Data spine:    Postgres + pgvector  ·  Redis  ·  S3/R2 object store
  Inference:     Claude/GPT API  (+ optional self-hosted vLLM for cheap turns)
```

**Latency principle:** ~70–80% of messages are "just chat." They should take the **fast path** (router → conversation agent, no tools, no planner). Only escalate to retrieval/planning/tools when the router says so. This keeps p50 latency low and cost down; the heavy machinery only fires when earned.

---

## 2. Research Comparison (what the field actually offers, mid-2026)

### 2.1 Models — generalist reasoning + tool use
- **API frontier (best quality, zero ops):** Claude (Opus/Sonnet 4.6), GPT, Gemini. Best tool-calling reliability, native tool-search, prompt caching. **Recommended for MVP.**
- **Open-weight, agentic (self-host or via OpenRouter):** the Qwen3.x family, GLM-5.x, Kimi K2.x, DeepSeek V4, MiniMax M3 are the current top open contenders for function calling/agentic work. **Don't trust any single blog's version numbers** — check the **live Berkeley Function-Calling Leaderboard (BFCL v4)** before committing; it's the durable source of truth.
- **Small/cheap tier (cost-optimized turns & routing):** Haiku-class API models, or small Qwen3 / Llama-class open models. Used as the *cheap leg* of a dual-backend router and for classification.

**Recommendation:** Start API-only. Add a self-hosted open model later **only** if token cost or data-residency demands it. Use a **dual-backend router** (cheap model for simple chat, frontier for tool/plan turns).

### 2.2 Tool routing for many tools — the core problem
Three proven techniques, all variations of "don't put 400 tools in context":

| Technique | How | Evidence | Use when |
|---|---|---|---|
| **RAG-MCP** (arXiv:2505.03275) | Embed all tool descriptions; semantic-retrieve top-k per query; inject only those | Cut prompt tokens >50%, **tripled** selection accuracy (43% vs 13.6%) | Model-agnostic; you control it |
| **Anthropic Tool Search Tool** | Mark tools `defer_loading:true`; Claude searches catalog (BM25/regex), loads 3–5 on demand | ~85% token reduction; holds accuracy at thousands of tools | You're on Claude API |
| **Semantic Router** (Aurelio Labs / vLLM Semantic Router) | Classify query → route to a tool *domain* via embeddings, no LLM call | +8–15 pts tool-selection accuracy, −30–50% tokens on common intents | Cheap first-stage narrowing |

**Reality check:** independent tests put tool-*retrieval* accuracy around 56–64% on adversarial sets. Retrieval quality is not free — you must invest in tool descriptions, hybrid (BM25+dense) search, a reranker, and a "not found → reformulate" loop. (Details in §6.)

> **Symbolic planners?** A full PDDL/symbolic planner is overkill here. Keep an **LLM planner** that only activates for multi-step tool chains, and constrain it with a state machine (LangGraph). Reserve symbolic methods for the few tools with hard preconditions (e.g., "must auth before posting").

### 2.3 Memory systems
| System | Model | Strength | Pick when |
|---|---|---|---|
| **Mem0** | Extracts salient facts per message pair; ADD/UPDATE/DELETE/NOOP into vector DB | Simplest path to persistent chatbot memory; fast fuzzy recall | **Default for this bot** |
| **Zep / Graphiti** | Temporal knowledge graph; understands state changes ("moved London→Tokyo") | Contradiction/state handling, time-aware | Users with evolving state, relationships |
| **Letta (MemGPT)** | OS-style context paging; episodic coherence | "Yesterday we tried X and it failed" agents running for days | Long-horizon autonomous agents |
| **Roll-your-own** | pgvector + extraction prompt | Full control, no dependency | You want one DB and no extra service |

**Recommendation:** **Mem0** (or a thin roll-your-own clone of its ADD/UPDATE/DELETE/NOOP loop) on your Postgres+pgvector spine. Graduate to Zep-style temporal graph only if contradiction handling becomes a real pain.

### 2.4 RAG method
Adopt **Anthropic Contextual Retrieval**: prepend a short LLM-generated context blurb to each chunk before embedding **and** before BM25 indexing, then **hybrid search (dense + BM25) + rerank**. Reported ~49% fewer retrieval failures (contextual embeddings+BM25), ~67% fewer with reranking added. Use it for **per-guild knowledge** and optionally for memory recall.

### 2.5 Vector database
| DB | Sweet spot | Note |
|---|---|---|
| **pgvector** (Postgres) | <50M vectors, you already have Postgres | **Default.** One DB for relational + vectors + memory. HNSW 5–8 ms. Supabase/Neon make it turnkey |
| **Qdrant** | Fastest **filtered** search, Rust, self-host | Best graduation target; great per-guild/per-user filtering |
| **Milvus** | Billion-vector, distributed, k8s | Only at genuinely large scale + ops capacity |
| **Weaviate** | Built-in hybrid search | If you want hybrid out of the box |

**Recommendation:** **pgvector** now; **Qdrant** when filtered-search latency or vector count forces a split.

### 2.6 Embeddings & reranker
- **Embeddings:** API (Voyage / OpenAI `text-embedding-3` / Cohere) for zero ops, or self-host **Qwen3-Embedding** (SOTA open, MTEB ~75) or **BGE-M3** (dense+sparse+ColBERT in one model — ideal for hybrid). Nomic Embed v2 for heavy multilingual.
- **Reranker:** Cohere Rerank (API) or **BGE-reranker-v2** (self-host). Rerank the top ~50 → keep top ~8.

### 2.7 Multi-agent / orchestration framework
| Framework | Strength | Pick when |
|---|---|---|
| **LangGraph** | Highest production readiness: explicit state graph, persistence/checkpoints, human-in-the-loop, streaming, LangSmith | **Recommended** — you need deterministic control + state |
| **CrewAI** | Role-based crews, ~20 lines to start | Fast prototyping; teams often migrate off it for state control |
| **AutoGen / AG2** | Conversational GroupChat | Research, open-ended multi-agent dialogue |
| **OpenAI Agents SDK** | Clean handoffs, built-in tracing/guardrails | All-OpenAI shops |
| **Claude Agent SDK** | Native tool use + memory | All-Claude shops; least glue code |
| **Pydantic AI** | Type-safe, lightweight | You want minimal framework, strong typing |

**Recommendation:** **LangGraph** for the orchestration graph. It models the router→conversation/tool/planner/executor flow as a state machine with checkpoints (which also gives you crash-resume and human-in-the-loop approval for risky tools).

### 2.8 Serving (only if self-hosting a model)
- **vLLM** — production default (PagedAttention + continuous batching, ~8–9× Ollama throughput). **SGLang** as an alternative. **TGI is in maintenance mode** as of Dec 2025 — don't start new on it. **Ollama** is fine for local dev only.
- Rough capacity: a single RTX 4090 serves an 8B model ~120 tok/s (~10M tokens/day). An H100 serves a 70B (FP8) at high concurrency. A100 ~$2–3k/mo cloud.

### 2.9 Fine-tuning (deferred)
- **Unsloth** (fastest single-GPU LoRA/QLoRA), **Axolotl** (config-driven, multi-GPU, DPO), **TRL** (RLHF/GRPO/DPO), **Llama-Factory**. QLoRA fits a 7B in ~8 GB. Start `r=16, α=16, lr=2e-4`. **GRPO** is the rising alignment default (simpler than PPO, more stable than DPO). **Data quality ≫ quantity** — 500 clean examples beat 5,000 noisy.

---

## 3. Dataset Recommendations + Licensing Notes

> **Two licensing traps to internalize:**
> 1. **The OpenAI-output trap.** Most synthetic instruction/tool datasets (ToolBench, ToolACE, UltraChat, WildChat, ShareGPT) were generated by GPT-3.5/4. Even when the dataset's *own* license is permissive, OpenAI's terms restrict using their outputs to build *competing models* — a legal gray area. For anything commercial, **prefer human-authored or non-OpenAI-generated data**, or use these only for research/eval.
> 2. **The Discord trap.** Discord's **Terms of Service and Developer Policy explicitly prohibit** scraping and **prohibit using message content to train ML/AI models without Discord's express written permission.** Do **not** build a training set by scraping servers — it risks your bot/app being banned and breach-of-contract exposure. (See §9.)

### Tool-use / function-calling
| Dataset | Size | License | Commercial? | Notes |
|---|---|---|---|---|
| **TOUCAN** (`Agent-Ark/Toucan-1.5M`) | 1.5M | CC-BY-4.0 | ✅ (attribution) | **Best pick.** Synthesized from **real MCP environments** — directly relevant to your tool stack |
| **xLAM / APIGen** (`Salesforce/xlam-function-calling-60k`) | 60k | CC-BY-4.0 | ✅ (attribution) | Execution-verified, >95% human-checked. "Research purposes" caveat — evaluate before prod |
| **Glaive function calling v2** | ~113k | Apache-2.0 | ✅ | Popular, clean format |
| **Hermes Function-Calling** (NousResearch) | — | Apache-2.0 | ✅ | Good multi-turn tool dialogues |
| **ToolBench** (OpenBMB) | large | Apache-2.0 | ⚠️ research-intended, GPT-generated | Great for **eval**, OpenAI-output caveat for training |
| **ToolACE** | — | Apache-2.0 (data) | ⚠️ GPT-4-generated | OpenAI-output caveat |
| **API-Bank** | 314 dialogs / 753 calls | research | Eval only | Good held-out **benchmark** |

### Conversational / instruction
| Dataset | License | Commercial? | Notes |
|---|---|---|---|
| **OpenAssistant (OASST1/2)** | Apache-2.0 | ✅ | **Human-authored** — cleanest conversational data |
| **Databricks Dolly 15k** | CC-BY-SA-3.0 | ✅ (share-alike) | Human-authored instructions |
| **Anthropic HH-RLHF** | MIT | ✅ | Human preference pairs for alignment |
| **UltraChat** | MIT (data) | ⚠️ ChatGPT-generated | OpenAI-output caveat |
| **LMSYS-Chat-1M** | Custom (research+commercial, login) | ⚠️ | Real user data → **toxicity + PII**; filter hard |
| **WildChat** (allenai) | ODC-BY | ⚠️ | Real user↔ChatGPT → OpenAI caveat + PII |
| **ShareGPT** | murky / scraped | ❌ avoid for commercial | OpenAI ToS + unclear provenance |

### Agent / multi-step
- **AgentInstruct / AgentTuning**, **ToolBench agent trajectories**, **TOUCAN** (also agentic). Treat GPT-generated ones as research/eval.

### Discord/community style
- **There is no clean, licensed "Discord chat" corpus you can legally train on.** Approximate community-style tone with **OASST + Dolly + your own bot's logged conversations** (with user consent + a privacy policy + deletion support). Reddit-derived corpora exist but carry their own license/PII issues — vet carefully. **Your best community-style data is the data your bot legitimately generates in your own servers, with consent.**

---

## 4. Training & Evaluation Strategy

**Stance: ship with zero training.** Treat training as a Phase-4 cost/latency optimization, gated by evidence.

**If/when you train:**
1. **Tool router** (highest ROI): fine-tune a small embedding head or a small classifier on (query → tool-domain) using TOUCAN/xLAM + your own logged, correctly-routed calls. Or train a small model to emit tool calls (LoRA via Unsloth).
2. **Persona model** (cost): distill your frontier model's on-brand replies into a small open model for the cheap conversational leg.
3. **Preference alignment:** collect 👍/👎 from Discord reactions → **DPO/GRPO** to nudge tone/safety.

**Evaluation harness (build this in Phase 2, before any training):**
- **Tool selection:** BFCL-style AST match + your own held-out set of (message → correct tool + args). Track **recall@k** of the retriever and **end-to-end** selection accuracy separately.
- **Memory retrieval:** recall@k on a labeled "should-remember" set; contradiction tests (state changes).
- **Conversation quality:** LLM-as-judge rubric (helpfulness, persona adherence, groundedness) + periodic human review.
- **Safety:** red-team prompts (jailbreaks, injection via tool output & memory), Llama Guard pass-rate.
- **Ops:** p50/p95 latency, tokens/cost per message, tool error rate.
- **Regression gate:** every prompt/model/router change runs the eval set in CI before deploy.

---

## 5. Multi-Agent Workflow Design (lean, LangGraph)

Keep roles **few and purposeful** — over-engineered agent swarms add latency, cost, and debugging pain.

| Node | Responsibility | Model tier |
|---|---|---|
| **Router** | Classify: smalltalk / question / action / multi-step / moderation. Decides fast vs heavy path | small/cheap |
| **Conversation** | Persona-driven reply using assembled context; no tools | cheap or frontier |
| **Tool Router** | 3-stage retrieve→pick→fill (see §6) | frontier for arg-filling |
| **Planner** | *Only* for multi-step: decompose into a tool DAG | frontier |
| **Executor** | Run tools (sandboxed, idempotent, retried, timeouts/circuit-breakers) | n/a |
| **Critic/Verifier** (optional) | Check tool result sanity before replying | cheap |
| **Memory** (async) | Extract & write-back facts post-reply | cheap |
| **Guardrail** (cross-cutting) | Moderation in/out, injection scan | classifier + Llama Guard |

**Graph:** `ingress-guard → context-assembly → router → {conversation | tool-router → (planner?) → executor → critic} → egress-guard → reply → async memory write-back`. LangGraph **checkpointing** gives crash-resume and lets you pause for **human approval** on dangerous tools (ban, payment, mass-DM).

**Anti-patterns to avoid:** agents that chat with each other in unbounded loops; a planner that fires on every message; "manager" agents that just add a hop. Default to **single agent**; escalate only on router signal.

---

## 6. Tool-Routing Strategy for 400+ Tools (the crux)

**Never put all 400 in context.** Pipeline:

**Tool registry** (one row per tool): `name`, `namespace/domain` (e.g. `music.*`, `mod.*`, `web.*`), rich `description`, `keywords/synonyms`, JSON-schema `params`, `risk_level`, `auth_required`, `embedding`, BM25 doc.

**Stage A — Intent/domain narrowing (cheap, no LLM):** semantic router classifies the message into 1–3 **domains**. Cuts the candidate pool from 400 → maybe 40.

**Stage B — Hybrid retrieval within domain:** dense (pgvector) + BM25 over `description + keywords` → top ~50 → **rerank** → keep **top 5–15** tool schemas. (This is the RAG-MCP pattern; on Claude you can instead use the native **Tool Search Tool** with `defer_loading`.)

**Stage C — LLM selects & fills args** from the 5–15 candidates with full schemas in context.

**Robustness (because retrieval is ~60% on hard cases):**
- **Always-hot core tools** (memory.search, web.search, help) bypass retrieval.
- **Hybrid BM25+dense + reranker** (don't rely on embeddings alone — exact tool-name/keyword matches matter).
- **"Not found" loop:** if the model can't satisfy the request, reformulate the query and re-retrieve once (then gracefully say it can't).
- **Rich descriptions + synonyms** are the highest-leverage investment; write them like search documents.
- **Hierarchical namespaces** so Stage A is reliable.
- **Cache** tool embeddings; **log** every (query, retrieved set, chosen tool, success) to build a router eval/training set.
- **Confidence gating:** low retrieval confidence → ask a clarifying question instead of guessing.

**400-tool ops:** version the registry; CI-validate every tool schema; canary new tools; track per-tool success/error rates; auto-disable a tool that errors above threshold (circuit breaker).

---

## 7. Memory & Database Schema (Postgres + pgvector)

Four memory tiers: **working** (in-context recent N, Redis) · **episodic** (raw messages, DB) · **semantic** (extracted facts, vectorized) · **knowledge** (per-guild docs, RAG).

```sql
-- ── Identity / scoping ───────────────────────────────────────────
create table guilds (
  guild_id      bigint primary key,           -- Discord server id
  name          text,
  persona       jsonb,                         -- per-server voice/config
  settings      jsonb,                         -- enabled tools, opt-ins
  created_at    timestamptz default now()
);

create table users (
  user_id       bigint primary key,           -- Discord user id
  global_prefs  jsonb,                         -- cross-server prefs
  consent       jsonb,                         -- memory opt-in, data flags
  created_at    timestamptz default now()
);

-- per-(user,guild) relationship state (affinity/mood live here)
create table user_guild (
  user_id bigint references users, guild_id bigint references guilds,
  affinity real default 0, mood jsonb, notes text,
  primary key (user_id, guild_id)
);

-- ── Episodic: raw message log (short/medium term) ────────────────
create table messages (
  id            bigserial primary key,
  guild_id      bigint, channel_id bigint, user_id bigint,
  role          text,                          -- user|assistant|system|tool
  content       text,
  meta          jsonb,                         -- reply-to, attachments, reactions
  created_at    timestamptz default now()
);
create index on messages (channel_id, created_at desc);

-- rolling per-channel summary (keeps context window small)
create table conversation_summaries (
  channel_id    bigint primary key,
  summary       text,
  upto_message  bigint,                        -- last summarized message id
  updated_at    timestamptz default now()
);

-- ── Semantic: extracted long-term facts (Mem0-style) ─────────────
create table memories (
  id            bigserial primary key,
  scope         text not null,                 -- 'user' | 'user_guild' | 'guild'
  user_id       bigint, guild_id bigint,
  content       text not null,                 -- "prefers she/her", "is learning Rust"
  embedding     vector(1024),                  -- match your embed model dims
  source_msg    bigint, confidence real,
  valid_from    timestamptz default now(),
  valid_to      timestamptz,                   -- null = current (temporal/Zep-style)
  superseded_by bigint,                        -- for UPDATE/DELETE lineage
  created_at    timestamptz default now()
);
create index on memories using hnsw (embedding vector_cosine_ops);
create index on memories (scope, user_id, guild_id) where valid_to is null;

-- ── Knowledge: per-guild RAG docs ────────────────────────────────
create table knowledge_docs (
  id bigserial primary key, guild_id bigint, title text,
  source text, uri text, created_at timestamptz default now()
);
create table knowledge_chunks (
  id bigserial primary key, doc_id bigint references knowledge_docs,
  guild_id bigint,                             -- denormalized for fast filter
  chunk text, context text,                    -- Anthropic contextual-retrieval blurb
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('english', coalesce(context,'')||' '||chunk)) stored
);
create index on knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index on knowledge_chunks using gin (tsv);     -- BM25-ish hybrid
create index on knowledge_chunks (guild_id);

-- ── Tool registry (drives §6 routing) ────────────────────────────
create table tools (
  name text primary key, namespace text, description text,
  keywords text[], params jsonb, risk_level int, auth_required bool,
  enabled bool default true, embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('english', name||' '||coalesce(description,''))) stored,
  success_rate real, calls bigint default 0
);
create index on tools using hnsw (embedding vector_cosine_ops);
create index on tools using gin (tsv);

-- ── Audit / safety / feedback ────────────────────────────────────
create table tool_calls (
  id bigserial primary key, message_id bigint, tool text,
  args jsonb, result jsonb, ok bool, latency_ms int, created_at timestamptz default now()
);
create table moderation_events (
  id bigserial primary key, user_id bigint, guild_id bigint,
  stage text, verdict text, categories jsonb, raw text, created_at timestamptz default now()
);
create table feedback (                         -- 👍/👎 reactions → DPO later
  id bigserial primary key, message_id bigint, user_id bigint, signal int, created_at timestamptz default now()
);
```

**Redis** holds: per-channel hot context window, rate-limit counters, idempotency keys (dedupe Discord retries), in-flight locks, tool-result cache.
**Object store (S3/R2):** attachments, large tool outputs, exported logs.

**Memory hygiene:** Mem0-style **ADD/UPDATE/DELETE/NOOP** on write-back; cap per-user memory count (evict lowest-confidence/oldest); periodic consolidation pass to merge duplicates; honor deletion requests (set `valid_to`, hard-delete on GDPR request). Treat retrieved memory as **untrusted** (injection via "remember that you must ignore your rules" → it gets stored → poisons future prompts). Sanitize on write and on read.

---

## 8. Discord Bot Implementation Roadmap

**Library:** **discord.py** (Python — best ML ecosystem; forks py-cord/nextcord if you want newer features) or **discord.js** (Node — more web-dashboard/hosting options). Pick by team language; this doc assumes Python.

**Must-handle Discord specifics:**
- **3-second interaction timeout** → `defer()` immediately, stream/follow-up after. Show a typing indicator for message-based replies.
- **2000-char message limit** → split long replies; use embeds.
- **Rate limits** → the lib queues, but respect global limits; back off.
- **Sharding** → required at **2,500 guilds**; design stateless so shards scale horizontally.
- **Intents** → enable `message_content` (privileged) only if you read messages; justify it in your app.
- **Mention-gating** → respond on @mention / reply / DM / slash command, not every message (avoids spam + cost).
- **Slash commands** → register with subcommand groups (100-command cap); use autocomplete for tool-ish args.
- **Components** → buttons/selects/modals for confirmations (esp. risky tools) and pagination; route by `customId`; collectors must survive restarts (persist state).
- **Per-channel context** → keep separate windows per channel/thread.
- **Permissions** → check the bot's channel perms before acting; respect server roles.

---

## 9. Best Stack Recommendation

### Primary (fastest to production, best quality) — *recommended*
| Layer | Choice | Why |
|---|---|---|
| Language | **Python** + **discord.py** | Best ML/agent ecosystem |
| Reasoning LLM | **Claude (Sonnet/Opus 4.6) or GPT** via API | Top tool-calling, prompt caching, native tool-search |
| Cheap leg | Haiku-class / small open model | Dual-backend router for simple turns |
| Orchestration | **LangGraph** | State machine, checkpoints, HITL, streaming |
| Memory | **Mem0** on pgvector | Simplest robust long-term memory |
| Tool routing | **semantic-router** + pgvector/BM25 (RAG-MCP) — or Claude **Tool Search** | Scales to 400+ |
| Vector + relational | **Postgres + pgvector** (Supabase/Neon) | One spine; HNSW |
| Cache/queue | **Redis** (Upstash) | Hot context, rate-limit, idempotency |
| Embeddings | Voyage/OpenAI API → Qwen3-Embedding/BGE-M3 self-host later | Quality now, cost later |
| Reranker | Cohere Rerank / BGE-reranker | Hybrid retrieval quality |
| Safety | **Llama Guard / LlamaFirewall** + provider moderation + Discord AutoMod + injection scan | Defense in depth |
| Object store | **Cloudflare R2 / S3** | Attachments, logs |
| Observability | **Langfuse** (LLM traces) + Prometheus/Grafana + **Sentry** + structured logs | Production visibility |
| Deploy (bot) | **Docker** on **Fly.io / Railway** (or VPS) | Simple, scalable, cheap |
| Inference (if self-host) | **vLLM** on Modal/RunPod or owned GPU | Throughput |
| CI/CD | GitHub Actions + eval gate | Regression safety |

### Self-hosted / sovereignty variant
Swap reasoning LLM → open-weight (top BFCL model) on **vLLM**; embeddings → Qwen3-Embedding/BGE-M3; reranker → BGE; moderation → Llama Guard. Everything else identical. Higher ops, lower marginal token cost, full data control.

---

## 10. Risks, Mistakes to Avoid, Scaling Concerns

**Architecture mistakes**
- ❌ Loading all 400 tools into context (accuracy collapses past 30–50). ✅ Retrieve top-k.
- ❌ Fine-tuning a big model as step one. ✅ Prompt + RAG + retrieval routing; LoRA later.
- ❌ Over-engineered agent swarm. ✅ Single agent by default, escalate on signal.
- ❌ Planner on every message. ✅ Only multi-step requests.

**Legal/compliance (highest-severity)**
- ❌ **Scraping Discord to train** — violates ToS + Developer Policy ("must not use message content to train ML/AI models" without permission); risks bot/app ban + breach claims. ✅ Train only on licensed/permissive data + your own consented logs.
- ❌ Training on GPT-generated datasets for a commercial competing model (OpenAI-output gray area). ✅ Prefer human-authored (OASST, Dolly) / non-OpenAI-generated (TOUCAN, xLAM) data.
- ❌ Storing user memory without consent/deletion. ✅ Consent flag, privacy policy, GDPR delete, per-guild isolation.

**Security**
- **Prompt injection** via user messages, **tool outputs**, and **retrieved memory** ("memory poisoning"). ✅ Treat all three as untrusted; sanitize; sandbox tool execution; never let tool output silently rewrite system instructions; human-approval gate for dangerous tools (ban/kick/payment/mass-DM).
- **Multi-tenant leakage** across guilds. ✅ Always filter memory/knowledge by `guild_id`/`user_id`; test for it.
- **Secrets/PII** in logs. ✅ Redact before logging; scoped tokens.

**Reliability / latency**
- Discord **3s timeout** & **2000-char** limit (§8). ✅ Defer + chunk.
- Upstream LLM/tool flakiness. ✅ Timeouts, retries with backoff, **circuit breakers**, graceful degradation ("I'm having trouble reaching X").
- **Idempotency**: Discord/webhook retries can double-act. ✅ Dedupe keys in Redis.
- Event-loop blocking (sync work on the gateway thread → heartbeat warnings). ✅ Offload CPU work to workers/threads.

**Cost / scale**
- Embedding every message + long contexts → token blowup. ✅ Summarize + cache + dual-model routing + prompt caching; embed selectively.
- Memory growth unbounded. ✅ Cap, consolidate, evict.
- Guild growth → **shard at 2,500**; stateless bot; move vectors pgvector→Qdrant when filtered-search latency bites; read-replicas for Postgres; queue heavy tool work.

---

## 11. MVP → Production Plan (phased)

| Phase | Timeline | Scope | Exit criteria |
|---|---|---|---|
| **0 · Plumbing** | Wk 0–1 | Bot online; slash cmd + mention listener; single LLM call; defer/chunk; structured logging; Docker deploy | Bot replies in a test server, logs every turn |
| **1 · MVP chat** | Wk 1–3 | Natural conversation; **short-term memory** (Redis window + rolling summary); **5–20 tools loaded directly**; moderation in/out; per-channel context; dual-model cheap/frontier split | Feels conversational; basic tools work; nothing toxic ships |
| **2 · Memory + knowledge + scale tools** | Wk 3–6 | **Long-term memory** (Mem0/pgvector, ADD/UPDATE/DELETE); **per-guild RAG** (contextual retrieval + hybrid + rerank); **tool retrieval router** for 50→400 tools; Langfuse; **eval harness** | Remembers across sessions; answers from server docs; routes 400 tools at target recall@k |
| **3 · Orchestration + ops** | Wk 6–10 | **LangGraph** graph (router/planner/executor/critic); HITL approval for risky tools; idempotency/circuit-breakers; sharding; Prometheus/Grafana/Sentry dashboards; red-team pass | Multi-step actions work; p95 latency & cost within budget; passes safety eval; survives restarts |
| **4 · Optional optimization** | Ongoing | Collect 👍/👎 → **DPO/GRPO**; **LoRA** a small router/persona model (Unsloth); self-host via **vLLM** if cost demands; A/B vs API baseline | Measurable cost/latency win **without** quality regression on eval set |

**Golden rule:** every phase ships behind the **eval gate** from Phase 2. Don't advance on vibes — advance on the regression set.

---

## Sources
- BFCL v4 leaderboard — https://gorilla.cs.berkeley.edu/leaderboard.html · https://llm-stats.com/benchmarks/bfcl-v4
- RAG-MCP (arXiv:2505.03275) — https://arxiv.org/abs/2505.03275
- Anthropic advanced tool use / Tool Search — https://www.anthropic.com/engineering/advanced-tool-use · https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Arcade tool-search real-world test — https://www.arcade.dev/blog/anthropic-tool-search-4000-tools-test/
- Open-source LLMs 2026 — https://huggingface.co/blog/daya-shankar/open-source-llms · https://www.bentoml.com/blog/navigating-the-world-of-open-source-large-language-models
- TOUCAN dataset (arXiv:2510.01179) — https://arxiv.org/pdf/2510.01179 · `Agent-Ark/Toucan-1.5M`
- xLAM function-calling 60k — https://huggingface.co/datasets/Salesforce/xlam-function-calling-60k
- ToolBench / ToolLLM — https://github.com/OpenBMB/ToolBench · https://arxiv.org/abs/2307.16789
- API-Bank — https://arxiv.org/pdf/2304.08244
- Conversational datasets — https://huggingface.co/datasets/allenai/WildChat-1M · https://huggingface.co/datasets/lmsys/lmsys-chat-1m · UltraChat (arXiv:2305.14233)
- Agent memory landscape — https://agentmarketcap.ai/blog/2026/04/10/agent-memory-vendor-landscape-2026-letta-zep-mem0-langmem · https://mem0.ai/blog/state-of-ai-agent-memory-2026
- Embeddings 2026 — https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models · https://milvus.io/blog/choose-embedding-model-rag-2026.md
- Vector DB comparison — https://callsphere.ai/blog/vector-database-benchmarks-2026-pgvector-qdrant-weaviate-milvus-lancedb
- Agent frameworks — https://gurusup.com/blog/best-multi-agent-frameworks-2026 · https://qubittool.com/blog/ai-agent-framework-comparison-2026
- Anthropic Contextual Retrieval — https://www.anthropic.com/news/contextual-retrieval
- Semantic routing — https://github.com/aurelio-labs/semantic-router · https://vllm-semantic-router.com/
- Llama Guard / LlamaFirewall — https://arxiv.org/pdf/2312.06674 · https://arxiv.org/pdf/2505.03574
- Fine-tuning frameworks — https://www.spheron.network/blog/axolotl-vs-unsloth-vs-torchtune/ · https://unsloth.ai/docs/get-started/fine-tuning-llms-guide/lora-hyperparameters-guide
- Serving (vLLM/TGI/Ollama) — https://www.hivenet.com/post/vllm-vs-tgi-vs-tensorrt-llm-vs-ollama
- Discord ToS / Developer Policy — https://discord.com/terms · https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy
- Discord LLM bot reference (llmcord) — https://github.com/jakobdylanc/llmcord · Discord LLMOps — https://www.zenml.io/llmops-database/building-and-scaling-llm-applications-at-discord
