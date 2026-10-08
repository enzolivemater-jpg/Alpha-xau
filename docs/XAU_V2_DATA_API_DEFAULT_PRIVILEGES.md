# XAU V2 — Data API default privileges

Status: `SB-3 CODE CANDIDATE — NOT LIVE-APPLIED`

Captured: `2026-10-08`  
Production project: `ejvwmjgfvhsslqiydwpz`  
Staging project: `viskjhkkcnzqxkuvibdx`  
Candidate migration: `20261008094133_data_api_default_privileges.sql`  
Candidate SHA-256: `0b7c189687ea62b06c54747b1277b39164416d2ae6dab0555fb4a4b07e3eb9d2`

## 1. Finding and boundary

Supabase's October 2026 security change makes Data API access opt-in for new
projects. Existing projects must opt in separately. A read-only live snapshot
found permissive default ACLs in staging for future `public` relations,
functions, and sequences. Production has the current explicit object grants
but returned no matching `pg_default_acl` rows for `public`; absence of a row is
not treated as proof that future objects are fail-closed.

The browser uses the anon key for exactly three PostgREST views:
`v_market_latest`, `v_news_high_impact`, and `v_ai_latest`. It also subscribes
to `market_ticks` and `news_events` through Realtime. Backend database paths use
the service-role key. Current browser and backend access must therefore remain
unchanged while future objects become opt-in.

## 2. Candidate payload

The CLI-generated migration changes default privileges for objects subsequently
created by role `postgres` in schema `public`:

- no implicit `SELECT`, `INSERT`, `UPDATE`, or `DELETE` on future tables for
  `anon`, `authenticated`, or `service_role`;
- no implicit `EXECUTE` on future `public` functions for application roles;
- no implicit `EXECUTE` from `PUBLIC` on any future function created by
  `postgres` in this database, because PostgreSQL cannot override that built-in
  global default with a schema-scoped revocation;
- no implicit `USAGE` or `SELECT` on future sequences for application roles.

It does not revoke any current table, view, function, sequence, schema, or RLS
privilege. It creates or drops no object and performs no DML. A migration that
creates a future API object must carry its explicit least-privilege grants.
Pending new-object migrations 0030, 0032, Market Pricing, and Positioning already
do so. Fresh-install parity is included in `database/schema.sql`.

## 3. PostgreSQL 17 proof contract

The disposable proof creates objects before and after SB-3 from deliberately
permissive defaults. It verifies that:

- pre-existing table, sequence, and function ACLs and data are unchanged;
- future objects inherit none of the Data API privileges revoked by SB-3;
- `PUBLIC` does not restore implicit function execution, including from the
  PostgreSQL built-in global default;
- an explicit later grant restores only the intended service-role access;
- the owner retains normal object and data access.

## 4. `supabase_admin` preflight

The staging snapshot also found legacy permissive default ACL rows owned by
`supabase_admin`. The official opt-in SQL targets `postgres`; this candidate
does not invent an unverified managed-role mutation. Before any live apply, the
operator must establish whether Supabase has removed or platform-manages those
rows, or obtain a separately reviewed payload. A non-empty unresolved result is
a fail-closed stop, not a reason to widen this migration interactively.

## 5. Production authorization gate

SB-3 is code-only. Immediately before any production action, repeat the live
default/object ACL inventory and approve this exact record:

```text
DATA_API_DEFAULTS_MIGRATION_SHA256=0b7c189687ea62b06c54747b1277b39164416d2ae6dab0555fb4a4b07e3eb9d2
FINAL_MAIN_SHA=<40-hex SHA>
PRODUCTION_PREFLIGHT_REPEATED=YES
CURRENT_FRONTEND_ACLS_PRESERVED=YES
PENDING_MIGRATIONS_HAVE_EXPLICIT_GRANTS=YES
SUPABASE_ADMIN_DEFAULT_ACL_DISPOSITION=PLATFORM_MANAGED|SEPARATELY_AUTHORIZED|NONE_PRESENT
APPLY_ONLY_20261008094133=YES
EVENT_FACTS_0029_0032_AUTHORIZED=NO
SECURITY_BASELINE_0033_AUTHORIZED=NO
PUBLIC_SCHEMA_0034_AUTHORIZED=NO
APPROVER=<name>
APPROVED_AT=<ISO-8601>
```

After an authorized apply, create temporary owner-only probe objects, verify
effective privileges, remove those probes, rerun advisors, and smoke-test anon
views, Realtime reads, and backend service-role paths. Probe creation/removal and
the migration itself are production mutations and remain inside the gate.

Production status remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`.

## 6. References

- [Supabase Data API access control](https://supabase.com/docs/guides/database/hardening-data-api)
- [PostgreSQL ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html)
