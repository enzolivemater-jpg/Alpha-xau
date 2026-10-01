# XAU V2 — Event Facts production authorization packet

Status: `EF-13 READY FOR HUMAN DECISION — PRODUCTION HOLD`

Captured: `2026-09-30`  
Production project: `ejvwmjgfvhsslqiydwpz` (`ALPHA-XAU-TERMINAL`)  
Region: `eu-west-3`  
Candidate base SHA: `8956912232bda5a1831515e352a3eedffba1cbdc`

This packet turns the remaining production Human Gates into explicit decisions.
It records read-only evidence only. It does not authorize or perform a backup,
plan upgrade, migration, live smoke test, Worker deployment, route, or schedule.

## 1. Frozen migration payload

The only permitted schema payload is this dependency-ordered set:

| Order | Migration | SHA-256 |
| --- | --- | --- |
| 1 | `0029_event_facts_ces_v2_persistence.sql` | `3fd67ee2678d90038e402058c027329876dcd5473286c1a1b661ee5e284e46bb` |
| 2 | `0030_official_source_artifacts.sql` | `b624446fe304f37b001cececf433dcad78c077d4e0ac372d35157206e4b7b049` |
| 3 | `0031_event_identity_active_lookup.sql` | `6283c712421198c2af6c96a29331ed8d3db057794cc19551279c1849e54a1d9c` |
| 4 | `0032_event_facts_atomic_production.sql` | `450583dac5df83770c5df8f99b24ba467558d56338e4369c85ba0fef245193b5` |

The production authority must approve the final merged `main` SHA, not merely
the candidate base SHA above. Any hash or SHA difference invalidates approval.

## 2. Production read-only reconciliation

The production preflight was repeated on 2026-09-30:

- project state is `ACTIVE_HEALTHY`; PostgreSQL reports `17.6`;
- live migration history still ends at
  `20260923133811 gold_transmission_atomic_rpc`;
- all seven required Event Cluster RPCs are present with the reviewed identity
  arguments, `SECURITY INVOKER`, and `search_path=""`;
- migrations 0029–0032 have no live migration records;
- `official_source_artifacts`, `event_version_official_artifacts`, and
  `event_fact_production_operations` are absent;
- all five functions introduced by 0029–0032 are absent;
- current estimated foundation counts are 45 `event_clusters`, 45
  `event_versions`, and 0 `event_cluster_identity_claims`;
- no Edge Function is deployed;
- `pg_cron` is not installed and `cron.job` is absent.

This evidence is time-bound. Repeat the complete preflight immediately before
an authorized execution and stop on any drift.

## 3. Recovery gate — confirmed blocker

The production organization is on the Supabase `Free` plan. Supabase documents
automatic daily backups for Pro, Team, and Enterprise projects and recommends
that Free projects export with `supabase db dump` and maintain off-site
backups. PITR is an add-on for Pro, Team, and Enterprise and additionally
requires at least Small compute. See the official
[Database Backups documentation](https://supabase.com/docs/guides/platform/backups).

No current restorable production backup, restore rehearsal, or named recovery
operator has been evidenced. Therefore recovery readiness is `BLOCKED`.

REC-1 now provides a reviewed operator procedure and a fail-closed manifest
comparator in
[`XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md`](XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md).
The kit is code-proven only: it has not captured production, created a backup,
restored a target, or assigned an operator, so it does not close this gate.

Exactly one recovery decision must be approved and evidenced:

### Option A — verified logical backup and isolated restore rehearsal

1. Name the recovery operator.
2. Generate a fresh production logical backup with the official Supabase CLI
   workflow; keep credentials out of logs and the repository.
3. Store the encrypted backup off-site with access limited to the recovery
   operator.
4. Restore it into an isolated non-production project.
5. Verify migration history, schema objects, representative row counts, and
   application-critical constraints.
6. Record backup time, tool versions, encrypted artifact location, restore
   target, restore result, and operator sign-off. Do not record credentials.

This is the recommended no-plan-upgrade path. A dump without a successful
isolated restore rehearsal does not satisfy the gate.

### Option B — managed recovery capability

Approve the Supabase plan/compute cost, enable an eligible managed backup or
PITR configuration, wait until a usable recovery point exists, verify it, and
name the recovery operator. Purchasing capability alone does not prove a
restorable recovery point.

### Option C — remain on hold

Make no production change. This is the required outcome until A or B is
completed.

## 4. Pre-existing advisor findings

The read-only production advisor snapshot contains findings that predate and
are outside the four Event Facts migrations:

- security: 6 `security_definer_view` errors, 5 mutable-function-search-path
  warnings, and 23 RLS-enabled/no-policy informational findings;
- performance: 19 unindexed-foreign-key and 47 unused-index informational
  findings.

The no-policy pattern is intentional for the service-role-only Event Cluster
tables, but the six security-definer views and five mutable search paths are
not silently waived here. SB-1 supplies the separately tested migration
`0033_security_baseline_hardening.sql`, but it is not live-applied and needs its
own authorization. It does not authorize editing unrelated production objects
during EF rollout.

## 5. Authorization ledger

| Gate | Required evidence / decision | Current state |
| --- | --- | --- |
| Isolated staging | EF-12 hosted Supabase PostgreSQL 17.11 proof | `COMPLETE` |
| Recovery | Option A or B complete; named operator | `BLOCKED — OPERATOR UNASSIGNED` |
| Production migration | Final `main` SHA plus all four hashes approved | `NOT AUTHORIZED` |
| Fingerprint ownership | Named durable producer and reuse policy | `UNASSIGNED` |
| Consensus | Named provider, or explicit `UNKNOWN` policy | `UNDECIDED` |
| Schema smoke proof | Separate approval after migration | `NOT AUTHORIZED` |
| Runtime | Manual shadow caller approval after schema proof | `NOT AUTHORIZED` |

## 6. Exact approval record

The approver must fill and approve all fields below without changing the
payload:

```text
RECOVERY_OPTION=A|B
RECOVERY_OPERATOR=<name>
RECOVERY_EVIDENCE=<reference>
FINAL_MAIN_SHA=<40-hex SHA>
MIGRATION_HASHES_APPROVED=YES
FINGERPRINT_OWNER=<component and accountable owner>
FINGERPRINT_POLICY=LOWERCASE_SHA256_PER_IMMUTABLE_INTENT
CONSENSUS_POLICY=<authorized provider>|UNKNOWN
SCHEMA_MIGRATION_AUTHORIZED=YES
RUNTIME_AUTHORIZED=NO
APPROVER=<name>
APPROVED_AT=<ISO-8601>
```

Missing, ambiguous, stale, or mismatched fields mean `STOP`. Generic language
such as “continue”, “validate”, or “I authorize” does not substitute for this
scoped record because it does not identify the recovery evidence, release SHA,
operator, and policy owners.

## 7. Current decision

Production remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`. The next safe
action is a human choice of recovery Option A, B, or C. Even after recovery is
proved, migration and runtime authorities remain separate decisions.
