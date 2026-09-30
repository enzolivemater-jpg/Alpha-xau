# XAU V2 — Event Facts isolated staging proof

Status: `EF-12 PROVEN — SCHEMA READY ON ISOLATED STAGING / RUNTIME OFF`

Proof date: 2026-09-30

This evidence closes the EF-11 staging-choice gate for the reviewed BLS CPI
Event Facts path. It does not authorize production migration, runtime
deployment, a route, a schedule, collection, or a production write.

## 1. Isolated target

- Supabase project: `alpha-xau-ef12-staging`
- Project ref: `viskjhkkcnzqxkuvibdx`
- Organization: `Akteam` (`yhusjubgkjmergijqwih`)
- Region: `eu-west-3`
- Plan/cost quote: second Free project, `$0/month`
- PostgreSQL: `17.11`
- `pgcrypto`: `1.3` in schema `extensions`

The project contains no production data. Supabase Branching was unavailable
because the organization is on the Free plan, so this proof used a separate
hosted Supabase project.

## 2. Scope limitation

The repository does not contain migration `0001` or the full historical base
schema. This target is therefore not represented as a full production-schema
clone. It uses an explicit minimal staging bootstrap for the historical tables
required by the real Event Cluster and Event Facts migrations:

- `news_articles` with only the columns read by migrations 0012–0021 and the
  EF-8 atomic RPC;
- `ingestion_runs` and `data_sources` with one staging-only BLS fixture;
- the real, unmodified repository migrations 0012–0021;
- the real, unmodified repository migrations 0029–0032.

This proves the reviewed SQL and transaction behavior on hosted Supabase
PostgreSQL 17.11. It does not prove compatibility with unknown objects from the
missing historical base migration. Production preflight must still reconcile
the complete live schema immediately before any rollout.

## 3. Reviewed migration hashes

| Migration | SHA-256 |
| --- | --- |
| `0029_event_facts_ces_v2_persistence.sql` | `3fd67ee2678d90038e402058c027329876dcd5473286c1a1b661ee5e284e46bb` |
| `0030_official_source_artifacts.sql` | `b624446fe304f37b001cececf433dcad78c077d4e0ac372d35157206e4b7b049` |
| `0031_event_identity_active_lookup.sql` | `6283c712421198c2af6c96a29331ed8d3db057794cc19551279c1849e54a1d9c` |
| `0032_event_facts_atomic_production.sql` | `450583dac5df83770c5df8f99b24ba467558d56338e4369c85ba0fef245193b5` |

The four migrations were applied sequentially in the frozen order
0029 → 0030 → 0031 → 0032. They were never run in parallel.

## 4. Hold-point results

### 0029 — CES V2 persistence gate

- exact signature: `fn_event_is_supported_canonical_state(smallint,jsonb)`;
- immutable, strict, parallel-safe, security-invoker, empty search path;
- `anon` and `authenticated` denied; `service_role` allowed;
- CES V1 and the exact reviewed US CPI CES V2 fixture returned true;
- schema version 3 returned false;
- `event_versions` remained empty.

### 0030 — exact official-source artifacts

- exact byte sequence including NUL survived;
- one-byte-different content remained a distinct observation;
- content and observation hashes were 64-character lowercase SHA-256 values;
- RLS enabled, zero policies, service-role SELECT/INSERT only;
- append-only trigger and observation-hash unique index present;
- rollback-wrapped proof left `official_source_artifacts` empty.

### 0031 — active release identity lookup

- exact signature: `fn_event_lookup_active_identity_claims(text,text,text)`;
- stable, strict, parallel-safe, security-invoker, empty search path;
- `anon` and `authenticated` denied; `service_role` allowed;
- zero, one, superseded-zero, and collision (`>1`) cardinalities proved;
- rollback left identity claims, clusters, and observations empty.

### 0032 — atomic BLS CPI production RPC

- exact signature:
  `fn_event_fact_produce_bls_cpi(uuid,uuid,uuid,text,text,text,jsonb,text)`;
- security-invoker, empty search path, service-role-only execution;
- first operation returned `CREATED` and wrote exactly one cluster,
  membership, identity claim, Event Version, and operation ledger row plus two
  artifact links inside the proof transaction;
- exact replay returned the same committed identifiers with
  `operation_replayed=true` and created no rows;
- divergent reuse of the operation fingerprint failed closed with
  `EF8_OPERATION_IDEMPOTENCY_CONFLICT`;
- a forced failure on downstream Event Version insertion rolled back the new
  cluster, membership, identity claim, Event Version, and ledger row together;
- outer rollback left all Event Cluster and Event Facts tables empty.

## 5. Post-schema reconciliation

- all 17 staging migration entries are present in their executed order,
  including the explicit bootstrap/prerequisite entries;
- the three Event Facts tables and three target functions are present;
- all Event Cluster and Event Facts row counts are zero;
- target policy count is zero by design;
- no target function has a security-definer or search-path mismatch;
- Supabase Security Advisor reports only 13 `rls_enabled_no_policy` INFO
  findings, matching the deliberate fail-closed posture;
- Performance Advisor reports three pre-existing/bootstrap foreign-key INFO
  findings and unused indexes expected on an empty staging database; it reports
  no missing covering index for a 0030/0032 target foreign key;
- no Edge Function is deployed;
- the `cron.job` table is absent;
- 48/48 deterministic test files and TypeScript typecheck pass.

## 6. Decision

The isolated hosted staging proof is complete. The result is
`SCHEMA_READY_RUNTIME_OFF` for EF-12.

Production remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`. Before a live
rollout, the remaining EF-11 Human Gates still require explicit resolution:

1. recovery readiness and named recovery operator;
2. production migration authority for the exact main SHA and hashes;
3. durable operation-fingerprint ownership;
4. consensus provider selection or an explicit `UNKNOWN` policy;
5. separate runtime authority after schema deployment.

