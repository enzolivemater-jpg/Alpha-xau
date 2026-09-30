# XAU V2 — Event Facts activation runbook

Status: `REVIEWED HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`

This runbook closes EF-11. It defines the future database rollout and proof
sequence for the reviewed BLS CPI Event Facts path. It does not authorize a
live migration, deploy a Worker, enable a route or schedule, or write
production data.

## 1. Reconciled live baseline — 2026-09-30

- Supabase project `ALPHA-XAU-TERMINAL` is `ACTIVE_HEALTHY` in `eu-west-3`.
- PostgreSQL reports `17.6`; `pgcrypto` 1.3 is installed in `extensions`.
- Live migration history ends at
  `20260923133811 gold_transmission_atomic_rpc`.
- The Event Cluster foundation, membership, identity-claim, and Event Version
  RPC dependencies are present.
- `official_source_artifacts`, `event_version_official_artifacts`, and
  `event_fact_production_operations` are absent.
- The CES V2 validator, active identity lookup, and atomic CPI producer RPC are
  absent.
- No route or schedule calls EF-10.

The baseline must be reconciled again immediately before any future execution.
This dated snapshot is evidence, not permission.

## 2. Human Gates

All gates below are mandatory. Any unresolved gate means `STOP`.

1. **Staging choice:** create and prove an isolated Supabase branch/project, or
   explicitly accept the absence of a platform-identical staging environment.
   PostgreSQL 17 CI remains necessary but is not silently treated as that
   decision.
2. **Recovery readiness:** verify a current restorable backup/PITR position and
   name the operator responsible for recovery.
3. **Migration authority:** approve the exact main SHA and the exact four SQL
   file hashes. Never deploy from a mutable working tree.
4. **Fingerprint ownership:** approve the runtime component that creates and
   durably reuses the operation idempotency fingerprint. The recommended
   policy is one lowercase SHA-256 per immutable intent; a correction with new
   evidence receives a new fingerprint.
5. **Consensus boundary:** select an authorized consensus provider or keep all
   consensus states `UNKNOWN`. Schema deployment must not fabricate or infer a
   provider decision.
6. **Runtime authority:** separately approve a manual shadow caller after the
   schema proof. Database deployment never implies route, cron, or producer
   activation.

## 3. Preflight — read-only

Before execution, record all of the following in one evidence bundle:

- exact `main` SHA and clean repository state;
- current remote migration tail;
- PostgreSQL and installed-extension versions;
- existence and exact signatures of the Event Cluster dependency RPCs;
- absence of all objects introduced by migrations 0029–0032;
- row counts for `event_versions`, `event_cluster_identity_claims`, and
  `event_observation_memberships`;
- security and performance advisor snapshots;
- platform changelog review since the last proof.

The September 2026 PostgreSQL 17.11 platform change requires a fresh check at
execution time. The current Event Facts SQL uses `pgcrypto.digest`, not legacy
PGP cipher decryption, but the server version and the published detection
queries must still be reviewed before rollout.

Preflight fails if migration history has advanced unexpectedly, a target
object already exists without its expected migration record, a dependency
signature differs, or the selected release SHA is not the reviewed SHA.

## 4. Frozen migration order

Apply only this dependency order, never in parallel:

1. `0029_event_facts_ces_v2_persistence.sql`
2. `0030_official_source_artifacts.sql`
3. `0031_event_identity_active_lookup.sql`
4. `0032_event_facts_atomic_production.sql`

Rationale:

- 0029 installs the exact CES V1/V2 persistence gate used by 0032.
- 0030 installs the retained byte store referenced by both 0032 tables.
- 0031 exposes the read-only identity lookup needed by EF-7/EF-10.
- 0032 depends on all three and on the already-live Event Cluster RPCs.

Each file owns an explicit transaction. Apply one reviewed file, verify it,
record its remote migration entry, then continue. Do not edit a file after its
hash has been approved and do not repair migration history merely to suppress
a mismatch.

## 5. Per-migration hold points

### After 0029

- The validator signature is exactly `(smallint, jsonb)`.
- It is immutable, strict, parallel-safe, security-invoker, and has an empty
  search path.
- CES V1 rows still validate; the exact reviewed US CPI CES V2 fixture validates;
  malformed V2 and version 3 fail.
- `event_versions` row count and existing row hashes are unchanged.
- Only `service_role` can execute the validator.

### After 0030

- `official_source_artifacts` exists with RLS enabled and zero client policies.
- `service_role` has only `SELECT, INSERT`; `anon` and `authenticated` have no
  table privileges.
- Byte, content-hash, observation-hash, source-scope, size, and append-only
  contracts pass.
- The table remains empty after rollback-wrapped proof.

### After 0031

- The lookup signature is exactly `(text, text, text)`.
- It is stable, strict, parallel-safe, security-invoker, and has an empty
  search path.
- Only `service_role` can execute it.
- Zero, one, and collision cardinalities remain distinguishable in a
  rollback-wrapped proof.

### After 0032

- Both new tables have RLS enabled and zero client policies.
- `service_role` has only `SELECT, INSERT` on them; client roles have none.
- The producer signature exactly matches EF-9.
- All new functions are security-invoker with empty search paths.
- Every foreign key has its expected covering index.
- One rollback-wrapped PostgreSQL proof covers initial creation, exact replay,
  divergent-fingerprint rejection, and downstream rollback.
- All three Event Facts tables remain empty when the proof transaction ends.

## 6. Failure and rollback policy

Each migration is transactional. If its transaction fails, stop and preserve
the error evidence; do not retry blindly. Earlier successfully committed
migrations may remain present but inert because runtime activation is a
separate gate.

After a successful migration has been recorded, prefer a reviewed forward-fix
migration. Never delete migration-history rows, drop evidence tables, or remove
validated constraints ad hoc. A destructive rollback is allowed only through
the separately approved recovery plan and is forbidden after any committed
production Event Facts write.

## 7. Post-schema proof — runtime still off

After all four migrations pass:

1. capture remote migration history and advisor snapshots again;
2. verify grants, RLS, policies, function volatility/security/search paths,
   triggers, indexes, and empty row counts;
3. run the exact PostgreSQL 17 contract corpus against an isolated environment;
4. execute at most one explicitly approved rollback-wrapped live smoke proof;
5. confirm that no Worker route, cron, queue, or automatic discovery path is
   enabled.

The outcome at this point is `SCHEMA_READY_RUNTIME_OFF`, not production
activation.

## 8. Separate activation sequence

Only after a second Human Gate:

1. deploy a manual authenticated shadow caller with a one-item maximum;
2. supply exact retained observation/artifact identifiers and one durable
   operation fingerprint;
3. prove a first call and exact replay return the same committed identifiers;
4. verify no unexpected Event Cluster, Event Version, artifact, or operation
   rows were created;
5. stop and review before any schedule, discovery, or broader batch is proposed.

Automatic collection, cron activation, implicit retry, positive consensus,
directional Event Impact, and non-zero Gold Transmission logic remain outside
EF-11.

## 9. Current decision

The isolated staging-choice gate is complete. EF-12 proved the real migrations
0029–0032 in order on a separate hosted Supabase PostgreSQL 17.11 project; see
`XAU_V2_EVENT_FACTS_STAGING_PROOF.md`. Because the repository lacks the full
historical base migration, that proof uses an explicit minimal prerequisite
bootstrap and is not represented as a full production-schema clone.

Production remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`. Live execution
is not authorized until the recovery, production migration authority,
fingerprint, consensus, and runtime Human Gates are explicitly resolved.
