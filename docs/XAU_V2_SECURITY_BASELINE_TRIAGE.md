# XAU V2 — production security baseline triage

Status: `SB-1 CODE-PROVEN — NOT LIVE-APPLIED`

Captured: `2026-09-30`  
Production project: `ejvwmjgfvhsslqiydwpz`  
Baseline main SHA: `507d30cec297afb049b4613fa85d444f00bfb1eb`
Candidate migration SHA-256:
`451c0edf04a3c0c82bbd66f23f52e7aaebae33eb34770519b9e759a629f54355`

This dossier isolates pre-existing security-advisor findings from the Event
Facts rollout. The production inspection was read-only. Migration
`0033_security_baseline_hardening.sql` is a reviewed candidate, not permission
to mutate production or to apply Event Facts migrations 0029-0032.

## 1. Exact findings

The production advisor reports:

- six `security_definer_view` errors:
  `v_news_high_impact`, `v_news_actionable`,
  `v_news_pending_notification`, `v_engine_last_run`, `v_ai_latest`, and
  `v_market_latest`;
- five `function_search_path_mutable` warnings:
  `fn_set_updated_at`, `fn_news_classify`,
  `fn_check_scenario_probability_sum`, `fn_news_score`, and
  `fn_news_articles_append_only`.

All six views are owned by `postgres`, have no `security_invoker` reloption,
and read RLS-enabled public tables. Four are selectable by `anon` and
`authenticated`; two are selectable by `authenticated` only.

## 2. Effective exposure assessment

The current table grants and RLS policies intentionally allow the same read
audiences as the views:

| View family | Current table policy | Current view grant | Current escalation observed |
| --- | --- | --- | --- |
| market, AI, high-impact news | `anon`, `authenticated` read all | matching `SELECT` | No |
| actionable/pending news, ingestion run | `authenticated` read all | matching `SELECT` | No |

Therefore the snapshot does not prove an active data-access escalation. The
views are still unsafe by construction: owner-context evaluation can bypass a
future stricter RLS policy. PostgreSQL 17 supports invoker-security views, so
the correct hardening is to set `security_invoker=true` without recreating the
view or changing its grants, owner, definition, columns, or comments.

All five functions are currently `SECURITY INVOKER`, not definer functions.
However, `public` schema `CREATE` is currently true for `PUBLIC`, `anon`, and
`authenticated`, while the five functions have no fixed `search_path`.
`fn_news_classify` calls an unqualified application function and casts through
unqualified public enum types; `fn_check_scenario_probability_sum` reads an
unqualified application table and type. These two bodies must be
schema-qualified before an empty path is imposed. The other three functions
can safely receive an empty path directly.

The broad `CREATE` privilege is recorded as a separate P1 hardening decision.
It is not revoked by SB-1 because that wider privilege change requires an
inventory of every runtime and administrative workflow that may depend on it.

## 3. Candidate migration

`0033_security_baseline_hardening.sql`:

1. sets `security_invoker=true` on exactly the six flagged views;
2. sets `search_path=''` on exactly the five flagged functions;
3. schema-qualifies every application relation, function, enum, and catalog
   relation needed by the two rewritten trigger functions;
4. preserves function signatures, volatility, parallel/strict flags, owners,
   ACLs, triggers, view definitions, view grants, and data;
5. performs no DML, drop, route, runtime, Event Facts, or scheduling action.

Although numbered 0033, the SQL has no dependency on migrations 0029-0032.
Any future independent production execution must apply only the exact SB-1
payload as its own authorized migration; it must not implicitly deploy pending
Event Facts migrations.

## 4. PostgreSQL 17 proof

The disposable PostgreSQL 17 contract proves:

- all six views become invoker-security and enforce the caller's RLS result;
- the five functions have exactly `search_path=""`;
- view and function grants survive unchanged;
- news scoring/classification behavior is unchanged;
- the deferred scenario-probability constraint still accepts a valid
  distribution and rejects an invalid complete distribution;
- updated-at and append-only triggers retain their behavior;
- the migration contains no Event Facts object or data mutation.

## 5. Live authorization gate

Before production execution, a human must approve:

```text
SECURITY_BASELINE_MIGRATION_SHA256=<exact hash>
FINAL_MAIN_SHA=<40-hex SHA>
PRODUCTION_PREFLIGHT_REPEATED=YES
APPLY_ONLY_0033=YES
EVENT_FACTS_0029_0032_AUTHORIZED=NO
APPROVER=<name>
APPROVED_AT=<ISO-8601>
```

After an authorized apply, repeat security advisors and verify that the six
errors and five warnings are gone, all view/function ACLs are unchanged, and
the application read paths still return their expected audience-specific
results.

Production status remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`.
