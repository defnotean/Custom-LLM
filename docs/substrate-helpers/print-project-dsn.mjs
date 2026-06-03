// print-project-dsn.mjs
// ============================================================================
// Admin-only helper: print a provisioned project's DIRECT Postgres DSN.
//
// WHY THIS EXISTS
//   The substrate control plane intentionally NEVER returns a project's direct
//   Postgres connection string or its role passwords: those are sealed at rest
//   (DPAPI master KEK -> per-project DEK -> AES-256-GCM leaf secrets) and the
//   API surface (e.g. get-project.ts) only ever exposes non-secret metadata.
//   For integration path "B2" (an off-box client such as the Custom-LLM Discord
//   bot connecting straight to proj_<ref> via Prisma), you need the project's
//   OWNER role password to build a `postgresql://…` DSN. This script unseals
//   exactly that one secret, on the box, and prints the DSN.
//
// ──────────────────────────────────────────────────────────────────────────
//  WHERE TO PLACE IT (inside the substrate repo)
//    Drop this file into a workspace that depends on `@substrate/shared` so the
//    crypto + platform_control read helpers resolve. The natural homes are:
//        packages/control-plane/scripts/print-project-dsn.mjs   (recommended)
//      or
//        packages/shared/scripts/print-project-dsn.mjs
//    (`@substrate/shared` is a workspace dependency of control-plane, so its
//     subpath exports `@substrate/shared` and `@substrate/shared/crypto`
//     resolve from there.)
//
//  HOW TO RUN  (Node ≥ 22, ESM)
//    From the package dir that has @substrate/shared on its dependency path:
//        node scripts/print-project-dsn.mjs <project-ref>
//    e.g.
//        node scripts/print-project-dsn.mjs customllm
//
//    REQUIRED environment (same vars the control plane / engine already use):
//      • CONTROL_DATABASE_URL    — the platform_control connection string
//                                  (the `withSystemMeta` read pool reads this).
//      • The master KEK, resolved by @substrate/shared's loadMasterKey():
//          – production box: nothing extra — it is recovered from the
//            DPAPI-sealed blob via Unprotect-Secret.ps1 (so you MUST run on the
//            same machine/user/entropy that sealed it).
//          – dev/test/CI:   SUBSTRATE_MASTER_KEY_B64 (base64 of exactly 32
//            bytes), optionally SUBSTRATE_MASTER_KEY_ID.
//    These are typically injected by the same preload that runs the services
//    (e.g. `node --import ./your-kek-preload.mjs scripts/print-project-dsn.mjs <ref>`).
//
//  ⚠️  ONLY THE BOX OWNER SHOULD RUN THIS. ⚠️
//    It DECRYPTS and PRINTS a live database secret (the project owner password)
//    in plaintext to stdout. Treat its output like a password:
//      • run it only on the trusted rack, as the owner of the DPAPI scope;
//      • never pipe its output into logs, shell history files, or a repo;
//      • the printed DSN grants owner-level access to proj_<ref>.
//    This is deliberately NOT wired into the control-plane API — it is an
//    out-of-band operator tool.
// ============================================================================

// ── substrate APIs (match the repo's import style) ──────────────────────────
// Crypto primitives come from the single crypto surface. We use the SAME
// functions the engine uses to open secrets in packages/shared/src/platform/
// load-project.ts, so the unseal path is identical to production.
import {
  loadMasterKey,    // () => Promise<Buffer>        : resolve the 32-byte master KEK
  unwrapDek,        // (wrapped, kek) => Buffer      : KEK-unwrap the per-project DEK
  openSecret,       // (blob, dek, ref, kind) => str : AEAD-open a leaf secret (AAD = `${ref}:${kind}`)
  masterKeyId,      // () => string                 : current KEK generation id ("v1" by default)
} from '@substrate/shared/crypto';

// Read platform_control under the 'system' RLS scope. project_secrets is
// restricted by migrations/0020_platform_control_rls.sql to a SINGLE policy:
//   current_setting('app.actor_scope', true) = 'system'
// so ONLY a 'system'-scoped transaction may read wrapped_dek / ciphertext.
// `withSystemMeta` stamps exactly that scope (transaction-local). It is exported
// from the package root `@substrate/shared` (re-exported there from
// platform/control-read.ts).
import { withSystemMeta } from '@substrate/shared';

// ── 0. argv: the project ref ────────────────────────────────────────────────
const ref = process.argv[2]?.trim();
if (!ref) {
  console.error('usage: node print-project-dsn.mjs <project-ref>   (e.g. customllm)');
  process.exit(2);
}

// The secret_kind we want. The provisioner seals six kinds
// (jwt_secret | anon_key | service_key | owner_pw | app_pw | realtime_pw); the
// OWNER password is the one that lets Prisma run DDL/migrations against the DB.
// (See create-project.ts `sealAndStoreSecrets`.)
const SECRET_KIND_OWNER_PW = 'owner_pw';

async function main() {
  // ── 1. Read the project row + the owner-password secret row, under 'system'.
  // We fetch both in one 'system'-scoped transaction (mirrors load-project.ts),
  // so the read is consistent and the RLS context is established exactly once.
  //
  // Columns:
  //   projects        : ref, db_name, owner_role
  //   project_secrets : wrapped_dek, dek_key_id, ciphertext   (kind = 'owner_pw')
  // The join projects.id = project_secrets.project_id is exactly the shape
  // load-project.ts uses.
  const fetched = await withSystemMeta(async (client) => {
    const projRes = await client.query(
      `SELECT ref, db_name, owner_role
         FROM platform_control.projects
        WHERE ref = $1 AND status = 'active'`,
      [ref],
    );
    if (projRes.rowCount === 0) {
      return null; // no ACTIVE project with that ref
    }
    const project = projRes.rows[0];

    const secRes = await client.query(
      `SELECT ps.wrapped_dek, ps.dek_key_id, ps.ciphertext
         FROM platform_control.project_secrets ps
         JOIN platform_control.projects p ON p.id = ps.project_id
        WHERE p.ref = $1 AND ps.secret_kind = $2`,
      [ref, SECRET_KIND_OWNER_PW],
    );
    if (secRes.rowCount === 0) {
      // Project exists but has no owner_pw row (shouldn't happen for a
      // fully-provisioned project) — surface clearly rather than printing junk.
      return { project, secret: null };
    }
    return { project, secret: secRes.rows[0] };
  });

  if (fetched === null) {
    console.error(`error: no ACTIVE project with ref '${ref}' in platform_control.projects.`);
    process.exit(1);
  }
  if (fetched.secret === null) {
    console.error(
      `error: project '${ref}' has no '${SECRET_KIND_OWNER_PW}' row in platform_control.project_secrets.`,
    );
    process.exit(1);
  }

  const { project, secret } = fetched;
  const { db_name: dbName, owner_role: ownerRole } = project;
  const { wrapped_dek: wrappedDek, dek_key_id: dekKeyId, ciphertext } = secret;

  // ── 2. Resolve the master KEK (DPAPI on prod; SUBSTRATE_MASTER_KEY_B64 in dev).
  const kek = await loadMasterKey();

  // Optional sanity check: the row records which KEK generation wrapped its DEK
  // as `master:<masterKeyId>` (create-project.ts sets
  // `dekKeyId = `master:${masterKeyId()}``). If it doesn't match the KEK this
  // process loaded, unwrap below would fail the GCM tag anyway — but checking
  // here yields a clearer message. This is advisory: the cryptographic gate is
  // the AEAD tag, not this string.
  const expectedDekKeyId = `master:${masterKeyId()}`;
  if (dekKeyId && dekKeyId !== expectedDekKeyId) {
    console.error(
      `warning: dek_key_id='${dekKeyId}' but this process's master key id is ` +
        `'${expectedDekKeyId}'. If decryption fails, you are likely using the ` +
        `wrong KEK generation (rotate / set SUBSTRATE_MASTER_KEY_ID).`,
    );
  }

  // ── 3. Unwrap the per-project DEK, then open the owner-password leaf secret.
  // unwrapDek validates the recovered DEK is exactly 32 bytes; openSecret binds
  // AAD = `${ref}:owner_pw` — the EXACT (ref, kind) the control plane sealed
  // with in create-project.ts `sealSecret(secrets[kind], dek, ref, kind)`. A
  // mismatch (wrong key / wrong AAD / tampered blob) throws.
  const dek = unwrapDek(wrappedDek, kek);
  const ownerPw = openSecret(ciphertext, dek, ref, SECRET_KIND_OWNER_PW);

  // ── 4. Build + print the DSN. ───────────────────────────────────────────────
  // URL-encode the password defensively. The provisioner mints base64url
  // passwords ([A-Za-z0-9_-], conninfo-safe), but encoding is harmless and
  // correct if the password scheme ever changes.
  const encPw = encodeURIComponent(ownerPw);
  const loopbackDsn =
    `postgresql://${ownerRole}:${encPw}@127.0.0.1:5432/${dbName}?sslmode=require`;

  // The DSN itself is the secret-bearing output; print it on its own line so it
  // is easy to capture deliberately and hard to capture accidentally.
  console.log(loopbackDsn);

  // Operator notes to STDERR (so `... > dsn.txt` captures ONLY the DSN on stdout,
  // not the guidance). For B2 (off-box bot), swap 127.0.0.1 for the rack's
  // tailnet IP / MagicDNS name — see docs/B2_NETWORKING.md in the bot repo.
  console.error('');
  console.error(`# project ref : ${ref}`);
  console.error(`# database    : ${dbName}`);
  console.error(`# owner role  : ${ownerRole}`);
  console.error('# ---------------------------------------------------------------');
  console.error('# The line on STDOUT is a LIVE owner-level DSN. Handle as a secret:');
  console.error('#   • do not commit it, log it, or paste it into chat;');
  console.error('#   • for B2 (off-box bot) replace 127.0.0.1 with the rack tailnet IP, e.g.:');
  console.error(`#       postgresql://${ownerRole}:<owner_pw>@<rack-tailnet-ip>:5432/${dbName}?sslmode=require`);
  console.error('#   • then on the bot host: set DATABASE_URL=<that>, run `npx prisma migrate deploy`.');
}

main().catch((err) => {
  // Never echo key/secret material in errors. loadMasterKey()/unwrapDek()/
  // openSecret() already throw redacted messages; surface just the message.
  console.error(`print-project-dsn: failed: ${err?.message ?? String(err)}`);
  process.exit(1);
});

// ============================================================================
// ASSUMPTIONS TO VERIFY against the live @substrate/shared (stated, not invented):
//
//  1. EXPORT PATHS / SIGNATURES (confirmed against packages/shared/src as of
//     this writing):
//       • '@substrate/shared/crypto' exports:
//           loadMasterKey(): Promise<Buffer>
//           unwrapDek(wrapped: string, kek: Buffer): Buffer
//           openSecret(blob: string, dek: Buffer, ref: string, kind: string): string
//           masterKeyId(): string
//         (envelope.ts + master-key.ts, re-exported via crypto/index.ts.)
//       • '@substrate/shared' (package root, src/index.ts) re-exports
//           withSystemMeta(fn, opts?)  — from platform/control-read.ts.
//         If your build only exposes the './platform' subpath for this, import it
//         from '@substrate/shared/platform/control-read' instead. (The package.json
//         `exports` map declares '.', './crypto', './platform'; the root '.' is
//         used here because that is where control-read's withSystemMeta is
//         re-exported.)
//
//  2. AAD BINDING (confirmed): leaf secrets are sealed with
//        sealSecret(plaintext, dek, ref, kind)  ->  AAD = `${ref}:${kind}`
//     in create-project.ts `sealAndStoreSecrets`, and opened with the same
//     (ref, kind). This script opens with (ref, 'owner_pw'). If the seal-time
//     AAD ever differs (e.g. uses db_name or a normalized ref instead of the
//     raw `projects.ref`), this open will throw — update the (ref, kind) here to
//     match seal time.
//
//  3. SCHEMA (confirmed against migrations/0010_platform_control_schema.sql):
//       • platform_control.projects has columns: ref, db_name, owner_role
//         (+ app_role, realtime_role, status, …).
//       • platform_control.project_secrets has: project_id, secret_kind,
//         wrapped_dek, dek_key_id, ciphertext, with secret_kind 'owner_pw' for
//         the owner password and UNIQUE(project_id, secret_kind).
//
//  4. RLS SCOPE (confirmed against migrations/0020_platform_control_rls.sql):
//     project_secrets is readable ONLY under app.actor_scope = 'system'
//     (policy project_secrets_system_only, FOR ALL). withSystemMeta stamps that
//     scope, so this read succeeds where an 'admin'/'api' connection would be
//     default-denied. Requires CONTROL_DATABASE_URL to point at platform_control
//     as a role allowed to assume the 'system' scope (the same role the control
//     plane uses, i.e. platform_meta).
//
//  5. KEK RESOLUTION (confirmed): loadMasterKey() reads SUBSTRATE_MASTER_KEY_B64
//     if set, else recovers the DPAPI blob via Unprotect-Secret.ps1 on the box.
//     This script therefore only works where one of those is available.
// ============================================================================
