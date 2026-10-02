-- MP-2 follow-up — cover the source foreign key for delete/update checks.
--
-- Kept separate from the immutable, already-merged MP-2 migration. This is an
-- additive staging-safe index only; production application remains gated.
BEGIN;

CREATE INDEX idx_market_pricing_observations_source
  ON public.market_pricing_observations (source);

COMMENT ON INDEX public.idx_market_pricing_observations_source IS
  'Covers market_pricing_observations_source_fkey for source update/delete checks.';

COMMIT;
