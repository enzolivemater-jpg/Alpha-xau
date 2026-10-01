# XAU V2 — public schema creation hardening

Status: `SB-2 CODE CANDIDATE — NOT LIVE-APPLIED`

Captured: `2026-10-01`  
Production project: `ejvwmjgfvhsslqiydwpz`  
Candidate migration: `0034_public_schema_create_hardening.sql`
Candidate SHA-256:
`8ea129a10a5776bcde5e4786fabcacafa0c73295a74d4eb07dcc192fc9d55327`

## 1. Finding and impact

The read-only production snapshot shows effective `CREATE` on schema `public`
for `PUBLIC`, `anon`, `authenticated`, and `service_role`. Because `public` is
on common search paths, an untrusted role able to create functions, operators,
or other objects there can influence unqualified name resolution. PostgreSQL's
documented secure-schema pattern is to remove public `CREATE` authority.

SB-1 already freezes the search path of the five advisor-flagged functions,
but it deliberately did not change this broader schema privilege. SB-2 closes
that separate construction risk; it is not a substitute for fixed function
paths or invoker-security views.

## 2. Dependency inventory

A repository-wide runtime scan found no DDL path outside migrations/tests:

- Workers use PostgREST table operations and reviewed RPCs only;
- no backend, frontend, scheduled job, or deployment command creates, alters,
  drops, grants, or revokes database objects;
- PostgreSQL temporary-object authority is a database-level `TEMP` privilege,
  not schema `CREATE`, and is not changed here;
- migrations remain executable by the database/schema owner or another
  separately authorized administrative role.

The application roles require `USAGE` plus their existing table/function
privileges. SB-2 preserves all of those grants.

## 3. Candidate payload

Migration `0034_public_schema_create_hardening.sql` performs exactly two
revocations:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM anon, authenticated, service_role;
```

The explicit role revocation handles both inherited `PUBLIC` access and any
direct grants. The migration performs no DML, object drop, owner change,
default-privilege change, Event Facts operation, runtime action, or deployment.
It is independent of migrations 0029–0033.

## 4. PostgreSQL 17 proof contract

The disposable proof starts from both public and direct `CREATE` grants, then
verifies that:

- `PUBLIC`, `anon`, `authenticated`, and `service_role` lose effective schema
  `CREATE`;
- all three application roles retain schema `USAGE`;
- existing table `SELECT`/`INSERT` and function `EXECUTE` grants are unchanged;
- application roles cannot create a table or function in `public`;
- the schema owner can still create and drop an object;
- the migration changes no data or existing object definition.

Fresh-install parity is present in `database/schema.sql`.

## 5. Production authorization gate

SB-2 is code-only. Before production execution, repeat the privilege snapshot,
inventory any out-of-repository administrator or integration that relies on
application-role DDL, and approve this exact record:

```text
PUBLIC_SCHEMA_MIGRATION_SHA256=8ea129a10a5776bcde5e4786fabcacafa0c73295a74d4eb07dcc192fc9d55327
FINAL_MAIN_SHA=<40-hex SHA>
PRODUCTION_PREFLIGHT_REPEATED=YES
OUT_OF_REPOSITORY_DDL_DEPENDENCIES=NONE|<reviewed exception>
APPLY_ONLY_0034=YES
EVENT_FACTS_0029_0032_AUTHORIZED=NO
SECURITY_BASELINE_0033_AUTHORIZED=NO
APPROVER=<name>
APPROVED_AT=<ISO-8601>
```

After an authorized apply, verify effective privileges for every login and
group role, rerun security advisors, and smoke-test application reads, writes,
and RPCs. A generic “continue” or authorization for another migration does not
authorize SB-2.

Production status remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`.

## 6. References

- [PostgreSQL schemas and privileges](https://www.postgresql.org/docs/current/ddl-schemas.html#DDL-SCHEMAS-PRIV)
- [Supabase default platform permissions](https://supabase.com/docs/guides/platform/permissions)
