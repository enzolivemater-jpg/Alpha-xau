-- XAU V2 / A-C3 — rollback of 20261026120000_market_latest_exact_staleness.
-- NOT a migration: kept outside database/migrations so no runner applies it.
-- Run only after the code that selects staleness_us has been rolled back.
--
-- PostgreSQL cannot drop a column from a view, so the view is dropped and
-- recreated exactly as before (schema.sql section 9 + migration 0033).
-- One transaction, all or nothing:
--   * DROP VIEW is RESTRICT: if any object depends on the view, it aborts.
--   * It aborts before dropping anything if the view carries what DROP VIEW
--     would silently take with it and this script cannot recreate: triggers,
--     rules other than the view's own, or privileges on staleness_us.
--   * The owner, the table ACL and the column ACLs are captured first and
--     restored as they were: same owner, same grantors (each grant is replayed
--     as its grantor, in the ACL's own order), same grant options. The
--     comment and security_invoker are restored.
--   * It then compares owner and ACLs with the capture and aborts on any
--     difference, so a rollback that commits restored them exactly.

BEGIN;

DO $guard$
DECLARE
  view_oid oid := 'public.v_market_latest'::regclass;
BEGIN
  IF EXISTS (SELECT FROM pg_trigger WHERE tgrelid = view_oid) THEN
    RAISE EXCEPTION 'v_market_latest has triggers; DROP VIEW would remove them. Rollback aborted, nothing changed.';
  END IF;
  IF EXISTS (SELECT FROM pg_rewrite WHERE ev_class = view_oid AND rulename <> '_RETURN') THEN
    RAISE EXCEPTION 'v_market_latest has rules; DROP VIEW would remove them. Rollback aborted, nothing changed.';
  END IF;
  IF EXISTS (SELECT FROM pg_attribute WHERE attrelid = view_oid AND attname = 'staleness_us' AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'privileges are granted on v_market_latest.staleness_us, which the rollback removes. Revoke them first. Rollback aborted, nothing changed.';
  END IF;
END
$guard$;

CREATE TEMP TABLE xau_v_market_latest_owner ON COMMIT DROP AS
SELECT relowner AS owner FROM pg_class WHERE oid = 'public.v_market_latest'::regclass;

-- Every ACL entry, table level (column_name NULL) then per column, in ACL order.
-- The implicit defaults stand in for a NULL ACL, so both sides compare alike.
CREATE TEMP TABLE xau_v_market_latest_acl ON COMMIT DROP AS
SELECT 0 AS attnum, NULL::name AS column_name, acl.ord, acl.grantor, acl.grantee, acl.privilege_type, acl.is_grantable
FROM pg_class AS view_class
CROSS JOIN LATERAL aclexplode(coalesce(view_class.relacl, acldefault('r', view_class.relowner))) WITH ORDINALITY
  AS acl(grantor, grantee, privilege_type, is_grantable, ord)
WHERE view_class.oid = 'public.v_market_latest'::regclass
UNION ALL
SELECT col.attnum, col.attname, acl.ord, acl.grantor, acl.grantee, acl.privilege_type, acl.is_grantable
FROM pg_attribute AS col
CROSS JOIN LATERAL aclexplode(col.attacl) WITH ORDINALITY AS acl(grantor, grantee, privilege_type, is_grantable, ord)
WHERE col.attrelid = 'public.v_market_latest'::regclass AND col.attnum > 0 AND NOT col.attisdropped;

DROP VIEW public.v_market_latest;

CREATE VIEW public.v_market_latest
WITH (security_invoker = true) AS
SELECT DISTINCT ON (symbol)
  symbol, asset_type, bid, ask, spread, close, volume, timeframe,
  dxy_value, us10y_yield, real_yield, vix, wti, source, ts,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS staleness_seconds
FROM public.market_ticks
ORDER BY symbol, ts DESC;

COMMENT ON VIEW public.v_market_latest IS
  'Dernier tick par instrument + indicateur de fraîcheur pour le badge LIVE/STALE du terminal.';

DO $restore$
DECLARE
  runner text := quote_ident(current_user);
  owner_oid oid := (SELECT owner FROM xau_v_market_latest_owner);
  view_oid oid;
  entry record;
  difference bigint;
BEGIN
  EXECUTE format('ALTER VIEW public.v_market_latest OWNER TO %s', owner_oid::regrole);
  view_oid := 'public.v_market_latest'::regclass;

  -- The owner's own privileges come with the new view; every other entry is
  -- replayed. ACL order puts a grant option before the grants made with it.
  FOR entry IN SELECT * FROM xau_v_market_latest_acl
               WHERE NOT (grantee = owner_oid AND grantor = owner_oid)
               ORDER BY attnum, ord, privilege_type LOOP
    IF entry.grantor <> owner_oid THEN
      EXECUTE format('SET LOCAL ROLE %s', entry.grantor::regrole);
    END IF;
    EXECUTE format('GRANT %s%s ON public.v_market_latest TO %s%s',
      entry.privilege_type,
      CASE WHEN entry.column_name IS NULL THEN '' ELSE format(' (%I)', entry.column_name) END,
      CASE WHEN entry.grantee = 0 THEN 'PUBLIC' ELSE entry.grantee::regrole::text END,
      CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    IF entry.grantor <> owner_oid THEN
      EXECUTE format('SET LOCAL ROLE %s', runner);
    END IF;
  END LOOP;

  IF (SELECT relowner FROM pg_class WHERE oid = view_oid) <> owner_oid THEN
    RAISE EXCEPTION 'v_market_latest owner not restored. Rollback aborted, nothing changed.';
  END IF;
  WITH restored AS (
    SELECT 0 AS attnum, acl.grantor, acl.grantee, acl.privilege_type, acl.is_grantable
    FROM pg_class AS view_class
    CROSS JOIN LATERAL aclexplode(coalesce(view_class.relacl, acldefault('r', view_class.relowner))) AS acl
    WHERE view_class.oid = view_oid
    UNION ALL
    SELECT col.attnum, acl.grantor, acl.grantee, acl.privilege_type, acl.is_grantable
    FROM pg_attribute AS col CROSS JOIN LATERAL aclexplode(col.attacl) AS acl
    WHERE col.attrelid = view_oid AND col.attnum > 0 AND NOT col.attisdropped),
  captured AS (SELECT attnum, grantor, grantee, privilege_type, is_grantable FROM xau_v_market_latest_acl)
  SELECT count(*) INTO difference FROM ((SELECT * FROM restored EXCEPT SELECT * FROM captured)
                                        UNION ALL (SELECT * FROM captured EXCEPT SELECT * FROM restored)) AS d;
  IF difference <> 0 THEN
    RAISE EXCEPTION 'v_market_latest privileges not restored exactly (% differences). Rollback aborted, nothing changed.', difference;
  END IF;
END
$restore$;

COMMIT;
