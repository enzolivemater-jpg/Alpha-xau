# XAU V2 — REC-1 execution authorization packet

Status: `READY FOR ONE-RESPONSE HUMAN DECISION — NOT AUTHORIZED`

Captured: `2026-10-01T07:46Z`  
Production project: `ejvwmjgfvhsslqiydwpz`

This packet authorizes only a read-only production manifest capture and logical
database dump, encrypted off-site retention, and an isolated non-production
restore rehearsal under the merged REC-1 runbook. It never authorizes a
production restore, migration, runtime deployment, route, schedule, secret
rotation, provider purchase, or broker/trading action.

## 1. Exact requested action

A named operator executes
[`XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md`](XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md)
without modification:

1. capture a read-only production equivalence manifest;
2. export roles, application schema, application data, and migration history
   with the current official Supabase CLI flow;
3. encrypt the bundle before off-site transfer;
4. restore it only into the approved isolated target;
5. capture the target manifest and require exact comparator `PASS`;
6. store the non-secret evidence ledger and obtain operator/reviewer sign-off.

Frozen implementation hashes:

| Item | SHA-256 |
| --- | --- |
| `scripts/recovery_manifest.mjs` | `9d0d3ea003a0ad87885e4e3297570e10dc804f301df1b650e20d2834da71ec70` |
| `docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md` | `9bbfbfd683833c1c189fa8155297884a88336c41f3f5961643ff1b312d21ceee` |

The two implementation hashes above are the frozen REC-1 payload. A change to
either file invalidates this packet and requires a new review. The current
40-hex `main` SHA is intentionally supplied by the approver at execution time:
hard-coding it in this document would make the packet invalidate itself when
its own commit is merged. Any repository change after approval invalidates the
approval until `FINAL_MAIN_SHA` is reconciled again.

### Payload revision — 2026-10-02 (current Supabase backup flow)

The frozen REC-1 payload changed. **Every previous REC-1 execution approval is
stale and void**, including any approval that quoted the earlier script hash
`526c41fb…458a` or runbook hash `b30e65c5…7b17`. Execution requires a new
approval carrying the hashes above.

Material changes, both from the current official Supabase guidance:

1. The data dump now carries `-x "storage.buckets_vectors"` and
   `-x "storage.vector_indexes"`, matching the current backup/restore guide.
2. Source and target capture run a fail-closed managed-schema guard before any
   dump. It stops on project-owned `auth`/`storage` RLS policies, triggers,
   relations, functions, or publication entries, and on rows in `auth.users`,
   `storage.buckets`, `storage.objects`, or `vault.secrets`. Supabase states
   that `auth`/`storage` customizations need separate restoration, and that
   Vault-encrypted data is unrecoverable without the source root key. REC-1
   carries neither.

No other REC-1 guarantee changed.

## 2. Why it is needed

Production is on Supabase Free and no verified restorable recovery point is
currently evidenced. Event Facts production rollout is blocked until a fresh
backup has been restored successfully in isolation. A dump alone does not
close the gate.

## 3. Current preflight evidence

Read-only reconciliation at `2026-10-01T07:46Z` confirms:

- project `ACTIVE_HEALTHY`, PostgreSQL 17.6;
- live migration tail `20260923133811 gold_transmission_atomic_rpc`;
- 45 Event Clusters, 45 Event Versions, 0 identity claims, and 3 historical
  Gold Transmission assessments;
- no `official_source_artifacts` or `event_fact_production_operations` table;
- migrations 0029–0034 are not live-applied;
- no Edge Function and no installed `pg_cron`;
- SB-1/SB-2 live findings remain unchanged, as expected.

## 4. Target decision

Choose exactly one:

### A — new dedicated disposable project (lowest blast radius)

Create or designate a clean non-production Supabase project with no routes,
functions, schedules, application secrets, or users. Cost/project-limit
approval is separate if the Free allowance cannot host it.

### B — reset EF-12 staging (fastest existing-resource path)

Target `viskjhkkcnzqxkuvibdx`. It currently has zero Event Facts/GT proof rows,
no Edge Function, and no cron, but contains the EF-12 proof schema. Resetting it
is destructive to that hosted staging schema. The durable EF-12 evidence in git
survives; rebuilding the staging schema later would require rerunning its
bootstrap and migrations. This option requires explicit
`TARGET_RESET_AUTHORIZED=YES`.

The production ref can never be a target. Any other target requires a fresh
read-only inventory before approval.

## 5. Expected effect and blast radius

- Production: read-only catalog/count queries plus logical dump reads; possible
  temporary load and longer query duration, but no intended write or downtime.
- Target: schema/data replacement within the chosen isolated project; target
  contents may be destroyed.
- Off-site store: one encrypted database artifact plus checksums/evidence.
- Application/runtime: remains disconnected and off.

Stop immediately on target ambiguity, active production writer, source drift,
missing tool/version, dump/restore error, checksum failure, comparator mismatch,
credential exposure, or unexpected platform behavior.

## 6. Preconditions

- named operator and independent reviewer;
- approved UTC maintenance window;
- approved target mode/ref and destructive reset authority when applicable;
- approved restricted off-site destination and working encryption recipient;
- Supabase CLI, Docker, PostgreSQL 17 `psql`, `age`, and `sha256sum` verified;
- runtime/writers reconfirmed off;
- no shell tracing/history leakage;
- source and target credentials supplied out of band;
- current docs and CLI `--help` rechecked at execution time.

## 7. Recovery and rollback

Production receives no intended mutation, so abort consists of terminating the
read/dump process and recording failure. A partially reset/restored target is
discarded or rebuilt; it must never be connected to an application. Plaintext
artifacts follow the approved secure-media cleanup policy. The encrypted source
bundle is accepted only after decryption verification and an exact isolated
restore comparison.

## 8. Remaining uncertainty

- final operator and reviewer identities;
- target mode and project capacity/cost;
- approved encrypted off-site destination;
- execution-window production load;
- external objects excluded by logical database dumps, including Storage API
  objects, Edge Functions, project secrets, Auth provider settings, domains,
  and DNS. The current project inventory shows no Edge Function; other excluded
  asset classes must be recorded explicitly by the operator.

## 9. Exact approval response

The owner must return every line below with placeholders replaced. Option A
uses a new target and `TARGET_RESET_AUTHORIZED=NO`; Option B must use the frozen
EF-12 ref and `TARGET_RESET_AUTHORIZED=YES`.

```text
REC1_EXECUTION_AUTHORIZED=YES
RECOVERY_OPERATOR=<full name>
RECOVERY_REVIEWER=<full name, different person if available>
MAINTENANCE_WINDOW_UTC=<start/end ISO-8601>
TARGET_MODE=NEW_DEDICATED_PROJECT|RESET_EF12_STAGING
TARGET_PROJECT_REF=<20-character non-production ref>
TARGET_RESET_AUTHORIZED=YES|NO
ENCRYPTED_OFFSITE_LOCATION=<restricted destination reference>
ENCRYPTION_RECIPIENT_CONFIRMED=YES
FINAL_MAIN_SHA=<current 40-hex main SHA verified immediately before execution>
REC1_SCRIPT_SHA256=9d0d3ea003a0ad87885e4e3297570e10dc804f301df1b650e20d2834da71ec70
REC1_RUNBOOK_SHA256=9bbfbfd683833c1c189fa8155297884a88336c41f3f5961643ff1b312d21ceee
PRODUCTION_READ_ONLY_CAPTURE_AND_DUMP_AUTHORIZED=YES
PRODUCTION_RESTORE_AUTHORIZED=NO
MIGRATIONS_0029_0034_AUTHORIZED=NO
RUNTIME_AUTHORIZED=NO
APPROVER=<full name>
APPROVED_AT=<ISO-8601>
```

Missing, ambiguous, stale, contradictory, or mismatched fields mean `STOP`.
Generic language such as “continue”, “validate”, or “I authorize” does not
authorize credential use, production extraction, or target destruction.

At execution preflight, the operator must verify that `FINAL_MAIN_SHA` equals
the remote `main` head and recompute both REC-1 SHA-256 values from that exact
checkout. A mismatch, uncommitted file, or subsequent commit means `STOP` and
requires renewed approval with the new SHA.
