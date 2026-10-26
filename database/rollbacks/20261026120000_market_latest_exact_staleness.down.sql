-- XAU V2 / A-C3 — rollback of 20261026120000_market_latest_exact_staleness.
-- NOT a migration: kept outside database/migrations so no runner applies it.
-- Run only after the code that selects staleness_us has been rolled back.
--
-- PostgreSQL cannot drop a column from a view, so the view is dropped and
-- recreated exactly as before (schema.sql section 9 + migration 0033). Its ACL
-- is captured first and restored as it was, grant by grant, including grant
-- options; the comment and security_invoker are restored. DROP VIEW is
-- RESTRICT: if anything depends on the view, the whole rollback aborts.

BEGIN;

CREATE TEMP TABLE xau_v_market_latest_acl ON COMMIT DROP AS
SELECT
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee.rolname) END AS grantee,
  acl.privilege_type,
  acl.is_grantable
FROM pg_class AS view_class
CROSS JOIN LATERAL aclexplode(view_class.relacl) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE view_class.oid = 'public.v_market_latest'::regclass
  AND acl.grantee <> view_class.relowner;

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
  entry record;
BEGIN
  FOR entry IN SELECT * FROM xau_v_market_latest_acl ORDER BY grantee, privilege_type LOOP
    EXECUTE format('GRANT %s ON public.v_market_latest TO %s%s',
      entry.privilege_type, entry.grantee,
      CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END
$restore$;

COMMIT;
