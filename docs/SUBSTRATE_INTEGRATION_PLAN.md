# Custom-LLM ↔ Substrate — End-to-End Program Map

> **Status:** planning only. Nothing here is built yet. This maps the full path
> from today (bot code complete, no infra running) to "the bot is logging real
> interactions into Substrate on the rack."
>
> **Sensitivity note:** this doc intentionally avoids Substrate's secret file
> paths, role-naming internals, crypto details, and the other tenants on that
> Postgres box. Keep it that way if you ever commit it to the public repo.

---

## 1. Goal & current state

**Goal:** the Custom-LLM Discord bot, running **off-box** (not on the rack),
persists every conversation / tool call / training example into a **Substrate**
project database hosted on your server rack — so real data accumulates for an
eventual fine-tune.

**Current state (2026-06-03):**

| Piece | State |
|---|---|
| Bot code (Prisma → Postgres, tools, memory, training capture) | ✅ complete, 63 tests green |
| Bot deps + Prisma client | ✅ installed/generated locally |
| Synthetic dataset (`exports/training/synthetic-tools.jsonl`) | ✅ 86 examples generated |
| Substrate on the rack | ❌ **not stood up** (no PG17 / services / tunnel yet) |
| Substrate project for the bot | ❌ not provisioned |
| Bot ↔ Substrate wiring | ❌ not started |
| LLM endpoint | ⏸️ deferred (your call) |
| Discord bot token | ❌ not created |

**The honest headline:** four independent things must all be true before a
single real row is logged — (a) Substrate is live, (b) a project exists, (c) the
bot can reach it, (d) the bot has an LLM + a Discord token. (a) is a real
buildout and it can only happen **on the rack**.

---

## 2. The critical path (overview)

```
Phase 1  Stand up Substrate on the rack      ── rack-only; biggest single task
Phase 2  Provision the `customllm` project   ── one authenticated API call
Phase 3  Connect the bot  (choose B1 or B2)   ── B2 recommended (no rewrite)
Phase 4  Apply schema + confirm data model    ── Prisma migrate (B2) / migrations endpoint (B1)
Phase 5  LLM endpoint + Discord token         ── the other two gates to "data flows"
Phase 6  Run, verify logging, export, migrate ── data accumulates; later → fine-tune
```

Phases 1, 5 (Discord token), and the LLM decision are **independent** — they can
proceed in parallel.

---

## 3. Phase 1 — Stand up Substrate on the rack

This is Substrate's own documented setup (its `docs/RUNBOOK.md`). It is
**Windows Server + PostgreSQL 17** and must run on the rack. Maturity is good:
Substrate's phases 0–4 are green and a live end-to-end provision→serve→teardown
has been proven on the box, so this is "follow the runbook," not "finish the
product."

**Sequence (high level — exact commands live in Substrate's RUNBOOK):**

1. **Prereqs on the rack:** Node ≥ 22, PostgreSQL 17 (server + `psql`), the DPAPI
   secret tooling, and the PG superuser password staged where the bootstrap
   script expects it.
2. **One-time platform bootstrap** (`bootstrap-platform.ps1`, gated, idempotent):
   creates the two privilege-tier roles + the `platform_control` metadata DB,
   applies its migrations, and seals the role passwords + master KEK as DPAPI
   blobs. *Never* run as the app; never overwrite the KEK on re-run.
3. **pg_hba** (`configure-pg-hba.ps1`, as Administrator): admits only the
   platform's role group over TLS on **loopback**. ← This is the line item B2
   has to extend (see Phase 3).
4. **Run the two services** (control-plane on `:8090`, engine on `:8000`) wired
   to the sealed credential blobs — under **NSSM** as auto-restart Windows
   services.
5. **Seed an admin** (`seed-admin.ps1`) → admin login → **enroll TOTP** (MFA is
   mandatory) → you now have an `aal2` session. Optionally **mint a scoped API
   key** (`projects:create`, `migrations:apply`) for non-interactive calls.
6. **Cloudflare tunnel** (`cloudflare-tunnel-install.ps1` + config template):
   exposes the engine's REST surface over HTTPS so an off-box client can reach
   it. (Only needed for B1, or for any remote REST use.)

**What I can do from here:** write you a tightened, step-by-step runbook keyed to
your exact scripts, and pre-stage any config/env templates. **What I can't:**
run any of it — it needs the rack, the superuser, and your TOTP device.

**Risk watch:** shared Postgres box (other tenants live there); the bootstrap
re-run password caveat; TOTP device enrollment; tunnel DNS/hostname setup.

---

## 4. Phase 2 — Provision the `customllm` project

One call against the control plane (aal2 admin token **or** a `projects:create`
API key):

```
POST /v1/projects   { "ref": "customllm" }
→ 201 { ref, api_base_url, anon_key, service_key }   # anon/service keys shown ONCE
```

This creates an isolated `proj_customllm` database with its own owner / app /
realtime roles. **Capture the keys immediately** — they are never recoverable in
plaintext. For **B2** you'll additionally need the project **owner** DB password
(see Phase 3, B2).

---

## 5. Phase 3 — Connect the bot (the real fork)

The bot is **Prisma-native**: it speaks the Postgres wire protocol and runs DDL
migrations. Substrate exposes a **Supabase-compatible REST API** but its raw
Postgres is **loopback-only** by default. Two ways to bridge that, given the bot
runs off-box:

### B2 — Private network link + direct Postgres ✅ recommended

Put the rack and the bot's host on one private network (**Tailscale** or
WireGuard), then let the bot connect straight to `proj_customllm` over the
private IP.

**Work involved:**
- Install Tailscale on the rack + the bot host (same tailnet). *(trivial)*
- On the rack: have Postgres **listen** on the tailnet interface (it's currently
  loopback-bound) and add **one pg_hba rule** admitting the platform role group
  from the tailnet subnet over TLS (scram-sha-256) — a small, surgical extension
  of `configure-pg-hba.ps1`. *(small, careful)*
- Get the project **owner** password out: Substrate seals it and has **no
  built-in DSN printer** (`get-project.ts` never returns secrets). I'd add a tiny
  admin-only helper to the Substrate repo (uses its existing `@substrate/shared`
  crypto to unseal and print a `postgresql://…` conninfo). *(small; needs your
  OK — it touches the private repo)*
- Bot: set `DATABASE_URL=postgresql://<owner>:<pw>@<rack-tailnet-ip>:5432/proj_customllm?sslmode=require`,
  run `prisma migrate deploy`, start the bot. **Zero bot code changes.**

**Pros:** no rewrite; Prisma migrations "just work" (owner role owns the DB);
keeps memory/pgvector option open; Postgres never exposed to the public internet.
**Cons:** depends on a private-network link; one rack-side pg_hba/listen change.

### B1 — REST API via supabase-js (over the tunnel)

Use `api_base_url` + `service_key` + `x-project-ref: customllm` with
`@supabase/supabase-js`.

**Work involved — a genuine rewrite of the persistence layer:**
- Replace Prisma in **5 repositories** + the client init + app wiring:
  - `src/database/prisma.ts`
  - `src/database/repositories/{Conversation,Guild,ToolLog,TrainingExample,User}Repository.ts`
  - call sites in `src/index.ts`, `src/ai/orchestration/AgentController.ts`
  - (`src/memory/PgVectorMemoryStore.ts` too, **only** if you move off
    `VECTOR_STORE=memory` — pgvector over PostgREST needs RPC functions)
- Apply the bot schema via `POST /v1/projects/customllm/migrations` (feed it the
  Prisma-generated SQL) before any REST call — PostgREST derives its API from the
  live schema.
- Handle the impedance mismatches: Prisma `cuid()` IDs are generated client-side
  (PostgREST won't), `Json` columns, enums, `updatedAt` triggers, and using the
  `service_role` key to bypass RLS for writes.

**Pros:** "Substrate-native"; uses the tunnel you already have; no private-network
dependency. **Cons:** largest code change + ongoing maintenance; awkward for
vector memory; more failure surface.

### Verdict

**Go B2.** For an app whose only need is "persist relational rows + run
migrations," a private link + direct Postgres is dramatically less work than
rewriting every repository, and it keeps the door open for pgvector memory later.
Reserve B1 for if you specifically want the bot to consume Substrate purely as a
public REST product.

---

## 6. Phase 4 — Schema & data-model fit

- **B2:** `npx prisma migrate deploy` against the project DB. The init migration
  (`prisma/migrations/20260603000000_init`) is plain Postgres (no pgvector
  extension required) and the owner role owns the DB, so this is clean.
- **B1:** push the same SQL through the migrations endpoint; then the bot writes
  via supabase-js. Verify enum types, JSON columns, and ID generation behave.
- Either way, the bot's tables (`Conversation`, `ToolLog`, `TrainingExample`,
  `Memory`, profiles, `UserFeedback`, `ToolDefinitionRecord`) coexist fine with
  Substrate's per-project infra schema (auth/etc.).

---

## 7. Phase 5 — The other two gates to "data actually flows"

Logging needs the bot to **run and respond**, which means:

1. **LLM endpoint** *(currently deferred).* Options when you're ready: local
   Ollama (a 3B fits your 4 GB GPU; 7B will be slow), or any OpenAI-compatible
   cloud endpoint. The bot supports both via `LLM_PROVIDER`.
2. **Discord bot token.** Create an app at the Discord Developer Portal, enable
   the **Message Content intent**, invite the bot to a server, paste the token
   into `.env` (`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`). See `docs/DISCORD_SETUP.md`.

Without both, the DB is wired but no interactions are generated.

---

## 8. Phase 6 — Run, verify, and (if decoupled) migrate

- Start the bot (`npm run dev`), confirm rows land (`/stats`, `/health`, or query
  the project DB).
- Let real interactions accumulate (Substrate's plan target: thousands; quality
  over quantity).
- Export with `npm run export:training` (now that a real DB is connected) →
  ChatML / Alpaca / tool-calling / DPO JSONL.
- **If you ever run a temporary bridge DB first** (the "decouple" option), migrate
  rows into `proj_customllm` with a one-off dump/restore or a small ETL — the
  schema is identical, so it's a straight copy.

---

## 9. Effort & sequencing summary

| Phase | Where | Size | Blocks data? |
|---|---|---|---|
| 1 — Substrate standup | Rack | **L** (mostly following the runbook) | Yes |
| 2 — Provision project | Rack/API | S | Yes |
| 3 — Connect bot (B2) | Rack + bot | **M** (Tailscale + 1 pg_hba rule + DSN helper) | Yes |
| 3 — Connect bot (B1) | Bot | **L** (rewrite 5 repos + wiring) | Yes |
| 4 — Schema apply | Bot | S | Yes |
| 5 — LLM | Bot/rack | S–M | Yes |
| 5 — Discord token | You | S | Yes |
| 6 — Run/verify/export | Bot | S | — |

**Fastest route to first real data:** Phase 1 + 5 in parallel → 2 → 3(B2) → 4 →
run. The long pole is **Phase 1** (the rack buildout).

---

## 10. Open decisions

1. **Sequencing:** substrate-first (above), or decouple onto a temporary DB to
   start collecting while the rack is built? (You chose "map it" — this is still
   open.)
2. **B2 vs B1** — recommend **B2**; confirm before any code.
3. **OK to add the small DSN-printer helper to the private Substrate repo?** (B2.)
4. **LLM choice** — still deferred.
5. **Where should this plan live?** Currently uncommitted in `docs/`. Options:
   keep local, move to the private Substrate repo, or commit a (sanitized) copy
   here.

---

## 11. What I can start on now (no rack required)

- A tightened, script-by-script **Substrate standup runbook** for the rack.
- The **B2 networking change** spec'd exactly (listen_addresses + the pg_hba
  line) + the **DSN-printer helper** for the Substrate repo.
- A **Discord app setup** walkthrough so the token is ready.
- (If you decouple) wire a temporary DB so the bot logs **today**, unchanged.
