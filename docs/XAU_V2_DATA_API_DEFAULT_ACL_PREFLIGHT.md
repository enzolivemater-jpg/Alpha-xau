# XAU V2 — SB-3 Data API default-ACL preflight

Status: `SB-5 READ-ONLY PREFLIGHT — NO LIVE AUTHORIZATION`

This preflight turns the remaining SB-3 managed-role uncertainty into a bounded,
machine-readable gate. It inventories only catalog state and effective frontend
`SELECT` privileges. It does not apply SB-3, change an ACL, create a probe,
deploy runtime, or authorize a production action.

## Evidence capture

Run against the intended database with the normal read-only evidence-access
path and retain the JSON output:

```bash
psql -X -q -A -t -v ON_ERROR_STOP=1 \
  -f scripts/data_api_default_acl_preflight.sql \
  > data-api-default-acl-preflight.json

node scripts/evaluate_data_api_default_acl_preflight.mjs \
  data-api-default-acl-preflight.json
```

The SQL starts a repeatable-read, read-only transaction and rolls it back. The
snapshot contains no secrets or row data. It records:

- existence of `postgres`, `anon`, `authenticated`, `service_role`, and
  `supabase_admin`;
- effective anonymous `SELECT` access for the three browser views and two
  Realtime source tables already named by the SB-3 contract;
- application-role and `PUBLIC` grants found in relevant default ACLs owned by
  `postgres` or `supabase_admin`.

## Verdicts

`READY_FOR_SCOPED_AUTHORIZATION` means only that the observed catalog satisfies
this preflight contract. It explicitly reports `authorization_granted: false`
and performs no production change. Existing `postgres` default grants are
reported as the intended SB-3 target rather than hidden.

`HOLD` is mandatory when a required role or frontend ACL is not proven, or when
`supabase_admin` exists. PostgreSQL's built-in future-function `PUBLIC EXECUTE`
default is not represented by a `pg_default_acl` row, so even zero explicit
managed-role rows cannot prove that boundary safe. Explicit managed-role grants
are attached as additional evidence. The result must not be waived by changing
the JSON or broadening SB-3 interactively; it requires current platform evidence
or a separately reviewed and authorized payload.

After a future authorized apply, repeat the snapshot, the current-ACL smoke
tests, advisors, and the separately authorized temporary-probe proof described
in `XAU_V2_DATA_API_DEFAULT_PRIVILEGES.md`. This preflight does not replace
REC-1 or any production Human Gate.

## Read-only evidence — 2026-10-08T14:52:09Z

The exact query above was executed without mutation through the Supabase query
interface on both known projects:

- production (`ejvwmjgfvhsslqiydwpz`, PostgreSQL `170006`) proved all five
  required anonymous reads and returned no explicit relevant default-ACL grant
  row for either owner; because `supabase_admin` exists and PostgreSQL's
  built-in function default is not a catalog row, the verdict remains `HOLD`;
- isolated staging (`viskjhkkcnzqxkuvibdx`, PostgreSQL `170011`) does not carry
  the five production frontend objects and returned 36 relevant application
  grants for `postgres` plus 36 for `supabase_admin`; its verdict is `HOLD`.

The staging inventory exposed table privileges beyond ordinary Data API DML
(`TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN`) and sequence `UPDATE`. SB-3
was therefore corrected before any live apply to revoke all future table and
sequence privileges from application roles. The corrected candidate hash is
`ac67440e06be6283e1da22487b554e9ceeb84094ebbb26c83da09d33e24b4905`.
