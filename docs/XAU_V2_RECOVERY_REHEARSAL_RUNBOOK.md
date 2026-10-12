# XAU V2 — verified logical backup and recovery rehearsal

Status: `REC-1 V3 OPERATOR KIT READY — RESUME/RE-EXECUTION NOT AUTHORIZED`

Production project: `ejvwmjgfvhsslqiydwpz` (`ALPHA-XAU-TERMINAL`)  
Required target: a dedicated, disposable, non-production Supabase project  
Scope: database roles, application schema/data, and migration history

## 0. REC-1 V2 re-freeze note

The first authorized REC-1 attempt stopped before any logical dump or target
restore because the source manifest observed `transaction_read_only=off` when
the previous implementation relied on the startup/session GUC
`default_transaction_read_only=on` through the Supabase Session pooler. The
target remained empty.

V2 removes that pooler-dependent assumption. Every manifest catalog/count query
is now executed inside an explicit PostgreSQL `BEGIN TRANSACTION READ ONLY`
transaction, with `statement_timeout` and `lock_timeout` applied using
`SET LOCAL`. The manifest still verifies `transaction_read_only=on` from inside
the guarded transaction and fails closed otherwise. No production action,
migration, runtime activation, or prior REC-1 authorization is carried forward
by this re-freeze; a fresh execution authorization and maintenance window are
required.

## 0a. REC-1 V3 managed parameter privilege note

The second authorized REC-1 attempt completed the source manifest, logical
backup, encryption, decryption verification, and encrypted off-site copy. The
isolated target restore then stopped fail-closed on the generated role-dump
statement:

```sql
GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";
```

Read-only reconciliation after the stop proved that production and the fresh
target already expose the same platform-managed privilege:
`supabase_realtime_admin` has `SET` on `log_min_messages`, granted by
`supabase_admin`. The application schema/data and migration history were not
restored by the failed transaction.

V3 preserves the original `roles.sql` and its checksum. A separate
`roles.restore.sql` may omit only the exact statement above after all
fail-closed checks in Step 6.1 pass. Any missing, duplicated, variant, or
additional managed-parameter statement, checksum drift, target ACL mismatch,
or restore error means `STOP`.

A V3 resume may reuse the already verified encrypted backup and perform no new
production capture or dump. Resume still requires a fresh authorization bound
to the current frozen payload and approved isolated target. Production access,
migrations 0029–0034, runtime, deployment, provider, broker, and trading
authority remain outside this scope.

This runbook implements recovery Option A from the Event Facts production
authorization packet. It does not authorize an operator, production access,
project creation, backup extraction, restore, migration, deployment, route, or
runtime activation. A named operator and scoped approval are required before
Step 1. Production remains on hold until the signed evidence in Step 8 exists.

## 1. Preconditions and stop conditions

Record a named recovery operator, review mode, change/ticket reference, UTC
maintenance window, source project ref, target project ref, and approved
encrypted off-site location. Stop if any field is missing.

The review mode is `INDEPENDENT_REVIEWER` by default: a named human reviewer
who is not the operator verifies Step 8. `SOLO_OPERATOR_EXCEPTION` is permitted
only under §6a of the REC-1 execution authorization packet, with every
condition there satisfied. It provides reduced segregation-of-duties
assurance and does not relax any other step, guard, or stop condition in this
runbook.

The target must be isolated and disposable, have no production routes,
schedules, webhooks, Edge Functions, or application secrets, and must never be
`ejvwmjgfvhsslqiydwpz`. Keep all ALPHA-XAU writers off for the capture window;
the current runtime is already off, but the operator must re-check immediately
before capture. Stop on source drift, an active writer, a target/ref mismatch,
or any command error.

Required local tools:

- current Supabase CLI and a running Docker daemon;
- `psql` matching PostgreSQL major 17;
- `age` (or an organization-approved equivalent) and `sha256sum`;
- a private, encrypted working volume with sufficient free space.

Run `supabase --version`, `supabase db dump --help`, `psql --version`, and
`age --version`; record their output in the evidence ledger. Do not continue
if the installed CLI flags differ from this frozen procedure.

## 2. Secret-safe shell setup

Use a clean shell with history and tracing disabled. Never place a connection
string, password, access token, plaintext dump, or manifest in the repository,
CI artifacts, tickets, or chat.

```bash
set +x
set -o noclobber
umask 077
read -r -s -p 'Source database URL: ' SOURCE_DB_URL
echo
read -r -s -p 'Target database URL: ' TARGET_DB_URL
echo
read -r -p 'age recipient: ' RECOVERY_AGE_RECIPIENT
RECOVERY_WORKDIR="$(mktemp -d)"
```

Use the Supabase Session pooler URLs from each project's **Connect** panel.
The source URL must identify `ejvwmjgfvhsslqiydwpz`; the target URL must
identify the approved non-production project. Do not use the transaction
pooler. Validate both visually without printing either URL.

## 3. Capture the source evidence manifest

Export the source connection as standard libpq variables without logging it.
The manifest command accepts no URL argument. Every catalog/count query runs
inside an explicit `BEGIN TRANSACTION READ ONLY` transaction, with transaction-
local timeouts, and the first query verifies `transaction_read_only=on`. It
emits catalog metadata and exact row counts only—never row contents.

```bash
export PGHOST='<source session-pooler host>'
export PGPORT='5432'
export PGDATABASE='postgres'
export PGUSER='postgres.ejvwmjgfvhsslqiydwpz'
read -r -s -p 'Source database password: ' PGPASSWORD
echo
export PGPASSWORD
export RECOVERY_MANIFEST_ROLE='source'
export RECOVERY_PROJECT_REF='ejvwmjgfvhsslqiydwpz'
export RECOVERY_ALLOW_PRODUCTION_READ_ONLY='YES'
node scripts/recovery_manifest.mjs capture > "$RECOVERY_WORKDIR/source-manifest.json"
unset PGPASSWORD RECOVERY_ALLOW_PRODUCTION_READ_ONLY
```

This is a production read, so it still requires the scoped approval and named
operator from Step 1. A generic instruction such as “continue” is insufficient.

Capture also runs the managed-schema guard before any dump is taken. Supabase
states that user customizations to the `auth` and `storage` schemas (for
example triggers or RLS policies) are not carried by this procedure and must be
restored separately. The REC-1 preflight found none: `auth.users`,
`storage.buckets`, and `storage.objects` were empty, there were no auth/storage
RLS policies or publication entries, and only Supabase-managed storage triggers
existed. The guard fails closed, so capture exits non-zero and `STOP` applies,
if any of these appear:

- an RLS policy on an `auth` or `storage` table;
- a non-internal trigger on an `auth` or `storage` table whose function lives
  outside those schemas or is not owned by a Supabase-managed role
  (`supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin`);
- an `auth`/`storage` relation or function owned by any other role;
- an `auth` or `storage` table in a publication;
- a row in `auth.users`, `storage.buckets`, `storage.objects`, or, when
  present, `vault.secrets`. Vault-encrypted data cannot be recovered from a
  logical dump without the source root key, which REC-1 does not transfer.

A guard failure requires a renewed review. Do not reproduce, migrate, or
waive Supabase-managed internal objects to get past it. The same guard runs on
the target capture in Step 7.

## 4. Produce the logical backup

Supabase's current backup procedure uses separate role, schema, and data dumps,
and excludes `storage.buckets_vectors` and `storage.vector_indexes` from the
data dump. Do not drop either `-x` exclusion.
Preserve CLI migration history separately because the default dump excludes
the `supabase_migrations` schema.

```bash
supabase db dump --db-url "$SOURCE_DB_URL" -f "$RECOVERY_WORKDIR/roles.sql" --role-only
supabase db dump --db-url "$SOURCE_DB_URL" -f "$RECOVERY_WORKDIR/schema.sql"
supabase db dump --db-url "$SOURCE_DB_URL" -f "$RECOVERY_WORKDIR/data.sql" --use-copy --data-only \
  -x "storage.buckets_vectors" -x "storage.vector_indexes"
supabase db dump --db-url "$SOURCE_DB_URL" -f "$RECOVERY_WORKDIR/history-schema.sql" --schema supabase_migrations
supabase db dump --db-url "$SOURCE_DB_URL" -f "$RECOVERY_WORKDIR/history-data.sql" --use-copy --data-only --schema supabase_migrations
unset SOURCE_DB_URL
```

Every command must exit zero and every file must be non-empty. Do not edit a
dump to conceal an error; stop and record the exact non-secret diagnostic.
Supabase logical dumps do not include Storage API objects, Edge Functions,
project secrets, Auth provider configuration, custom domains, or DNS. Those
assets need independent recovery procedures if later brought into scope.

## 5. Encrypt before off-site transfer

```bash
sha256sum "$RECOVERY_WORKDIR"/*.sql "$RECOVERY_WORKDIR/source-manifest.json" \
  > "$RECOVERY_WORKDIR/plaintext-sha256.txt"
tar -C "$RECOVERY_WORKDIR" -cf "$RECOVERY_WORKDIR/xau-recovery.tar" \
  roles.sql schema.sql data.sql history-schema.sql history-data.sql \
  source-manifest.json plaintext-sha256.txt
age -r "$RECOVERY_AGE_RECIPIENT" \
  -o "$RECOVERY_WORKDIR/xau-recovery.tar.age" \
  "$RECOVERY_WORKDIR/xau-recovery.tar"
sha256sum "$RECOVERY_WORKDIR/xau-recovery.tar.age" \
  > "$RECOVERY_WORKDIR/xau-recovery.tar.age.sha256"
age --decrypt -i '<operator identity file>' \
  "$RECOVERY_WORKDIR/xau-recovery.tar.age" > /dev/null
```

Transfer only `xau-recovery.tar.age` and its encrypted-artifact checksum to the
approved off-site location. Confirm access using the designated recovery
identity. Plaintext cleanup must follow the organization's secure-media policy;
ordinary deletion is not claimed as secure erasure on SSDs or snapshots.

## 6. Restore only into the isolated target

Before the restore, re-verify the target ref and the absence of routes,
functions, schedules, and application secrets. Supabase warns that new-project
default privileges can grant excess table privileges, so revoke those defaults
before restoring the schema.

### 6.1 V3 verified-backup resume and managed-parameter compatibility

For an authorized V3 resume, decrypt the previously verified encrypted artifact
into a new private work directory. Do not reuse or edit plaintext from a failed
restore directory. Verify the embedded plaintext ledger against the files in the **new**
`RECOVERY_WORKDIR` before doing anything with the SQL files:

```bash
node scripts/verify_recovery_plaintext.mjs \
  "$RECOVERY_WORKDIR/plaintext-sha256.txt" \
  "$RECOVERY_WORKDIR" \
  > "$RECOVERY_WORKDIR/plaintext-verification.json"
```

The capture-time ledger may contain absolute paths from the original private
work directory. The verifier treats those paths only as recorded provenance:
it requires exactly the six reviewed recovery basenames, resolves every file
from the newly decrypted `RECOVERY_WORKDIR`, rejects symlinks/escapes, and
recomputes each SHA-256 there. It never follows the old absolute ledger paths.
Any missing, duplicate, unexpected, non-regular, escaped, or checksum-drifted
file means `STOP`.

The original `roles.sql` must remain immutable. First prove that the isolated
target already has exactly the platform-managed privilege that caused the prior
restore to stop:

```bash
TARGET_MANAGED_PARAMETER_ACL_COUNT="$(
  psql --dbname "$TARGET_DB_URL" -X -Atqc "
    SELECT count(*)
    FROM pg_catalog.pg_parameter_acl p
    CROSS JOIN LATERAL pg_catalog.aclexplode(p.paracl) a
    WHERE p.parname='log_min_messages'
      AND pg_catalog.pg_get_userbyid(a.grantee)='supabase_realtime_admin'
      AND a.privilege_type='SET'
      AND pg_catalog.pg_get_userbyid(a.grantor)='supabase_admin';
  "
)"
test "$TARGET_MANAGED_PARAMETER_ACL_COUNT" = "1"
```

Then create a separate checksum-bound restore copy:

```bash
node scripts/prepare_recovery_roles.mjs \
  "$RECOVERY_WORKDIR/roles.sql" \
  "$RECOVERY_WORKDIR/plaintext-sha256.txt" \
  "$RECOVERY_WORKDIR/roles.restore.sql" \
  > "$RECOVERY_WORKDIR/roles-normalization.json"
```

The normalizer requires the checksum recorded for the original `roles.sql`,
exactly one occurrence of the reviewed
`GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";`
statement, a distinct output path, and a non-existing output file. It removes
nothing else. Missing, duplicated, altered, checksum-drifted, or broadened input
fails closed. Never replace the original `roles.sql`.

For a fresh full run, the same compatibility checks and derived
`roles.restore.sql` are required before restore.

Restore with `ON_ERROR_STOP=1` unchanged:

```bash
psql --variable ON_ERROR_STOP=1 --dbname "$TARGET_DB_URL" \
  --command 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;'
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file "$RECOVERY_WORKDIR/roles.restore.sql" \
  --file "$RECOVERY_WORKDIR/schema.sql" \
  --command 'SET session_replication_role = replica' \
  --file "$RECOVERY_WORKDIR/data.sql" \
  --dbname "$TARGET_DB_URL"
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file "$RECOVERY_WORKDIR/history-schema.sql" \
  --file "$RECOVERY_WORKDIR/history-data.sql" \
  --dbname "$TARGET_DB_URL"
unset TARGET_DB_URL
```

Any non-zero command means `FAIL`; do not partially waive errors. Custom login
role passwords are intentionally not present in logical backups and must be
reset separately if such roles exist. Do not attach the target to an app.

## 7. Prove equivalence

```bash
export PGHOST='<target session-pooler host>'
export PGPORT='5432'
export PGDATABASE='postgres'
export PGUSER='postgres.<approved-target-ref>'
read -r -s -p 'Target database password: ' PGPASSWORD
echo
export PGPASSWORD
export RECOVERY_MANIFEST_ROLE='target'
export RECOVERY_PROJECT_REF='<approved-target-ref>'
export RECOVERY_REHEARSAL='YES'
node scripts/recovery_manifest.mjs capture > "$RECOVERY_WORKDIR/target-manifest.json"
node scripts/recovery_manifest.mjs compare \
  "$RECOVERY_WORKDIR/source-manifest.json" \
  "$RECOVERY_WORKDIR/target-manifest.json" \
  > "$RECOVERY_WORKDIR/comparison-result.json"
unset PGPASSWORD RECOVERY_REHEARSAL RECOVERY_MANIFEST_ROLE RECOVERY_PROJECT_REF
```

Success requires `status: PASS`. The comparator requires the same PostgreSQL
major version and exact equality of:

- complete Supabase migration history;
- exact row counts for every base/partitioned table in `public` and
  `supabase_migrations`;
- public relations, columns/defaults, functions and body hashes, constraints,
  indexes, policies, triggers, view hashes, enums, and installed extension
  names.

The target guard refuses the production project ref. The report contains no
row contents or credentials.

## 8. Evidence and gate closure

Store the following in the approved evidence system, never in git:

```text
RECOVERY_OPTION=A
RECOVERY_OPERATOR=<name>
CHANGE_REFERENCE=<ticket/change id>
SOURCE_PROJECT_REF=ejvwmjgfvhsslqiydwpz
TARGET_PROJECT_REF=<non-production ref>
CAPTURED_AT=<ISO-8601 UTC>
SUPABASE_CLI_VERSION=<version>
PSQL_VERSION=<version>
ENCRYPTED_ARTIFACT_LOCATION=<restricted off-site reference>
ENCRYPTED_ARTIFACT_SHA256=<64 hex>
SOURCE_MANIFEST_SHA256=<64 hex>
PLAINTEXT_VERIFICATION_RESULT_SHA256=<64 hex>
SOURCE_ROLES_SHA256=<64 hex>
RESTORE_ROLES_SHA256=<64 hex>
ROLES_NORMALIZATION_RESULT_SHA256=<64 hex>
MANAGED_PARAMETER_ACL_COMPATIBILITY=PASS
RESUME_SOURCE_ARTIFACT_SHA256=<64 hex or N/A for full run>
RESTORE_STARTED_AT=<ISO-8601 UTC>
RESTORE_FINISHED_AT=<ISO-8601 UTC>
COMPARISON_STATUS=PASS
COMPARISON_RESULT_SHA256=<64 hex>
PLAINTEXT_CLEANUP_EVIDENCE=<reference>
DECRYPTION_VERIFIED=YES
RECOVERY_REVIEW_MODE=INDEPENDENT_REVIEWER|SOLO_OPERATOR_EXCEPTION
SEGREGATION_OF_DUTIES=FULL|REDUCED
OPERATOR_SIGN_OFF=<name and ISO-8601>
REVIEWER_SIGN_OFF=<different person's name and ISO-8601; NONE only in SOLO_OPERATOR_EXCEPTION>
AUTOMATED_SECONDARY_AUDIT=<tool, ISO-8601, result PASS|FAIL, and record reference>
```

In `INDEPENDENT_REVIEWER` mode the recovery gate closes only after the human
reviewer verifies all fields, the encrypted artifact can be accessed by the
recovery identity, and the exact comparison passes.

In `SOLO_OPERATOR_EXCEPTION` mode no human reviewer exists and none may be
invented: `REVIEWER_SIGN_OFF=NONE` and `SEGREGATION_OF_DUTIES=REDUCED`. The
gate closes only after the operator/owner signs off, `COMPARISON_STATUS=PASS`
comes from the comparator itself, decryption with the recovery identity is
verified, every field above is complete, and a post-run automated secondary
audit has recomputed the recorded SHA-256 values and confirmed each field. That
audit is recorded only as `AUTOMATED_SECONDARY_AUDIT`; it is never represented
as a human reviewer or as reviewer sign-off. Any mismatch or audit `FAIL`
means `STOP`, and the gate stays open.

This does not authorize migrations 0029–0034 or runtime.

## 9. Official references frozen for this procedure

- [Database backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase CLI `db dump`](https://supabase.com/docs/reference/cli/supabase-db-dump)
- [Backup and restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

Re-read these sources at execution time because CLI and platform behavior can
change. Any material command or scope change requires a new review.

