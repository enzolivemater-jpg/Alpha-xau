# XAU V2 — REC-1 execution authorization packet

Status: `REC-1 V3 FROZEN — RESUME NOT AUTHORIZED`

Captured: `2026-10-01T07:46Z`

V3 correction frozen: `2026-10-12`

Production project: `ejvwmjgfvhsslqiydwpz`

This packet does not itself authorize execution. The V3 resume path uses only
the already captured and verified encrypted backup, then restores it into an
isolated non-production target. It authorizes no new production access or dump,
production restore, migration, runtime deployment, route, schedule, secret
rotation, provider purchase, or broker/trading action.

## 1. Exact requested action

A named operator resumes
[`XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md`](XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md)
without modification:

1. verify and decrypt the existing encrypted artifact in a private work area;
2. verify the original `roles.sql` against its included checksum ledger;
3. produce a distinct `roles.restore.sql` that omits exactly the reviewed
   platform-managed `log_min_messages` privilege statement;
4. restore it only into the approved isolated target with `ON_ERROR_STOP=1`;
5. capture the target manifest and require exact comparator `PASS`;
6. store the non-secret evidence ledger and obtain operator/reviewer sign-off.

Frozen implementation hashes:

| Item | SHA-256 |
| --- | --- |
| `scripts/recovery_manifest.mjs` | `9d0d3ea003a0ad87885e4e3297570e10dc804f301df1b650e20d2834da71ec70` |
| `scripts/prepare_recovery_roles.mjs` | `623f1640422028719556da71c97c8e11391a273de7358d327431559573df91dd` |
| `docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md` | `f94774fec208b38c440aacce61f4994aa2dabc0cfdc32125e1c40d652b72c052` |

The three implementation hashes above are the frozen REC-1 V3 payload. A
change to any file invalidates this packet and requires a new review. Production
freeze keeps `main` at `a4bdd6d43d048f98dc7e506537a82d4f7488d119`; V3 is
therefore executed only from its separately reviewed commit, without merging.
The approver binds that 40-hex commit at execution time because a commit cannot
embed its own SHA. Any V3 branch change after approval invalidates the approval.

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

### Payload revision — 2026-10-12 (managed parameter privilege)

The failed restore exposed one exact source dump statement:

```sql
GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";
```

Supabase documents that managed projects do not expose full superuser access
and that reserved settings such as `log_min_messages` are mediated by platform
privileges. V3 never weakens `ON_ERROR_STOP`; instead it verifies the immutable
source dump hash and creates a separate restore file that omits exactly that
one reviewed statement. Unknown variants, duplicates, missing statements,
checksum drift, or an existing output file fail closed.

All earlier REC-1 payload approvals and hashes are stale. The authorization
given on 2026-10-12 covers only this correction, local validation, and re-freeze;
it does not authorize the target restore or any production access.

## 2. Why it is needed

The encrypted backup has been captured and verified, but it is not yet a proven
restorable recovery point. Event Facts production rollout remains blocked until
that exact backup passes the isolated restore comparison. A dump alone does not
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

The 2026-10-12 operator report additionally confirms that tooling preflight is
`PASS`, the encrypted backup is already verified, and restore stopped at the
managed `log_min_messages` privilege without waiving the error.

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

- Production: no access in the V3 resume path; the existing verified encrypted
  artifact is the only permitted source.
- Target: schema/data replacement within the chosen isolated project; target
  contents may be destroyed.
- Off-site store: one encrypted database artifact plus checksums/evidence.
- Application/runtime: remains disconnected and off.

Stop immediately on target ambiguity, active production writer, source drift,
missing tool/version, dump/restore error, checksum failure, comparator mismatch,
credential exposure, or unexpected platform behavior.

## 6. Preconditions

- named operator and independent reviewer;
- approved restore window;
- approved target mode/ref and destructive reset authority when applicable;
- approved restricted off-site destination and working encryption recipient;
- Supabase CLI, Docker, PostgreSQL 17 `psql`, `age`, and `sha256sum` verified;
- target routes and writers reconfirmed off;
- no shell tracing/history leakage;
- target credentials and recovery identity supplied out of band;
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
REC1_V3_RESUME_AUTHORIZED=YES
RECOVERY_OPERATOR=<full name>
RECOVERY_REVIEWER=<full name, different person if available>
RESTORE_WINDOW_UTC=<start/end ISO-8601>
TARGET_MODE=NEW_DEDICATED_PROJECT|RESET_EF12_STAGING
TARGET_PROJECT_REF=<20-character non-production ref>
TARGET_RESET_AUTHORIZED=YES|NO
ENCRYPTED_OFFSITE_LOCATION=<restricted destination reference>
ENCRYPTION_RECIPIENT_CONFIRMED=YES
FROZEN_MAIN_SHA=a4bdd6d43d048f98dc7e506537a82d4f7488d119
REC1_V3_COMMIT_SHA=<reviewed 40-hex V3 branch commit>
REC1_SCRIPT_SHA256=9d0d3ea003a0ad87885e4e3297570e10dc804f301df1b650e20d2834da71ec70
REC1_ROLES_NORMALIZER_SHA256=623f1640422028719556da71c97c8e11391a273de7358d327431559573df91dd
REC1_RUNBOOK_SHA256=f94774fec208b38c440aacce61f4994aa2dabc0cfdc32125e1c40d652b72c052
USE_EXISTING_VERIFIED_BACKUP_ONLY=YES
PRODUCTION_ACCESS_AUTHORIZED=NO
PRODUCTION_RESTORE_AUTHORIZED=NO
MIGRATIONS_0029_0034_AUTHORIZED=NO
RUNTIME_AUTHORIZED=NO
APPROVER=<full name>
APPROVED_AT=<ISO-8601>
```

Missing, ambiguous, stale, contradictory, or mismatched fields mean `STOP`.
Generic language such as “continue”, “validate”, or “I authorize” does not
authorize credential use, production extraction, or target destruction.

At execution preflight, the operator must verify that remote `main` still equals
`FROZEN_MAIN_SHA`, check out exactly `REC1_V3_COMMIT_SHA`, and recompute all
three REC-1 V3 SHA-256 values there. A mismatch, uncommitted file, merge, or
subsequent V3 commit means `STOP` and requires renewed approval.
