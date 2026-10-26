-- XAU V2 / A-C3 — exact staleness on v_market_latest.
--
-- staleness_seconds is EXTRACT(EPOCH FROM (now() - ts))::INTEGER, which rounds
-- to the nearest second: the runtime crossed a freshness threshold 500 ms
-- early. This migration appends one column, staleness_us, the exact age in
-- microseconds (PostgreSQL's timestamp precision), computed from the same two
-- timestamps, ts and now(). The timestamps stay the source of truth.
--
-- ADDITIVE. Every existing column keeps its name, type, position and
-- expression; staleness_seconds is unchanged (display only from A-C3 on).
-- CREATE OR REPLACE VIEW keeps the view's identity, owner, ACL and comment
-- target; security_invoker is restated. The GRANTs below restate the two
-- grants the application already relies on (anon: browser, service_role:
-- backend) and are no-ops where they exist. No other privilege changes.
-- Rollback: database/rollbacks/20261026120000_market_latest_exact_staleness.down.sql
-- Deploy order: this migration BEFORE the code that selects staleness_us;
-- rollback: that code first, then the down script.

BEGIN;

CREATE OR REPLACE VIEW public.v_market_latest
WITH (security_invoker = true) AS
SELECT DISTINCT ON (symbol)
  symbol, asset_type, bid, ask, spread, close, volume, timeframe,
  dxy_value, us10y_yield, real_yield, vix, wti, source, ts,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS staleness_seconds,
  -- Exact: both epochs are NUMERIC with at most 6 decimals, so the product is
  -- an integer and the cast never rounds.
  ((EXTRACT(EPOCH FROM now()) - EXTRACT(EPOCH FROM ts)) * 1000000)::BIGINT AS staleness_us
FROM public.market_ticks
ORDER BY symbol, ts DESC;

COMMENT ON VIEW public.v_market_latest IS
  'Dernier tick par instrument + indicateur de fraîcheur pour le badge LIVE/STALE du terminal. staleness_us : âge exact (µs), seule base des décisions de fraîcheur ; staleness_seconds : arrondi, affichage.';

GRANT SELECT ON public.v_market_latest TO anon, service_role;

COMMIT;
