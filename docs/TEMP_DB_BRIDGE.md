# Temporary DB Bridge — start collecting data TODAY

> **Purpose:** get a Postgres under the bot **right now**, so it can persist
> conversations / tool calls / training examples while **Substrate** (the
> intended permanent home — see [`SUBSTRATE_INTEGRATION_PLAN.md`](./SUBSTRATE_INTEGRATION_PLAN.md))
> is still being built on the rack.
>
> **Everything here is a TEMPORARY bridge.** You are local-first; Substrate is
> the eventual permanent home. None of the options below is a destination — they
> exist only to unblock data collection during the rack buildout, after which you
> migrate the rows over (see §5). This doc does **not** provision anything and
> does **not** pick a cloud vendor for you — it lays out the choices and the exact
> steps **you** run.
>
> **Sensitivity:** this file may live in the public repo. It contains **no
> secrets and no real connection strings** — every credential below is a
> `<placeholder>`. Keep it that way. Your real connection string goes only in
> `.env`, which is git-ignored.

---

## 0. Why this works with zero bot changes

The bot is **Prisma → Postgres** and reads its connection from a single env var:

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

`src/database/prisma.ts` passes that same `DATABASE_URL` to the client
explicitly. The init migration (`prisma/migrations/20260603000000_init/`) is
**plain Postgres DDL** — standard `TEXT` / `JSONB` / `INTEGER` columns, four
enums, and indexes. **No extensions** (no `pgvector`, no `uuid-ossp`) are
required, because the temp setup runs with `VECTOR_STORE=memory`.

**Consequences:**

- **Any** Postgres (v14–17, hosted or local) works.
- The only thing you change is **one line in `.env`** (`DATABASE_URL`).
- Applying the schema to a brand-new, empty database is one command:
  `npx prisma migrate deploy`. **No bot code is touched.** *(Verified: see §6.)*

---

## 1. Options compared (all TEMPORARY)

| | Time to first row | Installs anything? | Survives reboot? | Reachable off your machine? | Best when… |
|---|---|---|---|---|---|
| **(1) Neon** (free serverless Postgres) | ~3 min, browser only | No | Yes (cloud) | Yes | You want zero install **today** and don't want a daemon running locally |
| **(2) Local PostgreSQL 17** (native Windows) | ~15–25 min (installer + first-run) | Yes (DB server + service) | Yes (Windows service) | No (localhost) | You'd rather keep data on-disk, local-first, no cloud account |
| **(3) Supabase free tier** (hosted Postgres) | ~5 min, browser + project spin-up | No | Yes (cloud) | Yes | Same as Neon; pick if you already have a Supabase account |

Notes that matter for **this** bot:

- All three are ordinary Postgres on the wire, so `prisma migrate deploy` and the
  bot behave identically against any of them.
- Options (1) and (3) are **cloud**. You are local-first and you have **no Docker,
  no local Postgres, and no WSL** installed today. That's exactly why a hosted
  option is attractive as a *bridge*: nothing to install. But it is still a
  bridge — your data lands on someone else's box until you migrate to Substrate.
- Option (2) keeps everything on your machine (more in line with local-first) at
  the cost of a ~250 MB installer and a background Windows service. Reasonable if
  you'd rather not put even throwaway data in the cloud.
- **Docker is intentionally omitted** as a recommendation: the repo ships a
  `docker-compose.yml` with a Postgres service, but you have no Docker installed
  and installing Docker Desktop is heavier than any option above. If you *do*
  later install Docker, `docker compose up -d postgres` + the same
  `migrate deploy` is a fourth bridge — but don't install Docker just for this.

### Recommendation

**Neon (option 1) as the temporary bridge** — *if* you accept throwaway data
living briefly in the cloud. It is the lowest-friction path to "the bot is
storing data today": no install, no daemon, instant, and trivially deleted once
you cut over to Substrate. The data is temporary and you control deletion, so the
cloud exposure is bounded.

**If you'd prefer to stay fully local** (no cloud account at all), pick **local
PostgreSQL 17 (option 2)** — steps in §4. Both reach the identical end state
(schema applied, bot logging); they differ only in install effort vs. cloud
exposure. **This is your call — the doc does not make it for you.**

The rest of §2–§3 walks the **Neon** path in full because it's the recommended
default; §4 covers the local alternative.

---

## 2. Neon: get a connection string (the one gotcha that bites Prisma)

Neon gives every project **two** kinds of connection string, and the difference
**matters for migrations**:

| String | Host looks like | Use it for |
|---|---|---|
| **Pooled** (default shown in the dashboard) | `...-pooler.<region>.aws.neon.tech` | the **running bot** (normal queries) |
| **Direct / unpooled** | `...<region>.aws.neon.tech` (no `-pooler`) | **`prisma migrate deploy`** (DDL) |

**Why:** the pooled host is a **PgBouncer** connection pooler. Prisma's migrate
engine runs DDL and uses session-level features that a transaction pooler doesn't
support, so running `migrate deploy` against the **pooled** string can hang or
error. Run migrations against the **direct/unpooled** string.

Both strings also need **`?sslmode=require`** — Neon only accepts TLS
connections. The dashboard usually includes it; if you copy a bare string, append
it yourself.

> Concretely, after you sign in and create a project, the Neon dashboard shows a
> "Connection string" with a **Pooled connection** toggle. Copy it **with**
> pooling for the bot, and copy it **without** pooling (toggle off) for the
> migrate step. Both end in `?sslmode=require`.

Shapes (placeholders — **not** real credentials):

```
# DIRECT / UNPOOLED — use for `prisma migrate deploy`
postgresql://<user>:<password>@ep-xxxx-xxxx.<region>.aws.neon.tech/<db>?sslmode=require

# POOLED — use as the bot's normal DATABASE_URL
postgresql://<user>:<password>@ep-xxxx-xxxx-pooler.<region>.aws.neon.tech/<db>?sslmode=require
```

---

## 3. Recommended path — exact steps (Neon)

Run these from the repo root (`C:\Users\<you>\Desktop\Custom LLM\...`) in
PowerShell. The Prisma client is **already generated** in this repo, so
`prisma generate` is optional (shown for completeness).

**Step 1 — get the two strings.** Create a free Neon project in the browser and
copy both the **pooled** and **direct/unpooled** strings (see §2). Both end in
`?sslmode=require`.

**Step 2 — point `.env` at the bridge.** Edit the existing `.env` and replace the
`DATABASE_URL` line. For the everyday value, use the **pooled** string:

```dotenv
# .env  (git-ignored — safe place for the real string)
DATABASE_URL=postgresql://<user>:<password>@ep-xxxx-xxxx-pooler.<region>.aws.neon.tech/<db>?sslmode=require
```

Leave `REDIS_URL`, `VECTOR_STORE=memory`, etc. exactly as they are — the bridge
only concerns Postgres.

**Step 3 — (optional) regenerate the Prisma client.** Already done in this repo;
only needed if `node_modules` was wiped:

```powershell
npx prisma generate
```

**Step 4 — apply the schema using the DIRECT string.** Because `migrate deploy`
needs the unpooled connection, override `DATABASE_URL` **just for this one
command** so you don't have to edit `.env` twice:

```powershell
# PowerShell: set the env var for this single invocation, then run migrate
$env:DATABASE_URL = "postgresql://<user>:<password>@ep-xxxx-xxxx.<region>.aws.neon.tech/<db>?sslmode=require"
npx prisma migrate deploy
Remove-Item Env:\DATABASE_URL   # drop the override; .env's pooled value resumes
```

You should see Prisma apply migration `20260603000000_init`. (If you used the
pooled string here by mistake and it hangs, that's the §2 gotcha — switch to the
direct string.)

> If you chose to keep the **pooled** string as `.env`'s `DATABASE_URL` (Step 2)
> *and* you don't want to set an override, an alternative is to temporarily put
> the **direct** string in `.env`, run `migrate deploy`, then switch `.env` back
> to pooled for running the bot. The single-command override above just saves
> that round trip.

**Step 5 — smoke-test (confirm tables exist).** Two ways:

- **Helper script** (read-only, ships in this repo — see §7):

  ```powershell
  npx tsx scripts/check-db.ts
  ```

  It pings the DB and prints a row count per table (all zeros on a fresh DB,
  which is the expected, healthy result). It uses `.env`'s `DATABASE_URL`, so the
  pooled string is fine here.

- **Or** with Prisma directly (no extra files):

  ```powershell
  npx prisma db execute --stdin
  ```

  then paste and Ctrl-Z / Enter:

  ```sql
  SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
  ```

  You should see `Conversation`, `ToolLog`, `TrainingExample`, `Memory`,
  `UserProfile`, `GuildProfile`, `ChannelProfile`, `UserFeedback`,
  `ToolDefinitionRecord`, plus Prisma's `_prisma_migrations`.

Once the tables exist, **`npm run export:training` will reach the DB** (it exits
with an error if the DB is unreachable, and writes JSONL once it can connect).
There will simply be nothing to export until real interactions accumulate — which
needs the two gates in §8.

---

## 4. Alternative path — local PostgreSQL 17 (Windows, fully local)

If you'd rather not use the cloud at all:

1. **Install.** Download the EDB PostgreSQL **17** installer for Windows, run it,
   set a password for the `postgres` superuser, keep port **5432**. This installs
   a background **Windows service** (auto-starts on boot) and the `psql` client.
2. **Create a database** for the bot (using the bundled SQL shell or `psql`):

   ```sql
   CREATE DATABASE custom_discord_ai;
   ```

3. **Point `.env`** at it. The repo's default already matches this shape — just
   set the password you chose:

   ```dotenv
   DATABASE_URL=postgresql://postgres:<your-password>@localhost:5432/custom_discord_ai
   ```

   No `sslmode` needed for a local server, and there's no pooled/direct split —
   so `prisma migrate deploy` uses this same string.
4. **Apply schema + smoke-test:**

   ```powershell
   npx prisma migrate deploy
   npx tsx scripts/check-db.ts
   ```

Done — identical end state to the Neon path, with data on your own disk.

---

## 5. Later: migrate the bridge data into Substrate

This is intentionally short because the schema is **identical** on both sides
(same `prisma/migrations` produce both), so it's a straight data copy. When
Substrate's `proj_customllm` database is live (per `SUBSTRATE_INTEGRATION_PLAN.md`
Phase 4):

1. **Apply the schema on the Substrate side first** — either `prisma migrate
   deploy` against `proj_customllm` (the B2 path: owner role owns the DB), or push
   the same SQL through Substrate's `migrations` endpoint (the B1 path).
2. **Dump data-only from the bridge** (no schema, no ownership):

   ```powershell
   pg_dump --data-only --no-owner --no-privileges "<bridge-direct-connection-string>" > bridge-data.sql
   ```

   *(Use the **direct/unpooled** string for Neon. `pg_dump` ships with the local
   PostgreSQL install from §4; that's the simplest way to have the tool on
   Windows.)*
3. **Load into `proj_customllm`:**

   ```powershell
   psql "<proj_customllm-connection-string>" -f bridge-data.sql
   ```

Because the table definitions match exactly, rows transfer 1:1 (CUID primary keys
are plain `TEXT`, so there are no sequence/identity collisions to reconcile).
After verifying counts (rerun `check-db.ts` against `proj_customllm`), point the
bot's `.env` at `proj_customllm` and retire the bridge (delete the Neon project /
drop the local DB).

---

## 6. Verification (was the "zero code change" claim true?)

Confirmed against this repo on 2026-06-03:

- **`schema.prisma`** — datasource `provider = "postgresql"`, `url =
  env("DATABASE_URL")`. Nothing else selects a database.
- **`src/database/prisma.ts`** — instantiates `PrismaClient` with
  `datasources.db.url = env.DATABASE_URL`. The connection is fully determined by
  that one env var.
- **`prisma/migrations/20260603000000_init/migration.sql`** — plain Postgres DDL
  only (`TEXT`, `JSONB`, `INTEGER`, `BOOLEAN`, `TIMESTAMP(3)`, four `CREATE TYPE`
  enums, indexes). **No `CREATE EXTENSION`**, so a vanilla Postgres needs no
  pre-setup. `migration_lock.toml` provider is `postgresql`.
- **`package.json`** — `prisma:migrate` = `prisma migrate deploy`,
  `export:training` = `tsx scripts/export-training-data.ts`. Prisma CLI 6.19.3;
  client already generated under `node_modules/.prisma/client`.
- **Runtime probe** — running `scripts/check-db.ts` against the current
  (unreachable) localhost DB fails cleanly with "Can't reach database server at
  `localhost:5432`", confirming the bot's connection path is driven entirely by
  `DATABASE_URL` and degrades gracefully when it's wrong.

**Verdict: yes — the bot works against any Postgres with only a `.env` change.**
The **one gotcha** is Neon-specific: use the **direct/unpooled** `?sslmode=require`
string for `prisma migrate deploy` (the pooled PgBouncer endpoint can hang/fail on
DDL), then the **pooled** string for the running bot. Local Postgres (§4) has no
such split.

---

## 7. The helper script

`scripts/check-db.ts` (new, read-only) pings `DATABASE_URL` and prints a row count
per table. It imports the bot's **existing** Prisma client (`getPrisma` /
`closeDatabase` from `src/database/prisma.ts`) and performs only `SELECT
count(*)` — **no writes, no migrations, no changes to any existing file.** Run it:

```powershell
npx tsx scripts/check-db.ts
```

- Fresh DB, schema applied → all counts `0` (healthy).
- Connected but schema missing → it flags the missing tables and tells you to run
  `npx prisma migrate deploy`.
- Unreachable → clear error pointing you back to `DATABASE_URL`.

> It is invoked via `npx tsx …` (not `npm run …`) on purpose: adding an `npm`
> script would mean editing `package.json`, and the bot is intentionally kept
> unchanged.

---

## 8. Still blocked: the temp DB only removes the STORAGE gate

A live Postgres means rows **can** be stored — it does **not** mean rows **will**
be generated. The bot only writes a conversation/tool/training row when it
actually handles a Discord interaction, which requires **two more gates that are
still open**:

1. **An LLM endpoint** — *currently deferred by you.* Without it the bot can't
   produce assistant responses, so no conversation/training rows are created.
   (Configured via `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_MODEL` in `.env`; see
   `docs/LOCAL_LLM_SETUP.md`.)
2. **A Discord bot token** — *not yet created.* Without `DISCORD_TOKEN` /
   `DISCORD_CLIENT_ID` the bot can't log in or receive messages. (See
   `docs/DISCORD_SETUP.md`.)

**So:** this bridge unblocks **storage only**. Real data starts flowing once the
temp DB **and** an LLM endpoint **and** a Discord token are all in place. Until
then the schema is live and waiting, and `check-db.ts` / `export:training` will
report empty tables.
