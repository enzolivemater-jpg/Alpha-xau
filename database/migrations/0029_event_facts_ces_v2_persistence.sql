-- EF-3 — additive persistence gate for the single reviewed CES V2 producer.
--
-- This migration does not activate a collector or runtime. It only permits the
-- exact US_CPI shape emitted by bls-cpi-event-facts-adapter-v1 to cross the
-- existing event_versions persistence boundary. CES V1 remains valid, EI/GT
-- remain fail-closed on schema version 2, and no canonical table is added.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_event_is_supported_canonical_state(
  p_schema_version SMALLINT,
  p_state          JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_metric       JSONB;
  v_code         TEXT;
  v_period_key   TEXT := NULL;
  v_seen_codes   TEXT[] := ARRAY[]::TEXT[];
  v_actual_value TEXT;
BEGIN
  IF jsonb_typeof(p_state) <> 'object' OR p_state = '{}'::jsonb THEN
    RETURN FALSE;
  END IF;

  -- Preserve the existing CES V1 envelope while structurally preventing a
  -- V2 facts object from being smuggled under schema version 1.
  IF p_schema_version = 1 THEN
    RETURN NOT (p_state ? 'facts');
  END IF;

  -- EF-3 supports exactly schema version 2 and exactly the reviewed US_CPI
  -- adapter output. Future versions/families require their own reviewed gate.
  IF p_schema_version <> 2
     OR (SELECT count(*) FROM jsonb_object_keys(p_state)) <> 4
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_state) AS keys(key)
        WHERE key NOT IN ('event_type', 'subject', 'detail', 'facts')
     )
     OR p_state ->> 'event_type' <> 'STATISTICAL_RELEASE'
     OR jsonb_typeof(p_state -> 'subject') <> 'string'
     OR p_state ->> 'subject' = ''
     OR p_state ->> 'subject' <> btrim(p_state ->> 'subject')
     OR p_state ->> 'subject' ~ '[[:space:]]{2,}'
     OR p_state -> 'detail' <> 'null'::jsonb
     OR jsonb_typeof(p_state -> 'facts') <> 'object'
  THEN
    RETURN FALSE;
  END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(p_state -> 'facts')) <> 2
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_state -> 'facts') AS keys(key)
        WHERE key NOT IN ('release_family', 'metrics')
     )
     OR p_state #>> '{facts,release_family}' <> 'US_CPI'
     OR jsonb_typeof(p_state #> '{facts,metrics}') <> 'array'
     OR jsonb_array_length(p_state #> '{facts,metrics}') <> 4
  THEN
    RETURN FALSE;
  END IF;

  FOR v_metric IN
    SELECT value FROM jsonb_array_elements(p_state #> '{facts,metrics}') AS metrics(value)
  LOOP
    IF jsonb_typeof(v_metric) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_metric)) <> 6
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(v_metric) AS keys(key)
          WHERE key NOT IN (
            'metric_code', 'reference_period', 'unit',
            'actual', 'consensus', 'prior_periods'
          )
       )
    THEN
      RETURN FALSE;
    END IF;

    v_code := v_metric ->> 'metric_code';
    IF v_code NOT IN (
         'CPI_CORE_MOM', 'CPI_CORE_YOY',
         'CPI_HEADLINE_MOM', 'CPI_HEADLINE_YOY'
       )
       OR v_code = ANY(v_seen_codes)
       OR (
         v_code IN ('CPI_CORE_MOM', 'CPI_HEADLINE_MOM')
         AND v_metric ->> 'unit' <> 'PERCENT_CHANGE_MOM'
       )
       OR (
         v_code IN ('CPI_CORE_YOY', 'CPI_HEADLINE_YOY')
         AND v_metric ->> 'unit' <> 'PERCENT_CHANGE_YOY'
       )
    THEN
      RETURN FALSE;
    END IF;
    v_seen_codes := array_append(v_seen_codes, v_code);

    IF jsonb_typeof(v_metric -> 'reference_period') <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_metric -> 'reference_period')) <> 3
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(v_metric -> 'reference_period') AS keys(key)
          WHERE key NOT IN ('kind', 'year', 'month')
       )
       OR v_metric #>> '{reference_period,kind}' <> 'MONTH'
       OR jsonb_typeof(v_metric #> '{reference_period,year}') <> 'number'
       OR jsonb_typeof(v_metric #> '{reference_period,month}') <> 'number'
       OR v_metric #>> '{reference_period,year}' !~ '^[0-9]{4}$'
       OR v_metric #>> '{reference_period,month}' !~ '^(?:[1-9]|1[0-2])$'
       OR (v_metric #>> '{reference_period,year}')::INTEGER < 1900
    THEN
      RETURN FALSE;
    END IF;

    IF v_period_key IS NULL THEN
      v_period_key := (v_metric #>> '{reference_period,year}')
        || '-' || (v_metric #>> '{reference_period,month}');
    ELSIF v_period_key <> (
      (v_metric #>> '{reference_period,year}')
      || '-' || (v_metric #>> '{reference_period,month}')
    ) THEN
      RETURN FALSE;
    END IF;

    IF jsonb_typeof(v_metric -> 'actual') <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_metric -> 'actual')) <> 2
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(v_metric -> 'actual') AS keys(key)
          WHERE key NOT IN ('state', 'value')
       )
       OR v_metric #>> '{actual,state}' <> 'KNOWN'
       OR jsonb_typeof(v_metric #> '{actual,value}') <> 'string'
    THEN
      RETURN FALSE;
    END IF;
    v_actual_value := v_metric #>> '{actual,value}';
    IF v_actual_value !~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
       OR v_actual_value = '-0'
    THEN
      RETURN FALSE;
    END IF;

    IF jsonb_typeof(v_metric -> 'consensus') <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_metric -> 'consensus')) <> 2
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(v_metric -> 'consensus') AS keys(key)
          WHERE key NOT IN ('state', 'value')
       )
       OR v_metric #>> '{consensus,state}' <> 'UNKNOWN'
       OR v_metric #> '{consensus,value}' <> 'null'::jsonb
       OR jsonb_typeof(v_metric -> 'prior_periods') <> 'array'
       OR jsonb_array_length(v_metric -> 'prior_periods') <> 0
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN v_seen_codes @> ARRAY[
    'CPI_CORE_MOM', 'CPI_CORE_YOY',
    'CPI_HEADLINE_MOM', 'CPI_HEADLINE_YOY'
  ]::TEXT[];
END;
$$;

REVOKE ALL ON FUNCTION public.fn_event_is_supported_canonical_state(SMALLINT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_event_is_supported_canonical_state(SMALLINT, JSONB)
  TO service_role;

COMMENT ON FUNCTION public.fn_event_is_supported_canonical_state(SMALLINT, JSONB) IS
  'EF-3 immutable persistence gate. CES V1 remains accepted without facts; CES V2 is limited to the exact reviewed US_CPI adapter shape. No runtime activation or downstream support is implied.';

ALTER TABLE public.event_versions
  ADD CONSTRAINT chk_event_versions_supported_canonical_state
  CHECK (public.fn_event_is_supported_canonical_state(
    canonical_event_state_schema_version,
    canonical_event_state
  )) NOT VALID;

-- Existing rows are checked before the migration commits; NOT VALID avoids an
-- unnecessarily strong table lock while the constraint is installed.
ALTER TABLE public.event_versions
  VALIDATE CONSTRAINT chk_event_versions_supported_canonical_state;

COMMIT;
