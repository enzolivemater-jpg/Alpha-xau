-- XAU V2 / SB-5 — read-only evidence snapshot for the SB-3 authorization gate.
-- Run with psql -X -q -A -t -v ON_ERROR_STOP=1 -f <this-file>.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH
required_roles(role_name) AS (
  VALUES ('postgres'), ('anon'), ('authenticated'), ('service_role'), ('supabase_admin')
),
role_inventory AS (
  SELECT
    required_roles.role_name,
    roles.oid IS NOT NULL AS exists
  FROM required_roles
  LEFT JOIN pg_roles AS roles ON roles.rolname = required_roles.role_name
),
required_frontend_privileges(object_name, role_name, privilege_type) AS (
  VALUES
    ('public.v_market_latest', 'anon', 'SELECT'),
    ('public.v_news_high_impact', 'anon', 'SELECT'),
    ('public.v_ai_latest', 'anon', 'SELECT'),
    ('public.market_ticks', 'anon', 'SELECT'),
    ('public.news_events', 'anon', 'SELECT')
),
frontend_inventory AS (
  SELECT
    expected.object_name,
    expected.role_name,
    expected.privilege_type,
    relation.oid IS NOT NULL AS object_exists,
    relation.relkind::text AS relation_kind,
    owner.rolname AS owner,
    CASE
      WHEN relation.oid IS NULL OR grantee.oid IS NULL THEN NULL
      ELSE has_table_privilege(grantee.oid, relation.oid, expected.privilege_type)
    END AS allowed
  FROM required_frontend_privileges AS expected
  LEFT JOIN pg_class AS relation ON relation.oid = to_regclass(expected.object_name)
  LEFT JOIN pg_roles AS owner ON owner.oid = relation.relowner
  LEFT JOIN pg_roles AS grantee ON grantee.rolname = expected.role_name
),
default_acl_app_grants AS (
  SELECT
    owner.rolname AS owner,
    COALESCE(namespace.nspname, '*') AS schema_name,
    CASE defaults.defaclobjtype
      WHEN 'r' THEN 'TABLES'
      WHEN 'S' THEN 'SEQUENCES'
      WHEN 'f' THEN 'FUNCTIONS'
      ELSE defaults.defaclobjtype::text
    END AS object_type,
    CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
    acl.privilege_type,
    acl.is_grantable
  FROM pg_default_acl AS defaults
  JOIN pg_roles AS owner ON owner.oid = defaults.defaclrole
  LEFT JOIN pg_namespace AS namespace ON namespace.oid = defaults.defaclnamespace
  CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS acl
  LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
  WHERE owner.rolname IN ('postgres', 'supabase_admin')
    AND (namespace.nspname = 'public' OR namespace.oid IS NULL)
    AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated', 'service_role'))
)
SELECT jsonb_build_object(
  'contract_version', 'data-api-default-acl-preflight-v1',
  'server_version_num', current_setting('server_version_num')::integer,
  'database', current_database(),
  'session_user', session_user,
  'required_roles', COALESCE((
    SELECT jsonb_agg(to_jsonb(role_inventory) ORDER BY role_name)
    FROM role_inventory
  ), '[]'::jsonb),
  'frontend_privileges', COALESCE((
    SELECT jsonb_agg(to_jsonb(frontend_inventory) ORDER BY object_name, role_name, privilege_type)
    FROM frontend_inventory
  ), '[]'::jsonb),
  'default_acl_app_grants', COALESCE((
    SELECT jsonb_agg(to_jsonb(default_acl_app_grants)
      ORDER BY owner, schema_name, object_type, grantee, privilege_type)
    FROM default_acl_app_grants
  ), '[]'::jsonb)
);

ROLLBACK;
