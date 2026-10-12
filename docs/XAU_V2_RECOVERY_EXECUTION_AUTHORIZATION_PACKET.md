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
6. store the non-secret evidence ledger and obtain sign-off under the approved
   review mode (§6a).

Frozen implementation hashes:

| Item | SHA-256 |
| --- | --- |
| `scripts/recovery_manifest.mjs` | `9d0d3ea003a0ad87885e4e3297570e10dc804f301df1b650e20d2834da71ec70` |
| `docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md` | `cf431d92e97405c692ebb5189883652923676f12ed7558b609b586ad63c07b8b` |

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

### Payload revision — 2026-10-12 (review mode and solo-operator exception)

The frozen runbook changed. **Every previous REC-1 execution approval is stale
and void**, including any approval that quoted runbook hash `9bbfbfd6…ceee`.
`scripts/recovery_manifest.mjs` is unchanged.

The only material change is governance: an explicit review mode (§6a) with
`INDEPENDENT_REVIEWER` as the default and a narrowly bounded
`SOLO_OPERATOR_EXCEPTION`. No command, guard, comparator rule, target rule, or
stop condition changed.

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

- named operator and, by default, a named independent human reviewer; the
  §6a solo-operator exception is the only alternative;
- approved UTC maintenance window;
- approved target mode/ref and destructive reset authority when applicable;
- approved restricted off-site destination and working encryption recipient;
- Supabase CLI, Docker, PostgreSQL 17 `psql`, `age`, and `sha256sum` verified;
- runtime/writers reconfirmed off;
- no shell tracing/history leakage;
- source and target credentials supplied out of band;
- current docs and CLI `--help` rechecked at execution time.

## 6a. Review mode

`RECOVERY_REVIEW_MODE=INDEPENDENT_REVIEWER` is the default and preferred rule:
a named human reviewer who is a different person from the operator verifies
the Step 8 evidence and signs off.

`RECOVERY_REVIEW_MODE=SOLO_OPERATOR_EXCEPTION` is an explicit exception. It is
valid only when **all** of the following hold; if any one fails, the exception
is unavailable and `STOP` applies:

1. no independent human reviewer is reasonably available, and the approval
   records a non-secret `SOLO_OPERATOR_JUSTIFICATION`;
2. the owner explicitly approves `SOLO_OPERATOR_EXCEPTION=YES` in the §9
   response;
3. production access remains read-only capture and dump only;
   `PRODUCTION_RESTORE_AUTHORIZED=NO`;
4. the target is non-production only, under §4;
5. `FINAL_MAIN_SHA`, `REC1_SCRIPT_SHA256`, and `REC1_RUNBOOK_SHA256` match
   exactly and are recomputed at execution preflight, and every command runs
   from that checkout without modification;
6. the local tooling preflight is `PASS`;
7. source and target manifests are compared by `recovery_manifest.mjs compare`
   with exact `status: PASS`; no human judgement can substitute for it;
8. decryption of the encrypted bundle with the recovery identity is verified;
9. the runbook Step 8 evidence ledger is complete;
10. a post-run automated secondary audit (for example ChatGPT/Claude or a
    script) recomputes the recorded SHA-256 values, checks every ledger field,
    and is recorded as `AUTOMATED_SECONDARY_AUDIT`. It is never represented as
    a human reviewer or reviewer sign-off;
11. any mismatch, missing field, error, or audit `FAIL` causes `STOP`.

Assurance statement: in this mode one person performs and approves the
operation. Segregation of duties is **reduced**, not equivalent to an
independent human review. The ledger must record
`SEGREGATION_OF_DUTIES=REDUCED`, and `RECOVERY_REVIEWER` and
`REVIEWER_SIGN_OFF` must be `NONE`. No reviewer identity may be invented, and
the operator, Claude, ChatGPT, or any other tool may not be named as reviewer.

Scope: this exception applies only to REC-1. It grants no migration,
deployment, runtime, route, schedule, secret, provider, broker, or trading
authority, and it does not change the reviewer rule of any other gate.

## 7. Recovery and rollback

Production receives no intended mutation, so abort consists of terminating the
read/dump process and recording failure. A partially reset/restored target is
discarded or rebuilt; it must never be connected to an application. Plaintext
artifacts follow the approved secure-media cleanup policy. The encrypted source
bundle is accepted only after decryption verification and an exact isolated
restore comparison.

## 8. Remaining uncertainty

- final operator identity and review mode (reviewer identity in
  `INDEPENDENT_REVIEWER` mode);
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
RECOVERY_REVIEW_MODE=INDEPENDENT_REVIEWER|SOLO_OPERATOR_EXCEPTION
RECOVERY_REVIEWER=<full name of a different person, or NONE only in SOLO_OPERATOR_EXCEPTION mode>
SOLO_OPERATOR_EXCEPTION=YES|NO
SOLO_OPERATOR_JUSTIFICATION=<non-secret rationale, or N/A in INDEPENDENT_REVIEWER mode>
AUTOMATED_SECONDARY_AUDIT_REQUIRED=YES
MAINTENANCE_WINDOW_UTC=<start/end ISO-8601>
TARGET_MODE=NEW_DEDICATED_PROJECT|RESET_EF12_STAGING
TARGET_PROJECT_REF=<20-character non-production ref>
TARGET_RESET_AUTHORIZED=YES|NO
ENCRYPTED_OFFSITE_LOCATION=<restricted destination reference>
ENCRYPTION_RECIPIENT_CONFIRMED=YES
FINAL_MAIN_SHA=<current 40-hex main SHA verified immediately before execution>
REC1_SCRIPT_SHA256=9d0d3ea003a0ad87885e4e3297570e10dc804f301df1b650e20d2834da71ec70
REC1_RUNBOOK_SHA256=cf431d92e97405c692ebb5189883652923676f12ed7558b609b586ad63c07b8b
PRODUCTION_READ_ONLY_CAPTURE_AND_DUMP_AUTHORIZED=YES
PRODUCTION_RESTORE_AUTHORIZED=NO
MIGRATIONS_0029_0034_AUTHORIZED=NO
RUNTIME_AUTHORIZED=NO
APPROVER=<full name>
APPROVED_AT=<ISO-8601>
```

Review-mode fields must agree: `INDEPENDENT_REVIEWER` requires
`SOLO_OPERATOR_EXCEPTION=NO` and a named reviewer who is not the operator;
`SOLO_OPERATOR_EXCEPTION` requires `SOLO_OPERATOR_EXCEPTION=YES`,
`RECOVERY_REVIEWER=NONE`, a non-empty justification, and the owner as
`APPROVER`.

Missing, ambiguous, stale, contradictory, or mismatched fields mean `STOP`.
Generic language such as “continue”, “validate”, or “I authorize” does not
authorize credential use, production extraction, or target destruction.

At execution preflight, the operator must verify that `FINAL_MAIN_SHA` equals
the remote `main` head and recompute both REC-1 SHA-256 values from that exact
checkout. A mismatch, uncommitted file, or subsequent commit means `STOP` and
requires renewed approval with the new SHA.
