# B2 Networking — Off-box bot → substrate Postgres over a private link

> **Integration path B2:** the Custom-LLM bot runs **off the rack** and connects
> **directly** to its substrate-provisioned project database (`proj_customllm`)
> over the Postgres wire protocol. Prisma stays **unchanged** — the project's
> **owner** role owns the database, so `prisma migrate deploy` and all runtime
> queries "just work."
>
> This document covers only the **network + Postgres reachability** changes. It
> assumes substrate is already stood up on the rack and the `customllm` project
> has been provisioned (you have the project's **owner** DB password — see
> `docs/substrate-helpers/print-project-dsn.mjs`).

**Sensitivity:** this file is safe for a public repo. It contains **no secrets,
no real secret-file paths, no other-tenant names, and no key material** — only
generic, illustrative values. Replace every `<placeholder>` with your real value
at run time; never commit the filled-in `DATABASE_URL`.

---

## 0. Why a change is needed

The rack's PostgreSQL 17 is currently **loopback-bound** (`listen_addresses`
restricted to localhost) and its `pg_hba.conf` admits the platform's role group
(`+substrate_roles`) over `hostssl … scram-sha-256` on **127.0.0.1 / ::1 only**.
That is exactly what you want for an on-box control plane + engine, but it means
nothing off the box — including the bot — can reach the database yet.

B2 makes the database reachable from **one** additional place (the bot host) and
**only** over a private, encrypted overlay network. Postgres is **never** exposed
to the public internet.

The change has three surgical parts:

1. **Private overlay link** (Tailscale or WireGuard) joining the rack and the bot
   host to the same tailnet.
2. **`listen_addresses`** widened so Postgres also listens on the rack's tailnet
   interface (still not the public internet).
3. **One additive `pg_hba.conf` rule** admitting `+substrate_roles` from the
   **tailnet subnet** over `hostssl … scram-sha-256`, modeled on the existing
   loopback rule — without loosening auth for any non-substrate role.

Then, bot side: point `DATABASE_URL` at the rack's tailnet IP, run
`prisma migrate deploy`, and smoke-test connectivity.

---

## 1. Private overlay network (Tailscale)

Tailscale is the lowest-effort option (NAT traversal, identity-based ACLs, WireGuard
under the hood). A hand-rolled WireGuard tunnel works too — see §1.4.

### 1.1 Install on the rack (Windows Server)

1. Download the Tailscale Windows installer from `https://tailscale.com/download`
   and install it (or, elevated):

   ```powershell
   winget install --id Tailscale.Tailscale -e
   ```

2. Bring the rack onto your tailnet. Run as the box owner:

   ```powershell
   tailscale up
   ```

   Authenticate in the browser window that opens (or use a pre-auth key for an
   unattended server: `tailscale up --auth-key tskey-auth-<...>`).

3. (Optional, recommended for a server) disable key expiry for this node in the
   Tailscale admin console so the link doesn't drop in 180 days, and give it a
   stable hostname (e.g. `rack`).

### 1.2 Install on the bot host

Install Tailscale the same way for your OS (Windows / Linux / macOS) and run
`tailscale up`, authenticating into the **same** tailnet (same account/org).

### 1.3 Find the rack's tailnet IP

Tailnet IPs are in the `100.64.0.0/10` CGNAT range (a `100.x.y.z` address).

- **On the rack:**

  ```powershell
  tailscale ip -4
  ```

  prints the rack's tailnet IPv4 (e.g. `100.101.102.103`). This is the
  `<rack-tailnet-ip>` you put in `DATABASE_URL`.

- **From the bot host**, you can also resolve it by node name:

  ```bash
  tailscale status        # lists peers: name → 100.x.y.z
  tailscale ping rack      # confirms the path is up (direct or via DERP relay)
  ```

> **Tip:** prefer the **MagicDNS name** (e.g. `rack.tailnet-name.ts.net`) over the
> raw `100.x` literal in `DATABASE_URL` if you have MagicDNS enabled — it survives
> a tailnet-IP reassignment. Either works.

### 1.4 WireGuard alternative

If you use raw WireGuard instead: stand up a tunnel between the two hosts, assign
the rack a stable private address inside the tunnel subnet (e.g. `10.10.0.0/24`),
and substitute that subnet/address everywhere this doc says "tailnet". The Postgres
and `pg_hba` steps are identical; only the IP/subnet literals change.

### 1.5 Lock the overlay down (defense in depth)

In the Tailscale admin console, use **ACLs** so only the bot host may reach the
rack's Postgres port. Conceptually:

```jsonc
// Tailscale ACL (illustrative — adapt tags/users to your tailnet)
{
  "acls": [
    // Only the bot host may reach the rack on tcp/5432; deny everything else.
    { "action": "accept", "src": ["tag:bot"], "dst": ["tag:rack:5432"] }
  ]
}
```

This means even other machines on your tailnet cannot open the database port.

---

## 2. Postgres `listen_addresses` (rack)

Postgres only accepts TCP connections on the interfaces named in
`listen_addresses`. Loopback-only means `localhost`. Add the **rack's tailnet IP**
so it also listens there — but **not** `*` (which would also bind the public NIC).

### 2.1 Locate `postgresql.conf`

```powershell
& 'C:\Program Files\PostgreSQL\17\bin\psql.exe' -U postgres -d postgres -At -c 'SHOW config_file;'
```

Typically `C:\Program Files\PostgreSQL\17\data\postgresql.conf` (your data
directory may differ — trust `SHOW config_file`).

### 2.2 Edit the value

Find the existing `listen_addresses` line and widen it to include the tailnet IP.
Keep loopback so the on-box control plane + engine keep working:

```ini
# postgresql.conf
# Was: listen_addresses = 'localhost'
listen_addresses = 'localhost,100.101.102.103'   # localhost + the rack's tailnet IP
```

- Use the **rack's own** tailnet IP from §1.3 (the interface to bind), **not** the
  bot's.
- **Do not** use `listen_addresses = '*'`. Binding only the loopback + tailnet
  interfaces keeps Postgres off the public NIC even if a firewall rule is later
  fumbled. (If your tailnet interface name is stable you may bind it by address as
  shown; `'*'` is intentionally avoided.)

> `listen_addresses` is a **postmaster** parameter: it requires a **restart**, not
> just a reload (unlike `pg_hba.conf` in §3, which only needs a reload).

### 2.3 Restart Postgres

```powershell
Restart-Service postgresql-x64-17        # service name as registered on the rack
# or:  pg_ctl restart -D "C:\Program Files\PostgreSQL\17\data"
```

Confirm it is now listening on the tailnet interface:

```powershell
netstat -an | Select-String ':5432'      # expect 127.0.0.1:5432 and 100.x.y.z:5432
```

### 2.4 Windows firewall

Allow inbound tcp/5432 **only on the Tailscale interface**, not on the public
profile:

```powershell
New-NetFirewallRule -DisplayName 'Postgres 5432 (Tailscale only)' `
  -Direction Inbound -Protocol TCP -LocalPort 5432 `
  -InterfaceAlias 'Tailscale' -Action Allow
```

(Adjust `-InterfaceAlias` to match `Get-NetAdapter` output for the Tailscale
adapter.) Do **not** open 5432 on the public/internet-facing profile.

---

## 3. `pg_hba.conf` — admit `+substrate_roles` from the tailnet (rack)

This is the security-critical step. The model is the rack's existing
`configure-pg-hba.ps1`, which inserts loopback rules of exactly this shape **above
the catch-all `reject`**:

```conf
# >>> substrate platform (loopback, TLS, +substrate_roles only) >>>
hostssl     all             +substrate_roles   127.0.0.1/32     scram-sha-256
hostssl     all             +substrate_roles   ::1/128          scram-sha-256
host        replication     +substrate_roles   127.0.0.1/32     scram-sha-256
host        replication     +substrate_roles   ::1/128          scram-sha-256
# <<< substrate platform <<<
```

We add **one analogous rule** for the tailnet subnet. The bot only needs **regular
client connectivity** (not replication), so we add a single `hostssl … all …`
line — we do **not** extend replication off-box.

### 3.1 Principles (do not deviate)

- **Additive only.** Append a new line; do not edit, reorder, or delete existing
  rules. The loopback rules and the catch-all `reject` stay exactly as they are.
- **Same posture as loopback:** `hostssl` (TLS required — non-SSL is already
  rejected by the existing `hostnossl … reject` rules that match first),
  `scram-sha-256` (no trust/password/md5), and **`+substrate_roles` only** (the
  group role; the leading `+` means "members of"). This is what guarantees the
  new rule **cannot loosen auth for any non-substrate role** — a role that is not
  a member of `substrate_roles` simply does not match this line.
- **Narrow source.** Scope the rule to the **tailnet subnet**, not `0.0.0.0/0`.
  The Tailscale CGNAT range is `100.64.0.0/10`. Tighten it further to your
  tailnet's actual allocation, or to the bot host's exact `/32`, if you know it
  (e.g. `100.101.102.0/24`, or `100.101.102.150/32` for just the bot).
- **Place it above the catch-all reject** (the
  `host all all 0.0.0.0/0 reject` / `::/0 reject` line), same as the script does —
  otherwise the reject would shadow it. Putting it next to the existing
  `# >>> substrate platform …` block is the natural home.
- **Timestamped backup first** (the script does this; do it by hand too).

### 3.2 The exact line(s) to add

For the tailnet IPv4 subnet:

```conf
# >>> substrate platform B2 (tailnet, TLS, +substrate_roles only) >>>
hostssl     all             +substrate_roles   100.64.0.0/10    scram-sha-256
# <<< substrate platform B2 <<<
```

- Replace `100.64.0.0/10` with the **narrowest** CIDR that still includes the bot
  host — ideally the bot's `/32` (e.g. `100.101.102.150/32`).
- If the bot connects over **tailnet IPv6** (a `fd7a:115c:…` Tailscale ULA),
  add a parallel `::`-style line for that prefix as well; otherwise the IPv4 line
  alone is sufficient.
- Note the database column is `all` (matching the loopback rule). Prisma's owner
  role connects to `proj_customllm`; if you prefer to be stricter you may name the
  database explicitly (`proj_customllm`) and/or the owner role explicitly instead
  of `+substrate_roles`, but `all` + `+substrate_roles` keeps it identical to the
  vetted loopback posture and still admits only substrate roles.

### 3.3 Apply it safely (manual, additive, with backup)

`pg_hba.conf` changes need a **reload**, not a restart. Locate the file, back it
up with a timestamp, append the block above the catch-all reject, then reload:

```powershell
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'

# 1. Locate pg_hba.conf authoritatively.
$hba = (& $psql -U postgres -d postgres -At -c 'SHOW hba_file;').Trim()
"pg_hba.conf: $hba"

# 2. Timestamped backup BEFORE any edit (mirrors configure-pg-hba.ps1).
$stamp  = (& $psql -U postgres -d postgres -At -c "SELECT to_char(now(),'YYYYMMDD_HH24MISS');").Trim()
Copy-Item -LiteralPath $hba -Destination "$hba.bak-b2-$stamp" -Force
"backup: $hba.bak-b2-$stamp"

# 3. Append the additive block ABOVE the catch-all reject.
#    (Open $hba in an editor and paste the block from §3.2 immediately before the
#     'host all all 0.0.0.0/0 reject' line, or scripted — see note below.)

# 4. Reload (NOT a restart — pg_hba is re-read on reload).
& $psql -U postgres -d postgres -At -c 'SELECT pg_reload_conf();'
```

> **Where to put it:** insert the §3.2 block immediately **before** the
> `host all all 0.0.0.0/0 reject` (and `::/0 reject`) catch-all, exactly where
> `configure-pg-hba.ps1` inserts its loopback block. If you prefer to script the
> insertion rather than hand-edit, copy the `$idx`-finding + insert logic from
> `configure-pg-hba.ps1` and swap in the §3.2 block — but a careful manual edit of
> one block is perfectly fine here.

### 3.4 Verify the rule loaded and is correct

```powershell
# Inspect the live, parsed rules (no restart needed to read this view).
& $psql -U postgres -d postgres -c `
  "SELECT type, database, user_name, address, auth_method
     FROM pg_hba_file_rules
    WHERE '+substrate_roles' = ANY(user_name) OR 'substrate_roles' = ANY(user_name)
    ORDER BY line_number;"
```

You should see your new tailnet `hostssl … scram-sha-256` row alongside the
existing loopback rows, and **no** new rule that names `all`/`+substrate_roles`
with a weaker `auth_method` (e.g. `trust`/`md5`) or a broader address than you
intended. Also check `pg_hba_file_rules` has no `error` column populated for the
file (a malformed line shows up there).

> **Rollback:** if anything looks wrong, restore the backup
> (`Copy-Item "$hba.bak-b2-$stamp" $hba -Force`) and `SELECT pg_reload_conf();`.

---

## 4. Bot side — `DATABASE_URL`, migrate, smoke test

### 4.1 Set `DATABASE_URL`

Point Prisma at the project DB on the rack's tailnet IP, as the **owner** role,
with **TLS required**:

```bash
DATABASE_URL=postgresql://<ownerRole>:<owner_pw>@<rack-tailnet-ip>:5432/proj_customllm?sslmode=require
```

- `<ownerRole>` / `<owner_pw>`: the project's **owner** login + password. Retrieve
  them with `docs/substrate-helpers/print-project-dsn.mjs` (run on the rack by the
  box owner) — substrate's control plane never returns them. Use the **owner**
  role (not app/realtime): it owns `proj_customllm`, so it can run DDL / Prisma
  migrations, and it is still a hardened, least-privilege login
  (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, connection-limited).
- `<rack-tailnet-ip>`: from §1.3 (or the MagicDNS name `rack.<tailnet>.ts.net`).
- `?sslmode=require`: TLS is mandatory (the `hostssl` rule rejects non-TLS).
  - The rack's Postgres presents a **self-signed** cert by default. `sslmode=require`
    encrypts but does not verify the cert chain — fine over a private tailnet where
    the transport is already authenticated by WireGuard. If you want full
    verification, copy the server cert to the bot host and use
    `?sslmode=verify-full&sslrootcert=/path/to/server.crt` with a hostname the cert
    matches.
- Put this in the bot's `.env` (which is git-ignored). **Never commit the
  filled-in URL.** URL-encode any reserved characters in the password (the
  provisioner generates base64url passwords `[A-Za-z0-9_-]`, which are
  conninfo-safe, so this is usually a non-issue).

### 4.2 Apply the schema

From the bot's project root, with `DATABASE_URL` exported:

```bash
npx prisma generate          # if you haven't already
npx prisma migrate deploy    # applies prisma/migrations/** to proj_customllm
```

`migrate deploy` is the non-interactive, production-style apply (no shadow DB, no
prompts). It works because the owner role owns the database.

### 4.3 Connectivity smoke test

Pick whichever you have on the bot host:

**Option A — Prisma (no extra tooling):**

```bash
# Trivial round-trip through Prisma's own connection.
npx prisma db execute --url "$DATABASE_URL" --stdin <<'SQL'
SELECT current_user, current_database(), version();
SQL
```

**Option B — `psql`:**

```bash
psql "postgresql://<ownerRole>:<owner_pw>@<rack-tailnet-ip>:5432/proj_customllm?sslmode=require" \
  -c "SELECT current_user, current_database(), now();"
```

**What "good" looks like:**
- `current_user` = your `<ownerRole>`, `current_database()` = `proj_customllm`.
- After §4.2, `\dt` (psql) or a quick `SELECT count(*) FROM "UserProfile";` shows
  the bot's tables exist.
- If it **hangs**: the path/firewall is wrong — check `tailscale ping rack` and
  that 5432 is listening on the tailnet IP (§2.3) and allowed on the Tailscale
  interface (§2.4).
- If it's **refused / "no pg_hba.conf entry"**: the source IP didn't match your
  §3.2 CIDR, or you used a non-substrate role, or you forgot `sslmode=require`.
- If **auth fails**: wrong owner password (re-run the DSN helper) — note SCRAM is
  enforced.

Then start the bot normally (`npm run dev` / `npm start`); rows now land in
`proj_customllm`.

---

## 5. Security notes (what B2 preserves)

- **Postgres stays off the public internet.** It listens only on loopback + the
  tailnet interface (§2.2 — never `*`), the inbound firewall rule is scoped to the
  Tailscale interface (§2.4), and the new `pg_hba` rule admits only the tailnet
  subnet (§3.2). The only path in is the authenticated WireGuard overlay.
- **No auth loosening for anyone else.** The added rule is `hostssl … +substrate_roles
  … scram-sha-256` — same posture as the vetted loopback rule. Roles outside the
  `substrate_roles` group never match it; the catch-all `reject` still backstops
  everything below.
- **Least privilege.** The bot connects as the project **owner** role, which is a
  hardened login (no superuser/createdb/createrole/bypassrls, connection-limited)
  scoped to a single database. It owns `proj_customllm` so Prisma migrations work,
  but it cannot touch other tenants' databases or `platform_control`.
- **TLS required end-to-end.** `hostssl` + `sslmode=require` (or `verify-full`)
  means the wire is always encrypted, on top of WireGuard's own encryption.
- **Secrets never in the repo.** The owner password lives only in the bot's
  git-ignored `.env`; it is retrieved on the rack via the DSN helper, never
  committed, never logged.
- **Reversible & auditable.** The `pg_hba` change is one additive block with a
  timestamped backup; revert + reload restores the loopback-only posture instantly.
- **Defense in depth on the overlay.** Tailscale ACLs (§1.5) restrict tcp/5432 to
  the bot host alone, so even other tailnet members cannot reach the database port.

---

## 6. Quick checklist

- [ ] Tailscale up on **rack** and **bot host**, same tailnet; `tailscale ping rack` succeeds.
- [ ] (Optional) Tailscale ACL limits tcp/5432 to the bot host.
- [ ] `postgresql.conf`: `listen_addresses = 'localhost,<rack-tailnet-ip>'` (not `*`); **restart**.
- [ ] Inbound firewall: 5432 allowed **only** on the Tailscale interface.
- [ ] `pg_hba.conf`: **backup taken**, one additive `hostssl all +substrate_roles <tailnet-cidr> scram-sha-256` line above the catch-all reject; **reload**.
- [ ] `pg_hba_file_rules` shows the new rule; no weaker auth for any other role.
- [ ] Bot `.env`: `DATABASE_URL=…@<rack-tailnet-ip>:5432/proj_customllm?sslmode=require` (owner role), not committed.
- [ ] `npx prisma migrate deploy` succeeds.
- [ ] Smoke test returns `current_user=<owner>`, `current_database()=proj_customllm`.
