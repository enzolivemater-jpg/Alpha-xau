# XAU V2 — future Data API grant policy

Status: `SB-4 CI POLICY — NO LIVE ACTION`

Effective marker: `20261008094133_data_api_default_privileges.sql`

## Invariant

Every migration after SB-3 that creates or replaces a `public` table, foreign
table, view, materialized view, sequence, function, or procedure must include
an object-specific `GRANT` or `REVOKE` naming at least one application boundary:
`PUBLIC`, `anon`, `authenticated`, or `service_role`.

This is an explicit-disposition rule. Owner-only objects use a reviewed
`REVOKE`; API objects receive only the exact grants they require. A future
migration may not restore broad default grants or use `GRANT ... ON ALL ... IN
SCHEMA public` for application roles.

## Ordering rule

The legacy four-digit migration series ended at `0034`. New migrations must be
generated with the Supabase CLI's 14-digit timestamp format. This prevents a
new `0035_*` file from sorting before already-created timestamp migrations.

## CI enforcement

`scripts/check_data_api_grants.mjs`:

- splits top-level PostgreSQL statements while ignoring comments, strings, and
  dollar-quoted routine bodies;
- inventories new public Data API object kinds;
- rejects `serial` and identity columns whose implicit sequence would evade an
  object-specific sequence disposition;
- rejects a missing object-specific application-role ACL disposition;
- rejects broad default or schema-wide application-role grants;
- scans every timestamped migration after the SB-3 marker.

The test suite includes positive and negative synthetic migrations, quoted
identifiers, a routine body containing DDL text, legacy-order violations, and
the complete repository migration directory.

SB-4 changes no database, ACL, RLS policy, runtime, secret, deployment, or
provider. It does not authorize SB-3 or any other production migration.
