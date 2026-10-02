-- MP-2 — append-only Market Pricing evidence and bounded historical as-of read.
--
-- This migration is deliberately disconnected from runtime ingestion. It adds
-- a provider-neutral persistence boundary for explicit source revisions and a
-- service-role-only read RPC. Applying it to production and wiring a caller are
-- separate Human Gates.
BEGIN;

CREATE TABLE public.market_pricing_observations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field                 TEXT NOT NULL
                          CHECK (field IN (
                            'spot', 'bid', 'ask', 'dxy',
                            'us10y', 'realYield', 'vix', 'wti'
                          )),
  value                 NUMERIC NOT NULL
                          CHECK (value NOT IN (
                            'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                          )),
  source                TEXT NOT NULL
                          REFERENCES public.data_sources (code)
                          ON UPDATE CASCADE ON DELETE RESTRICT,
  source_observed_at    TIMESTAMPTZ NOT NULL,
  ingested_at           TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  evidence_revision     TEXT NOT NULL
                          CHECK (
                            evidence_revision = btrim(evidence_revision)
                            AND evidence_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
                          ),
  CONSTRAINT chk_market_pricing_observation_chronology
    CHECK (source_observed_at <= ingested_at),
  CONSTRAINT chk_market_pricing_observation_value_domain
    CHECK (
      CASE field
        WHEN 'us10y' THEN value BETWEEN -5 AND 25
        WHEN 'realYield' THEN value BETWEEN -10 AND 25
        WHEN 'vix' THEN value >= 0
        WHEN 'wti' THEN value >= 0
        ELSE value > 0
      END
    ),
  CONSTRAINT uq_market_pricing_observation_identity
    UNIQUE (field, source, source_observed_at, evidence_revision)
);

CREATE INDEX idx_market_pricing_observations_as_of
  ON public.market_pricing_observations
  (field, source_observed_at DESC, ingested_at DESC, source, id);

CREATE INDEX idx_market_pricing_observations_ingested
  ON public.market_pricing_observations (ingested_at DESC);

CREATE OR REPLACE FUNCTION public.fn_market_pricing_observations_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    'market_pricing_observations is append-only: % is forbidden; retain a correction as a new evidence revision',
    TG_OP;
END;
$$;

CREATE TRIGGER trg_market_pricing_observations_append_only
  BEFORE UPDATE OR DELETE ON public.market_pricing_observations
  FOR EACH ROW EXECUTE FUNCTION public.fn_market_pricing_observations_append_only();

CREATE OR REPLACE FUNCTION public.fn_market_pricing_record_observation(
  p_field TEXT,
  p_value NUMERIC,
  p_source TEXT,
  p_source_observed_at TIMESTAMPTZ,
  p_evidence_revision TEXT
)
RETURNS TABLE (
  observation_id UUID,
  outcome TEXT,
  ingested_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_observation public.market_pricing_observations%ROWTYPE;
BEGIN
  INSERT INTO public.market_pricing_observations (
    field, value, source, source_observed_at, evidence_revision
  )
  VALUES (
    p_field, p_value, p_source, p_source_observed_at, p_evidence_revision
  )
  ON CONFLICT (field, source, source_observed_at, evidence_revision)
  DO NOTHING
  RETURNING * INTO v_observation;

  IF FOUND THEN
    RETURN QUERY SELECT v_observation.id, 'PERSISTED'::text, v_observation.ingested_at;
    RETURN;
  END IF;

  SELECT observation.*
    INTO v_observation
    FROM public.market_pricing_observations AS observation
   WHERE observation.field = p_field
     AND observation.source = p_source
     AND observation.source_observed_at = p_source_observed_at
     AND observation.evidence_revision = p_evidence_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'market pricing replay identity disappeared after conflict'
      USING ERRCODE = '40001';
  END IF;

  IF v_observation.value IS DISTINCT FROM p_value THEN
    RAISE EXCEPTION
      'market pricing evidence identity reused with divergent value'
      USING ERRCODE = '23505';
  END IF;

  RETURN QUERY SELECT v_observation.id, 'REPLAYED'::text, v_observation.ingested_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_market_pricing_candidates_as_of(
  p_knowledge_cutoff TIMESTAMPTZ,
  p_max_candidates INTEGER DEFAULT 2048
)
RETURNS TABLE (
  candidate_id UUID,
  field TEXT,
  value NUMERIC,
  source TEXT,
  observed_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ,
  evidence_revision TEXT
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_candidate_count BIGINT;
BEGIN
  IF p_knowledge_cutoff IS NULL OR NOT isfinite(p_knowledge_cutoff) THEN
    RAISE EXCEPTION 'knowledge cutoff must be a finite timestamp'
      USING ERRCODE = '22023';
  END IF;
  IF p_max_candidates IS NULL OR p_max_candidates NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'max candidates must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)
    INTO v_candidate_count
    FROM public.market_pricing_observations AS observation
   WHERE observation.source_observed_at <= p_knowledge_cutoff
     AND observation.ingested_at <= p_knowledge_cutoff;

  IF v_candidate_count > p_max_candidates THEN
    RAISE EXCEPTION
      'market pricing as-of candidate history exceeds explicit bound (% > %)',
      v_candidate_count, p_max_candidates
      USING ERRCODE = '54000';
  END IF;

  RETURN QUERY
  SELECT
    observation.id,
    observation.field,
    observation.value,
    observation.source,
    observation.source_observed_at,
    observation.ingested_at,
    observation.evidence_revision
  FROM public.market_pricing_observations AS observation
  WHERE observation.source_observed_at <= p_knowledge_cutoff
    AND observation.ingested_at <= p_knowledge_cutoff
  ORDER BY
    CASE observation.field
      WHEN 'spot' THEN 1 WHEN 'bid' THEN 2 WHEN 'ask' THEN 3
      WHEN 'dxy' THEN 4 WHEN 'us10y' THEN 5 WHEN 'realYield' THEN 6
      WHEN 'vix' THEN 7 WHEN 'wti' THEN 8
    END,
    observation.source_observed_at DESC,
    observation.ingested_at DESC,
    observation.source,
    observation.id;
END;
$$;

ALTER TABLE public.market_pricing_observations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.market_pricing_observations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.market_pricing_observations TO service_role;

REVOKE ALL ON FUNCTION public.fn_market_pricing_observations_append_only()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_market_pricing_observations_append_only()
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_market_pricing_record_observation(
  TEXT, NUMERIC, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_market_pricing_record_observation(
  TEXT, NUMERIC, TEXT, TIMESTAMPTZ, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.fn_market_pricing_candidates_as_of(
  TIMESTAMPTZ, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_market_pricing_candidates_as_of(
  TIMESTAMPTZ, INTEGER
) TO service_role;

COMMENT ON TABLE public.market_pricing_observations IS
  'MP-2 append-only dual-timestamp evidence. Distinct source revisions remain separate rows; runtime ingestion is not activated by this migration.';
COMMENT ON COLUMN public.market_pricing_observations.source_observed_at IS
  'Timestamp published by the source; never replaced with ingestion time.';
COMMENT ON COLUMN public.market_pricing_observations.ingested_at IS
  'Database-owned first-knowledge timestamp used by historical as-of replay.';
COMMENT ON COLUMN public.market_pricing_observations.evidence_revision IS
  'Provider revision identifier or retained-evidence digest. Reuse with a divergent value fails closed.';
COMMENT ON FUNCTION public.fn_market_pricing_candidates_as_of(TIMESTAMPTZ, INTEGER) IS
  'Returns the complete eligible dual-timestamp history in deterministic order or fails when the explicit bound would be exceeded; never truncates silently.';

COMMIT;
