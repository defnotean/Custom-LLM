# Substrate — Standup Runbook (rack edition)

A tightened, ordered, copy-pasteable sequence to stand up [substrate](https://github.com/defnotean/substrate)
on the server rack and prove the live loop. Keyed to substrate's **actual**
scripts — script names, flags, ports, and SQL below match the repo. This is a
condensed operator checklist; the canonical narrative is substrate's own
`docs/RUNBOOK.md`.

**Target:** Windows Server + PostgreSQL 17, loopback-bound + TLS-required.
All commands are **PowerShell**, run from the substrate repo root unless noted.

> **Secret hygiene (read first).** Every generated password and the master KEK
> live only as **DPAPI-sealed `.dpapi` blobs** in your secrets directory; the
> superuser password lives in the **superuser password file the scripts expect**
> (a bare password or a full `postgres://…` URL). This runbook never prints
> secret values and never hard-codes their paths — substrate's scripts default
> those paths internally; override with the documented flags if your layout
> differs. A `.dpapi` blob can only be unsealed on the **same machine, under the
> same LocalMachine scope** that sealed it — plan KEK custody accordingly.

---

## 0. Prerequisites

Verify all of these **before** step 1:

- [ ] **Node ≥ 22** and **PostgreSQL 17** (server cluster + client `psql.exe`,
      default `C:\Program Files\PostgreSQL\17\bin\psql.exe`).
- [ ] Postgres is **loopback-bound** (`127.0.0.1` / `::1`) and **TLS-required**
      (existing `hostnossl … reject` rules); a self-signed local cert is fine.
- [ ] The **DPAPI tooling** is present in your secrets directory
      (`Protect-Secret.ps1`, `Unprotect-Secret.ps1`, `_dpapi-common.ps1`).
      The bootstrap **fails fast** without `Protect-Secret.ps1`.
- [ ] The **superuser password file the scripts expect** exists and is non-empty
      (bare password **or** a full `postgres://…` URL).
- [ ] You run as an account that can **DPAPI-protect under the same LocalMachine
      scope the services use** (so sealed blobs are unsealable by the services).
- [ ] Workspace deps installed once:

```powershell
npm install
```

> This Postgres box is **shared** with other tenants. Everything substrate does
> is scoped to its own roles/DBs (`platform_*`, `proj_<ref>_*`) and the
> `substrate_roles` group — nothing here touches unrelated roles or databases.

---

## 1. One-time platform bootstrap (superuser)

The gated, owner-run step. The control-plane app **never** runs this and **never**
connects as the superuser. **Idempotent** and safe to re-run (mind the caveat).

```powershell
powershell -File packages\control-plane\scripts\bootstrap-platform.ps1
# optional flags:
#   -PsqlPath <path>        psql location (default PG17 install path)
#   -PgHost <host>          default localhost
#   -PgPort <port>          default 5432
#   -ForceRewriteRolePw     re-seal the two role-password blobs (see caveat)
```

**What it does** (`scripts/bootstrap-platform.ps1`):

1. Locates `psql`, forces `sslmode=require`, reads the superuser password from
   the file it expects.
2. Generates ≥32-char random passwords for **`platform_provisioner`** (T1:
   `LOGIN CREATEDB CREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS`, conn-limit 4)
   and **`platform_meta`** (T2: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
   NOREPLICATION NOBYPASSRLS`, conn-limit 20), with per-role
   `statement_timeout=30s` / `idle_in_transaction_session_timeout=15s` /
   `lock_timeout=5s`. Role DDL is fed over **stdin**, so passwords never hit argv
   or a temp file.
3. `CREATE DATABASE platform_control OWNER platform_meta` (guarded), then locks
   `CONNECT` to `platform_meta` only (PUBLIC + provisioner revoked).
4. Applies `packages\control-plane\migrations\*.sql` in name order with
   `ON_ERROR_STOP=1` (schema `0010`, RLS `0020`, realtime-enabled `0030`,
   teardown-tokens `0040`).
5. Seals the two role passwords **and a fresh 32-byte master KEK** as DPAPI
   blobs in your secrets directory. **The KEK is never overwritten on re-run**
   (that would orphan every previously-wrapped secret); role-password blobs are
   re-sealed only with `-ForceRewriteRolePw`.
6. Prints a no-plaintext connection model.

> ### ⚠ Re-run caveat (documented in the script)
> The script **re-sets both role passwords in Postgres to new random values on
> every run.** If you re-run **without** `-ForceRewriteRolePw`, the existing
> sealed blobs will **no longer match** the live passwords and the services will
> fail to connect. Rule of thumb: re-run **with** `-ForceRewriteRolePw` when you
> intend to rotate (and restart the services after), and don't casually re-run
> it against a live deployment otherwise.

**VERIFY before moving on:**

- [ ] Final banner reads `control-plane bootstrap complete`.
- [ ] Three sealed blobs now exist in your secrets directory:
      `the provisioner password blob`, `the metadata password blob`,
      `the master-key blob`.
- [ ] Migrations report applied: `0010…, 0020…, 0030…, 0040…`.

---

## 2. Admit substrate's roles through pg_hba (superuser, Administrator)

Run **once**, as Administrator, **after** bootstrap. Because `pg_hba.conf`
cannot wildcard a role name but substrate mints new `proj_<ref>_*` roles at
provision time, this creates a `substrate_roles` **group** and admits only its
members — without loosening auth for the box's other tenants.

```powershell
powershell -File packages\control-plane\scripts\configure-pg-hba.ps1
#   -PsqlPath / -PgHost / -PgPort as above
#   -SuperuserPwFile <path>   override the superuser password file location
```

**What it does** (`scripts/configure-pg-hba.ps1`):

1. Creates `NOLOGIN` group role **`substrate_roles`** (idempotent); grants it to
   `platform_meta`, and to `platform_provisioner` **WITH ADMIN OPTION** (so the
   provisioner can add each new project's roles to the group during
   provisioning).
2. Locates `pg_hba.conf` (`SHOW hba_file`), writes a **timestamped backup**,
   then inserts — before the catch-all `reject` — rules admitting **only**
   `+substrate_roles` over TLS (`scram-sha-256`) on loopback:

   ```text
   hostssl     all          +substrate_roles   127.0.0.1/32   scram-sha-256
   hostssl     all          +substrate_roles   ::1/128        scram-sha-256
   host        replication  +substrate_roles   127.0.0.1/32   scram-sha-256
   host        replication  +substrate_roles   ::1/128        scram-sha-256
   ```
3. `SELECT pg_reload_conf();` (pg_hba changes need a **reload**, not a restart).

The insert is **idempotent** (guarded by a marker comment). Roles not in
`substrate_roles` are unaffected; the `replication` rules let per-project
`_realtime` roles attach CDC streams later.

**VERIFY:** output shows `pg_reload_conf() -> t`, the backup path, and the
"members of substrate_roles … admitted" line.

---

## 3. Configure + run the control-plane and engine under NSSM

On the rack the two Node services run under **NSSM** as **auto-restart**
services. (The repo also carries `scripts/install-windows-service.ps1`, a
**WinSW**-based installer — see the caveat in §10; the shape is the same: run
`node dist/<entry>.js` from the package dir with the env pointed at sealed
blobs.) Either way:

| Service            | Package                   | Entry              | Default port |
|--------------------|---------------------------|--------------------|--------------|
| `substrate-control`| `packages/control-plane`  | `node dist/index.js` | 8090       |
| `substrate-engine` | `packages/engine`         | `node dist/server.js`| 8000       |

> The live e2e smoke (`scripts/e2e-smoke.ps1`) treats **8000 / 8090 / 8100** as
> the box's live-service ports — keep production on those (or pick deliberately
> non-colliding ports) so the smoke test never clobbers a running service.

### 3a. Build both packages

```powershell
npm run build --workspace @substrate/control-plane
npm run build --workspace @substrate/engine
```

### 3b. Control-plane environment (prod, zero-plaintext)

Set these for the `substrate-control` service. **Production uses the `*_PW_FILE`
overlay** so passwords stay sealed: the referenced `.dpapi` blob is unsealed at
boot and spliced into the connection string's password slot (`src/config.ts`).
Point the file vars at the blobs the bootstrap wrote; leave the URL passwords
empty/placeholder when a `*_PW_FILE` is set.

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=8090
CORS_ORIGIN=https://api.<your-domain>      # comma-separated full URLs; "*" is rejected

# platform_meta → platform_control (password spliced in from CONTROL_DB_PW_FILE)
CONTROL_DATABASE_URL=postgresql://platform_meta@127.0.0.1:5432/platform_control
CONTROL_DB_PW_FILE=<the metadata password blob in your DPAPI secrets dir>

# platform_provisioner (DDL only; password spliced in from PROVISIONER_DB_PW_FILE)
PROVISIONER_DATABASE_URL=postgresql://platform_provisioner@127.0.0.1:5432/postgres
PROVISIONER_DB_PW_FILE=<the provisioner password blob in your DPAPI secrets dir>

# Lets createProject ALTER each per-project _realtime role to REPLICATION.
# Optional, but REQUIRED if you want per-project realtime to be enable-able.
BOOTSTRAP_SUPERUSER_URL=postgresql://postgres@127.0.0.1:5432/postgres
BOOTSTRAP_SUPERUSER_PW_FILE=<the superuser pw blob, if you seal it>

# Admin session signing key (HS256, ≥32 chars). Prefer the *_FILE form in prod.
ADMIN_JWT_SECRET_FILE=<a sealed admin-jwt blob>
#   (or ADMIN_JWT_SECRET=<≥32-char secret> for dev)

# Envelope-encryption master KEK: in PROD resolved from the DPAPI blob.
SUBSTRATE_SECRETS_DIR=<your DPAPI secrets directory>     # where Unprotect-Secret.ps1 + the master-key blob live
#   (dev only: SUBSTRATE_MASTER_KEY_B64=<base64 32-byte key>)

PSQL_PATH=C:\Program Files\PostgreSQL\17\bin\psql.exe
PROJECT_API_BASE=https://{ref}.<your-domain>             # MUST contain literal {ref}
# Optional caps: MAX_PROJECTS (default 100), MAX_REALTIME_PROJECTS (default 8)
```

> **Env-name caveat:** the bootstrap script's *printed* "suggested environment"
> uses split host/port/name vars (e.g. `CONTROL_DB_HOST`). The **app actually
> reads the names above** (`CONTROL_DATABASE_URL` + `CONTROL_DB_PW_FILE`,
> `PROVISIONER_DATABASE_URL` + `PROVISIONER_DB_PW_FILE`,
> `ADMIN_JWT_SECRET[_FILE]`, `BOOTSTRAP_SUPERUSER_URL[_PW_FILE]`), per
> `packages/control-plane/src/config.ts`. Use the app's names. A bad value
> **throws at boot** and the process exits non-zero.

### 3c. Engine environment

Set these for the `substrate-engine` service. The engine resolves provisioned
projects on demand via `CONTROL_DATABASE_URL`, and still needs a **default
project** config block plus the master KEK to open project secrets.

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=8000
CORS_ORIGIN=https://api.<your-domain>

# Resolve provisioned projects by x-project-ref from the registry.
CONTROL_DATABASE_URL=postgresql://platform_meta@127.0.0.1:5432/platform_control
SUBSTRATE_SECRETS_DIR=<your DPAPI secrets directory>     # the master-key blob + Unprotect-Secret.ps1

# Default-project block (engine boots even if this DB is unreachable when a
# control-plane loader is configured; an unreachable default is a warning).
DATABASE_URL=postgres://<default-project-app-role>@127.0.0.1:5432/<default-db>?sslmode=require
JWT_SECRET=<≥32 chars>            # default project only
WEBHOOK_SECRET=<value>
WEBHOOK_DISPATCH_TARGET=https://<your-app-domain>/api/<webhook-path>
# WEBHOOK_ALLOW_LOOPBACK_TARGETS stays false/unset in prod (SSRF guard)
```

### 3d. Install + start under NSSM (auto-restart)

Mirror the proven NSSM shape (substrate's `scripts/PHASE_6_CUTOVER.md` documents
this pattern). Repeat per service with its entry/dir/port; set the env from
3b/3c on the service (`nssm set <svc> AppEnvironmentExtra KEY=VALUE …`, or a
machine/service-scoped environment).

```powershell
# --- control plane ---
nssm install substrate-control "C:\Program Files\nodejs\node.exe" "<repo>\packages\control-plane\dist\index.js"
nssm set  substrate-control AppDirectory        "<repo>\packages\control-plane"
nssm set  substrate-control AppStdout           "<log-dir>\substrate-control.out.log"
nssm set  substrate-control AppStderr           "<log-dir>\substrate-control.err.log"
nssm set  substrate-control AppRotateFiles      1
nssm set  substrate-control AppRotateBytes      10485760
nssm set  substrate-control AppStopMethodConsole 35000
nssm set  substrate-control AppExit Default     Restart       # auto-restart on crash
nssm set  substrate-control AppRestartDelay     5000
nssm set  substrate-control DependOnService     postgresql-x64-17
nssm start substrate-control

# --- engine (same recipe, different entry/dir/port) ---
nssm install substrate-engine "C:\Program Files\nodejs\node.exe" "<repo>\packages\engine\dist\server.js"
nssm set  substrate-engine AppDirectory         "<repo>\packages\engine"
nssm set  substrate-engine AppStdout            "<log-dir>\substrate-engine.out.log"
nssm set  substrate-engine AppStderr            "<log-dir>\substrate-engine.err.log"
nssm set  substrate-engine AppRotateFiles       1
nssm set  substrate-engine AppRotateBytes       10485760
nssm set  substrate-engine AppStopMethodConsole 35000
nssm set  substrate-engine AppExit Default      Restart
nssm set  substrate-engine AppRestartDelay      5000
nssm set  substrate-engine DependOnService      postgresql-x64-17
nssm start substrate-engine
```

Both services drain their DB pools on graceful shutdown; `AppStopMethodConsole`
above gives them time. Optionally run each under a dedicated low-priv service
account (`nssm set <svc> ObjectName .\<svc-account> <password>` + grant
`SeServiceLogonRight` and ACLs) — defense-in-depth; both listen on loopback only.

**VERIFY both services are up:**

```powershell
Invoke-RestMethod http://127.0.0.1:8090/healthz     # control-plane liveness  -> {status: ok}
Invoke-RestMethod http://127.0.0.1:8090/readyz      # control-plane + metadata DB -> {status: ready}
Invoke-RestMethod http://127.0.0.1:8000/health/live # engine liveness -> {ok: true}
Invoke-RestMethod http://127.0.0.1:8000/health      # engine + default DB ping
```

- [ ] `/readyz` is `ready` (proves `platform_meta` can reach `platform_control`).
- [ ] `Get-Service substrate-control, substrate-engine` both show `Running`.

---

## 4. Seed the first admin (superuser, Administrator)

There is **no self-signup route** — the admin gates the whole platform — so the
first admin is seeded directly into the metadata DB.

```powershell
powershell -File packages\control-plane\scripts\seed-admin.ps1
#   prompts for email + password (≥12 chars, read as a SecureString)
#   -Email <addr>             skip the email prompt
#   -SuperuserPwFile / -ControlPlaneDir / -PsqlPath / -PgHost / -PgPort overridable
```

**What it does** (`scripts/seed-admin.ps1`): reads the password securely,
bcrypt-hashes it (**cost 12**, via the control-plane's own bcrypt, fed over
**stdin** — never argv/temp file), then inserts (or, on email conflict,
updates) a row in `platform_control.admin_users` with `mfa_required = true`,
`status = 'active'`. **Only the bcrypt hash is stored.** Re-running with the same
email **resets that admin's password**.

**VERIFY:** `Admin '<email>' seeded (id=…), MFA REQUIRED.`

---

## 5. Enroll TOTP → obtain an aal2 session

State-changing operations require an **aal2** session. Bootstrap MFA over the
API (the engine/control-plane is now running on `:8090`). At first enroll you're
at `aal1`, which is allowed only because there's no factor to bypass yet.

```powershell
$cp = 'http://127.0.0.1:8090'

# 1. Login → aal1 token
$aal1 = (Invoke-RestMethod -Method POST "$cp/v1/admin/login" `
  -ContentType 'application/json' `
  -Body (@{ email='<you@example.test>'; password='<password>' } | ConvertTo-Json)).access_token

# 2. Enroll a TOTP factor (Bearer aal1) → { factor_id, uri, secret }
$enroll = Invoke-RestMethod -Method POST "$cp/v1/admin/mfa/enroll" `
  -Headers @{ Authorization = "Bearer $aal1" }
# Add $enroll.uri (otpauth://…) to your authenticator app now.

# 3. Challenge → { challenge_id }
$chal = Invoke-RestMethod -Method POST "$cp/v1/admin/mfa/challenge" `
  -Headers @{ Authorization = "Bearer $aal1" } `
  -ContentType 'application/json' `
  -Body (@{ factor_id = $enroll.factor_id } | ConvertTo-Json)

# 4. Verify with the 6-digit code → aal2 token (+ refresh)
$aal2resp = Invoke-RestMethod -Method POST "$cp/v1/admin/mfa/verify" `
  -Headers @{ Authorization = "Bearer $aal1" } `
  -ContentType 'application/json' `
  -Body (@{ factor_id=$enroll.factor_id; challenge_id=$chal.challenge_id; code='<123456>' } | ConvertTo-Json)
$aal2 = $aal2resp.access_token
```

From now on, `login` returns aal1 + the factor list; you **step up** via
challenge/verify to get an aal2 token for state-changing calls. (MFA
challenge/verify is rate-limited **per factor**: 8 / 10 min in prod.)

**VERIFY:** you hold a non-empty `$aal2`.

---

## 6. Get a programmatic credential — mint a scoped API key

For headless/CI use (and for the rest of this runbook), mint a `pcp_…` API key
scoped to exactly what's needed. Minting is **aal2-gated** and the full key is
shown **exactly once**.

```powershell
$key = Invoke-RestMethod -Method POST "$cp/v1/admin/api-keys" `
  -Headers @{ Authorization = "Bearer $aal2" } `
  -ContentType 'application/json' `
  -Body (@{ name = 'standup key'; scopes = @('projects:create','migrations:apply') } | ConvertTo-Json)

$apiKey = $key.key          # pcp_<publicId>_<secret> — CAPTURE NOW, not recoverable
$key.public_id; $key.scopes
```

- Format: `pcp_<publicId(12, base32)>_<secret(43, base64url)>`; only
  `sha256(secret)` is stored at rest (`src/auth/api-keys.ts`).
- Known scopes (DB CHECK-constrained): `projects:read`, `projects:create`,
  `projects:delete`, `migrations:apply`, `keys:manage`.
- Use either credential on the routes below:
  `Authorization: Bearer <aal2 admin token | pcp_… API key with the right scope>`.

> **Not the same as `scripts/mint-keys.mjs`.** That script mints **engine-side
> Supabase-shape JWTs** (`anon` / `service_role`) from a *single project's*
> `JWT_SECRET` (read from a project `.env`) — it does **not** mint control-plane
> `pcp_` keys. Control-plane keys come from `POST /v1/admin/api-keys` (or
> `mintKey()` in code). There is no standalone script that mints `pcp_` keys.

**VERIFY:** `$apiKey` starts with `pcp_` and `$key.scopes` lists your two scopes.

---

## 7. Provision the first project + apply its migrations

### 7a. Provision

```powershell
$proj = Invoke-RestMethod -Method POST "$cp/v1/projects" `
  -Headers @{ Authorization = "Bearer $apiKey" } `
  -ContentType 'application/json' `
  -Body (@{ ref = 'demo' } | ConvertTo-Json)
# 201 → { ref, api_base_url, anon_key, service_key }
$anon = $proj.anon_key; $svc = $proj.service_key    # CAPTURE — show-once, not recoverable
```

- `ref` must match `^[a-z][a-z0-9_]{2,39}$` and not be reserved.
- The infra-only engine **template** is applied automatically during
  provisioning (`provisioning/template-runner.ts`).
- `anon_key` / `service_key` are returned **once** — only sealed forms persist.

### 7b. Apply the project's own migrations

```powershell
Invoke-RestMethod -Method POST "$cp/v1/projects/demo/migrations" `
  -Headers @{ Authorization = "Bearer $apiKey" } `     # needs scope migrations:apply (or aal2 admin)
  -ContentType 'application/json' `
  -Body (@{ sql = 'create table public.notes (id bigint generated always as identity primary key, body text not null);' } | ConvertTo-Json)
# 200 → { ref, applied: true, sql_sha256 }
```

The runner applies SQL with `psql -v ON_ERROR_STOP=1` **as the project owner**
(`SET ROLE "proj_demo_owner"`, so `ALTER DEFAULT PRIVILEGES` auto-grants future
tables). SQL goes via a `0600` temp file (deleted after); the audit row stores
**only `sha256` of the SQL body**. The project must be `active`. A psql error
returns a sanitized `400 MIGRATION_FAILED` with the stderr tail.

**Other project lifecycle routes** (for reference):
`GET /v1/projects` / `GET /v1/projects/:ref` (`projects:read`);
soft-disable `DELETE /v1/projects/:ref` (`projects:delete`, reversible);
hard teardown = aal2 admin + a single-use ref-bound token
(`POST /v1/projects/:ref/teardown-token` → `DELETE /v1/projects/:ref?confirm=<token>`).

**VERIFY:** provisioning returned `201` with non-empty `anon_key`/`service_key`,
and the migration returned `applied: true`.

---

## 8. Cloudflare tunnel (public ingress → engine on :8000)

Expose the **engine** at `https://api.<your-domain>` via a Cloudflare Tunnel
running as a Windows service. Two supported paths — pick one.

### Path A — token install (recommended; `scripts/cloudflare-tunnel-install.ps1`)

1. In the **Zero Trust dashboard** → Networks → Tunnels → *Create a tunnel* →
   *Cloudflared*; choose **Windows / x86_64**. Copy **just the token** (the
   `eyJ…` part), not the whole install command.
2. Add a **Public hostname**: `api` . `<your-domain>` → **HTTP**
   `http://127.0.0.1:8000`. Cloudflare auto-creates the CNAME.
3. Install + verify:

```powershell
pwsh -File .\scripts\cloudflare-tunnel-install.ps1 `
  -TunnelToken 'eyJ...' -Hostname 'api.<your-domain>'
#   -CloudflaredPath / -ConnectTimeoutSeconds overridable
```

The script idempotently (re)installs `cloudflared` as a service bound to the
token, waits for `Running`, polls the connector log until it **registers a
tunnel connection**, then smoke-tests `https://api.<your-domain>/health` from the
public side. (It strips an accidental `service install` prefix and rejects a
token that doesn't start `eyJ`.)

### Path B — named tunnel + config file

Use `scripts/cloudflared-config.yml.template` (single ingress
`api.<your-domain>` → `http://127.0.0.1:8000`, `http_status:404` fallback;
`httpHostHeader` preserves the client Host for CORS; `connectTimeout: 30s`;
WebSocket `/realtime/v1/websocket` forwarded automatically). Flow:
`cloudflared tunnel login` → `cloudflared tunnel create <name>` → fill
`<TUNNEL-UUID>` in `config.yml` → `cloudflared tunnel route dns <name>
api.<your-domain>` → `cloudflared service install` → `Restart-Service
cloudflared`. (`scripts/PHASE_6_CUTOVER.md` documents this end to end.)

> **Caveats:** the template and `PHASE_6_CUTOVER.md` were written for an earlier
> **single-tenant engine** cutover and carry hard-coded service/hostname names
> from it. The mechanics are correct for substrate — point ingress at the
> **engine** (`127.0.0.1:8000`) and substitute your own tunnel/hostname.
> Cloudflare's free plan has a **100s WS idle timeout**; ensure realtime clients
> heartbeat under that.

**VERIFY:** tunnel shows **HEALTHY** in the dashboard and, from an external
network, `Invoke-RestMethod https://api.<your-domain>/health/live` → `{ ok: true }`.

---

## 9. Final end-to-end verification (`scripts/e2e-smoke.ps1`)

The single command that **proves the live provision → serve → teardown loop**
against the box's real Postgres cluster, **without touching the running
production services** (it boots transient control-plane + engine on dynamically
chosen **free** ports, never 8000/8090/8100).

```powershell
powershell -File scripts\e2e-smoke.ps1
#   -PsqlPath / -PgHost / -PgPort / -ReadyTimeoutSec (default 45) overridable
```

What it asserts, step by step (PASS/FAIL each; non-zero exit on any failure):

1. Unseals `platform_meta` / `platform_provisioner` / master KEK from DPAPI into
   **process env only**; confirms it is the superuser.
2. Cleans any prior interrupted run; picks two free ports.
3. Boots transient control-plane (`/readyz`) + engine (`/health/live`).
4. Seeds a **throwaway** admin + a `projects:create,projects:read,projects:delete`
   API key (exact `pcp_…` format, `sha256(secret)` stored).
5. `POST /v1/projects {ref:e2esmoke}` → provisions `proj_e2esmoke` + its three
   least-priv roles; captures show-once anon/service keys; asserts
   `projects.status = 'active'`.
6. Creates an anon-readable `notes` table (RLS `TO anon` + grant + a row) and
   reads it back via the **engine** `GET /rest/v1/notes` (`x-project-ref`,
   `apikey: <anon>`) — proves **anon RLS REST**.
7. `POST /auth/v1/signup` via the engine and verifies the user lands in
   `proj_e2esmoke.auth.users` — proves **auth signup** on the isolated DB.
8. **Always** tears everything down in `finally` (drops the DB + 3 roles,
   deletes the 4 `platform_control` rows, stops both processes, scrubs secrets +
   `PGPASSWORD`).

**VERIFY:** ends with `e2e smoke PASSED.` and exit code `0`.

> The smoke test uses the superuser **only** for out-of-band row
> seeding/teardown that the interactive admin+TOTP flow would otherwise gate
> (a headless test can't drive TOTP). The two services still connect exactly as
> in production.

---

## 10. Notes, caveats & things to know

**Rotation (manual today; `system`-scoped).** There is **no first-class rotation
endpoint** yet. Per-project secret/role-password/KEK rotation is a manual
maintenance operation (re-seal the affected `project_secrets`, `ALTER ROLE …
PASSWORD` via the provisioner, then `PoolManager.evict(ref)` so the engine
reconnects). Rotating a project's JWT secret invalidates its previously-issued
anon/service keys. For the master KEK: **never overwrite `the master-key blob` in
place** — unwrap each DEK with the old KEK and re-wrap under the new one first;
the bootstrap deliberately refuses to clobber it.

**`scripts/rotate-secrets.ps1` is the single-tenant engine's tool, not the
platform's.** It rotates `WEBHOOK_SECRET` / `JWT_SECRET` for a hard-coded
single-tenant database and reads/writes a bundled secrets file + the engine's
`.env` — **artifacts that don't exist in the substrate engine package**. JWT rotation there logs everyone
out and requires `-Force` (dual-secret verification isn't wired up). Don't use it
for control-plane platform secrets; use the manual `system`-scoped model above.

**`scripts/install-windows-service.ps1` (WinSW) is also single-tenant-shaped.**
It installs a `substrate-engine` service via WinSW but expects a service
template, a bundled secrets file, and a secrets-loader script — **none of which
are in the repo tree**. On the rack, prefer the **NSSM** recipe in §3d (which `PHASE_6_CUTOVER.md`
documents as the proven path).

**Backups must be kept consistent as a pair:** (1) the `platform_control` DB +
each `proj_<ref>` DB, **and** (2) the DPAPI blobs — **especially
`the master-key blob`**. Without the KEK, `project_secrets` is **undecryptable** and
every project becomes unservable. A DB backup restored to a **different host**
can't decrypt `project_secrets` unless the KEK is re-established there
(LocalMachine-scoped DPAPI).

**Health endpoints for monitoring:** control-plane `/healthz` (liveness),
`/readyz` (metadata DB). Engine `/health/live`, `/health` (DB ping),
`/health/outbox` (watch `abandoned > 0`), `/health/realtime` (`state: error` when
logical replication is down — **non-fatal** to REST/Auth/RPC),
`/health/projects`.

### Maturity / known gaps (substrate `docs/STATUS.md`)

- **Live loop is PROVEN** (Phases 0–4 green): provision → REST + auth →
  teardown, reproducible via `e2e-smoke.ps1`.
- **Per-project realtime CDC (live)** plumbing is green and the `REPLICATION`
  grant happens at provision time **when `BOOTSTRAP_SUPERUSER_URL` is set** — but
  a full live `postgres_changes` subscription end-to-end (and the
  `max_replication_slots` cap under multiple realtime projects) is **not yet
  exercised**. Set `BOOTSTRAP_SUPERUSER_URL` (§3b) if you intend to use realtime.
- **The `substrate` CLI (`packages/cli`) is not runnable yet** — argv parser +
  config exist; the dispatcher + `bin` entrypoint don't. **Call the HTTP API
  directly** (as this runbook does).
- **Last plaintext-on-disk gap:** the superuser password (and the engine's
  realtime-role password derivation) still read plaintext from the
  `migration-secrets\*.txt` files; folding these into DPAPI is pending.

---

## ✅ You're done when…

- [ ] `bootstrap-platform.ps1` completed; `the provisioner password blob`,
      `the metadata password blob`, `the master-key blob` exist in your secrets dir.
- [ ] `configure-pg-hba.ps1` ran; `pg_reload_conf()` returned `t`;
      `substrate_roles` group exists with the two platform roles as members.
- [ ] `substrate-control` (:8090) and `substrate-engine` (:8000) are **Running**
      under NSSM with auto-restart; `/readyz` = `ready` and `/health/live` =
      `{ok:true}`.
- [ ] An admin is seeded, **TOTP enrolled**, and you can obtain an **aal2** token
      **and/or** a `pcp_…` API key scoped `projects:create,migrations:apply`.
- [ ] A project provisions (`POST /v1/projects`) and a migration applies
      (`applied: true`).
- [ ] The Cloudflare tunnel is **HEALTHY** and `https://api.<your-domain>/health/live`
      answers from the public internet.
- [ ] **`scripts\e2e-smoke.ps1` prints `e2e smoke PASSED.` and exits `0`.**
