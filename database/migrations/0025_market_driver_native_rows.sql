-- Restore native market-driver rows by allowing each instrument's valid
-- numeric domain in market_ticks.close. No row is rewritten or backfilled.
BEGIN;

ALTER TABLE public.market_ticks
  DROP CONSTRAINT market_ticks_close_check,
  ADD CONSTRAINT market_ticks_close_check
    CHECK (
      CASE symbol
        WHEN 'US10Y'  THEN close BETWEEN -5 AND 25
        WHEN 'US10YR' THEN close BETWEEN -10 AND 25
        WHEN 'VIX'    THEN close >= 0
        WHEN 'WTI'    THEN close >= 0
        ELSE close > 0
      END
    );

COMMIT;
