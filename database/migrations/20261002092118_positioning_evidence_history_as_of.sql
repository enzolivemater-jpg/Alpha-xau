-- P-1 — provider-neutral Positioning evidence persistence and historical read.
--
-- This stores attributable evidence only. It does not approve a provider,
-- derive a positioning signal, or activate any runtime ingestion/read path.
BEGIN;

CREATE TABLE public.positioning_evidence_observations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_authority  TEXT NOT NULL
                      CHECK (source_authority ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  dataset_code      TEXT NOT NULL
                      CHECK (dataset_code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  instrument_code   TEXT NOT NULL
                      CHECK (instrument_code ~ '^[A-Z0-9][A-Z0-9_.:/-]{0,31}$'),
  metric_code       TEXT NOT NULL
                      CHECK (metric_code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  value             NUMERIC NOT NULL
                      CHECK (value NOT IN (
                        'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric
                      )),
  unit              TEXT NOT NULL
                      CHECK (unit IN ('CONTRACTS', 'PERCENT', 'RATIO', 'INDEX')),
  period_end        DATE NOT NULL,
  published_at      TIMESTAMPTZ NOT NULL,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  artifact_id       TEXT NOT NULL
                      CHECK (artifact_id = btrim(artifact_id)
                        AND length(artifact_id) BETWEEN 1 AND 256),
  revision          TEXT
                      CHECK (revision IS NULL OR (
                        revision = btrim(revision)
                        AND revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$'
                      )),
  revision_key      TEXT GENERATED ALWAYS AS (COALESCE(revision, '')) STORED,
  CONSTRAINT chk_positioning_evidence_chronology
    CHECK (published_at <= observed_at),
  CONSTRAINT uq_positioning_evidence_identity
    UNIQUE (
      source_authority, dataset_code, instrument_code,
      metric_code, period_end, revision_key
    )
);

CREATE INDEX idx_positioning_evidence_as_of
  ON public.positioning_evidence_observations (
    source_authority, dataset_code, instrument_code, metric_code,
    period_end, published_at, observed_at, revision_key, id
  );

CREATE INDEX idx_positioning_evidence_observed
  ON public.positioning_evidence_observations (observed_at DESC);

CREATE OR REPLACE FUNCTION public.fn_positioning_evidence_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    'positioning_evidence_observations is append-only: % is forbidden; retain corrections as explicit revisions',
    TG_OP;
END;
$$;

CREATE TRIGGER trg_positioning_evidence_append_only
  BEFORE UPDATE OR DELETE ON public.positioning_evidence_observations
  FOR EACH ROW EXECUTE FUNCTION public.fn_positioning_evidence_append_only();

CREATE OR REPLACE FUNCTION public.fn_positioning_evidence_record(
  p_source_authority TEXT,
  p_dataset_code TEXT,
  p_instrument_code TEXT,
  p_metric_code TEXT,
  p_value NUMERIC,
  p_unit TEXT,
  p_period_end DATE,
  p_published_at TIMESTAMPTZ,
  p_artifact_id TEXT,
  p_revision TEXT DEFAULT NULL
)
RETURNS TABLE (
  evidence_id UUID,
  outcome TEXT,
  observed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_evidence public.positioning_evidence_observations%ROWTYPE;
BEGIN
  INSERT INTO public.positioning_evidence_observations (
    source_authority, dataset_code, instrument_code, metric_code,
    value, unit, period_end, published_at, artifact_id, revision
  ) VALUES (
    p_source_authority, p_dataset_code, p_instrument_code, p_metric_code,
    p_value, p_unit, p_period_end, p_published_at, p_artifact_id, p_revision
  )
  ON CONFLICT (
    source_authority, dataset_code, instrument_code,
    metric_code, period_end, revision_key
  ) DO NOTHING
  RETURNING * INTO v_evidence;

  IF FOUND THEN
    RETURN QUERY SELECT v_evidence.id, 'PERSISTED'::text, v_evidence.observed_at;
    RETURN;
  END IF;

  SELECT evidence.*
    INTO v_evidence
    FROM public.positioning_evidence_observations AS evidence
   WHERE evidence.source_authority = p_source_authority
     AND evidence.dataset_code = p_dataset_code
     AND evidence.instrument_code = p_instrument_code
     AND evidence.metric_code = p_metric_code
     AND evidence.period_end = p_period_end
     AND evidence.revision_key = COALESCE(p_revision, '');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'positioning evidence replay identity disappeared after conflict'
      USING ERRCODE = '40001';
  END IF;

  IF v_evidence.value IS DISTINCT FROM p_value
     OR v_evidence.unit IS DISTINCT FROM p_unit
     OR v_evidence.published_at IS DISTINCT FROM p_published_at
     OR v_evidence.artifact_id IS DISTINCT FROM p_artifact_id THEN
    RAISE EXCEPTION 'positioning evidence identity reused with divergent payload'
      USING ERRCODE = '23505';
  END IF;

  RETURN QUERY SELECT v_evidence.id, 'REPLAYED'::text, v_evidence.observed_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_positioning_evidence_as_of(
  p_knowledge_cutoff TIMESTAMPTZ,
  p_max_evidence INTEGER DEFAULT 2048
)
RETURNS TABLE (
  evidence_id UUID,
  source_authority TEXT,
  dataset_code TEXT,
  instrument_code TEXT,
  metric_code TEXT,
  value NUMERIC,
  unit TEXT,
  period_end DATE,
  published_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ,
  artifact_id TEXT,
  revision TEXT
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_evidence_count BIGINT;
BEGIN
  IF p_knowledge_cutoff IS NULL OR NOT isfinite(p_knowledge_cutoff) THEN
    RAISE EXCEPTION 'knowledge cutoff must be a finite timestamp'
      USING ERRCODE = '22023';
  END IF;
  IF p_max_evidence IS NULL OR p_max_evidence NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'max evidence must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)
    INTO v_evidence_count
    FROM public.positioning_evidence_observations AS evidence
   WHERE evidence.published_at <= p_knowledge_cutoff
     AND evidence.observed_at <= p_knowledge_cutoff;

  IF v_evidence_count > p_max_evidence THEN
    RAISE EXCEPTION
      'positioning as-of evidence history exceeds explicit bound (% > %)',
      v_evidence_count, p_max_evidence
      USING ERRCODE = '54000';
  END IF;

  RETURN QUERY
  SELECT evidence.id, evidence.source_authority, evidence.dataset_code,
    evidence.instrument_code, evidence.metric_code, evidence.value,
    evidence.unit, evidence.period_end, evidence.published_at,
    evidence.observed_at, evidence.artifact_id, evidence.revision
  FROM public.positioning_evidence_observations AS evidence
  WHERE evidence.published_at <= p_knowledge_cutoff
    AND evidence.observed_at <= p_knowledge_cutoff
  ORDER BY evidence.source_authority, evidence.dataset_code,
    evidence.instrument_code, evidence.metric_code, evidence.period_end,
    evidence.revision_key, evidence.published_at, evidence.observed_at,
    evidence.artifact_id, evidence.id;
END;
$$;

ALTER TABLE public.positioning_evidence_observations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.positioning_evidence_observations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.positioning_evidence_observations TO service_role;

REVOKE ALL ON FUNCTION public.fn_positioning_evidence_append_only()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_positioning_evidence_append_only()
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_positioning_evidence_record(
  TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, DATE, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_positioning_evidence_record(
  TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, DATE, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.fn_positioning_evidence_as_of(
  TIMESTAMPTZ, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_positioning_evidence_as_of(
  TIMESTAMPTZ, INTEGER
) TO service_role;

COMMENT ON TABLE public.positioning_evidence_observations IS
  'P-1 append-only provider-neutral evidence only. No provider or positioning methodology is approved.';
COMMENT ON COLUMN public.positioning_evidence_observations.observed_at IS
  'Database-owned first-knowledge timestamp used for historical no-lookahead replay.';
COMMENT ON FUNCTION public.fn_positioning_evidence_as_of(TIMESTAMPTZ, INTEGER) IS
  'Returns complete eligible positioning evidence or fails when the explicit bound would truncate it.';

COMMIT;
