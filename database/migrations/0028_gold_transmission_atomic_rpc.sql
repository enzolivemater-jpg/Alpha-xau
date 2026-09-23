-- GT-2 — atomic, idempotent persistence for the GT-1 Model S schema.
-- The caller owns all semantic decisions. This RPC validates shape, persists
-- one assessment followed by its paths and native-driver evidence, and never
-- updates prior rows or derives pricing, positioning, magnitude, or a trade.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_gold_transmission_create_assessment(
  p_event_version_id          UUID,
  p_assessment_status         TEXT,
  p_assessment_reason         TEXT,
  p_knowledge_cutoff          TIMESTAMPTZ,
  p_producer_type             TEXT,
  p_producer_actor            TEXT,
  p_algorithm_version         TEXT,
  p_input_fingerprint         TEXT,
  p_semantic_fingerprint      TEXT,
  p_idempotency_fingerprint   TEXT,
  p_paths                     JSONB,
  p_supersedes_assessment_id  UUID DEFAULT NULL
)
RETURNS TABLE (
  assessment_id UUID,
  replayed      BOOLEAN,
  path_count    INTEGER,
  evidence_count INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_path                         JSONB;
  v_evidence                     JSONB;
  v_evidence_array               JSONB;
  v_unknown_keys                 TEXT[];
  v_canonical_paths              JSONB;
  v_existing                     RECORD;
  v_existing_canonical_paths     JSONB;
  v_assessment_id                UUID;
  v_path_id                      UUID;
  v_inserted_paths               INTEGER := 0;
  v_inserted_evidence            INTEGER := 0;
  v_row_count                    INTEGER;
  v_existing_path_count          INTEGER;
  v_existing_evidence_count      INTEGER;
BEGIN
  IF p_event_version_id IS NULL OR p_assessment_status IS NULL
     OR p_knowledge_cutoff IS NULL OR p_producer_type IS NULL THEN
    RAISE EXCEPTION 'GOLD_TRANSMISSION_INVALID_REQUEST: required scalar is NULL';
  END IF;
  IF p_producer_actor IS NULL OR length(btrim(p_producer_actor)) = 0
     OR p_algorithm_version IS NULL OR length(btrim(p_algorithm_version)) = 0
     OR p_input_fingerprint IS NULL OR length(btrim(p_input_fingerprint)) = 0
     OR p_semantic_fingerprint IS NULL OR length(btrim(p_semantic_fingerprint)) = 0
     OR p_idempotency_fingerprint IS NULL OR length(btrim(p_idempotency_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'GOLD_TRANSMISSION_INVALID_REQUEST: required text scalar is blank';
  END IF;
  IF p_paths IS NULL OR jsonb_typeof(p_paths) <> 'array' THEN
    RAISE EXCEPTION 'GOLD_TRANSMISSION_INVALID_PATHS: p_paths must be a JSON array';
  END IF;

  FOR v_path IN SELECT value FROM jsonb_array_elements(p_paths) AS paths(value) LOOP
    IF jsonb_typeof(v_path) <> 'object' THEN
      RAISE EXCEPTION 'GOLD_TRANSMISSION_INVALID_PATHS: every path must be a JSON object';
    END IF;
    SELECT array_agg(key ORDER BY key) INTO v_unknown_keys
      FROM jsonb_object_keys(v_path) AS key
     WHERE key NOT IN (
       'path_key', 'transmission_channel', 'market_variable', 'variable_effect',
       'gold_effect', 'confidence_state', 'confidence_value', 'rationale',
       'driver_evidence'
     );
    IF v_unknown_keys IS NOT NULL THEN
      RAISE EXCEPTION 'GOLD_TRANSMISSION_INVALID_PATHS: unknown path key(s): %', v_unknown_keys;
    END IF;

    v_evidence_array := CASE
      WHEN v_path ? 'driver_evidence' THEN v_path -> 'driver_evidence'
      ELSE '[]'::jsonb
    END;
    IF jsonb_typeof(v_evidence_array) <> 'array' THEN
      RAISE EXCEPTION 'GOLD_TRANSMISSION_INVALID_EVIDENCE: driver_evidence must be a JSON array';
    END IF;
    FOR v_evidence IN SELECT value FROM jsonb_array_elements(v_evidence_array) AS evidence(value) LOOP
      IF jsonb_typeof(v_evidence) <> 'object' THEN
        RAISE EXCEPTION 'GOLD_TRANSMISSION_INVALID_EVIDENCE: every evidence item must be a JSON object';
      END IF;
      SELECT array_agg(key ORDER BY key) INTO v_unknown_keys
        FROM jsonb_object_keys(v_evidence) AS key
       WHERE key NOT IN ('market_tick_id', 'market_tick_ts', 'evidence_role');
      IF v_unknown_keys IS NOT NULL THEN
        RAISE EXCEPTION 'GOLD_TRANSMISSION_INVALID_EVIDENCE: unknown evidence key(s): %', v_unknown_keys;
      END IF;
    END LOOP;
  END LOOP;

  IF p_assessment_status = 'ASSESSED' AND jsonb_array_length(p_paths) = 0 THEN
    RAISE EXCEPTION 'GOLD_TRANSMISSION_STATUS_PATH_CONFLICT: ASSESSED requires at least one path';
  ELSIF p_assessment_status IN ('INSUFFICIENT_EVIDENCE', 'UNAVAILABLE')
        AND jsonb_array_length(p_paths) <> 0 THEN
    RAISE EXCEPTION 'GOLD_TRANSMISSION_STATUS_PATH_CONFLICT: % requires an empty path array', p_assessment_status;
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'path_key', norm.path_key,
      'transmission_channel', norm.transmission_channel,
      'market_variable', norm.market_variable,
      'variable_effect', norm.variable_effect,
      'gold_effect', norm.gold_effect,
      'confidence_state', norm.confidence_state,
      'confidence_value', norm.confidence_value,
      'rationale', norm.rationale,
      'driver_evidence', norm.driver_evidence
    ) ORDER BY norm.path_key
  ), '[]'::jsonb)
    INTO v_canonical_paths
    FROM (
      SELECT
        item ->> 'path_key' AS path_key,
        item ->> 'transmission_channel' AS transmission_channel,
        item ->> 'market_variable' AS market_variable,
        item ->> 'variable_effect' AS variable_effect,
        item ->> 'gold_effect' AS gold_effect,
        item ->> 'confidence_state' AS confidence_state,
        (item ->> 'confidence_value')::NUMERIC(5,4) AS confidence_value,
        item ->> 'rationale' AS rationale,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'market_tick_id', (e ->> 'market_tick_id')::UUID,
            'market_tick_ts', (e ->> 'market_tick_ts')::TIMESTAMPTZ,
            'evidence_role', e ->> 'evidence_role'
          ) ORDER BY (e ->> 'market_tick_id')::UUID,
                     (e ->> 'market_tick_ts')::TIMESTAMPTZ,
                     e ->> 'evidence_role')
          FROM jsonb_array_elements(CASE
            WHEN item ? 'driver_evidence' THEN item -> 'driver_evidence'
            ELSE '[]'::jsonb
          END) AS evidence(e)
        ), '[]'::jsonb) AS driver_evidence
      FROM jsonb_array_elements(p_paths) AS paths(item)
    ) AS norm;

  SELECT gta.id, gta.event_version_id, gta.assessment_status, gta.assessment_reason,
         gta.knowledge_cutoff, gta.producer_type, gta.producer_actor,
         gta.algorithm_version, gta.input_fingerprint, gta.semantic_fingerprint,
         gta.supersedes_assessment_id
    INTO v_existing
    FROM public.gold_transmission_assessments AS gta
   WHERE gta.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'path_key', gtp.path_key,
      'transmission_channel', gtp.transmission_channel,
      'market_variable', gtp.market_variable,
      'variable_effect', gtp.variable_effect,
      'gold_effect', gtp.gold_effect,
      'confidence_state', gtp.confidence_state,
      'confidence_value', gtp.confidence_value,
      'rationale', gtp.rationale,
      'driver_evidence', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'market_tick_id', gtde.market_tick_id,
          'market_tick_ts', gtde.market_tick_ts,
          'evidence_role', gtde.evidence_role
        ) ORDER BY gtde.market_tick_id, gtde.market_tick_ts, gtde.evidence_role)
        FROM public.gold_transmission_driver_evidence AS gtde
        WHERE gtde.path_id = gtp.id
      ), '[]'::jsonb)
    ) ORDER BY gtp.path_key), '[]'::jsonb)
      INTO v_existing_canonical_paths
      FROM public.gold_transmission_paths AS gtp
     WHERE gtp.assessment_id = v_existing.id;

    IF v_existing.event_version_id IS DISTINCT FROM p_event_version_id
       OR v_existing.assessment_status IS DISTINCT FROM p_assessment_status
       OR v_existing.assessment_reason IS DISTINCT FROM p_assessment_reason
       OR v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff
       OR v_existing.producer_type IS DISTINCT FROM p_producer_type
       OR v_existing.producer_actor IS DISTINCT FROM p_producer_actor
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.input_fingerprint IS DISTINCT FROM p_input_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM p_semantic_fingerprint
       OR v_existing.supersedes_assessment_id IS DISTINCT FROM p_supersedes_assessment_id
       OR v_existing_canonical_paths IS DISTINCT FROM v_canonical_paths THEN
      RAISE EXCEPTION 'GOLD_TRANSMISSION_IDEMPOTENCY_CONFLICT: fingerprint belongs to a different committed request';
    END IF;

    SELECT count(*) INTO v_existing_path_count
      FROM public.gold_transmission_paths AS existing_path
     WHERE existing_path.assessment_id = v_existing.id;
    SELECT count(*) INTO v_existing_evidence_count
      FROM public.gold_transmission_driver_evidence AS gtde
      JOIN public.gold_transmission_paths AS gtp ON gtp.id = gtde.path_id
     WHERE gtp.assessment_id = v_existing.id;
    RETURN QUERY SELECT v_existing.id, true, v_existing_path_count, v_existing_evidence_count;
    RETURN;
  END IF;

  INSERT INTO public.gold_transmission_assessments AS gta (
    event_version_id, model_variant, assessment_status, assessment_reason,
    knowledge_cutoff, producer_type, producer_actor, algorithm_version,
    input_fingerprint, semantic_fingerprint, idempotency_fingerprint,
    supersedes_assessment_id
  ) VALUES (
    p_event_version_id, 'SEMANTIC', p_assessment_status, p_assessment_reason,
    p_knowledge_cutoff, p_producer_type, p_producer_actor, p_algorithm_version,
    p_input_fingerprint, p_semantic_fingerprint, p_idempotency_fingerprint,
    p_supersedes_assessment_id
  )
  ON CONFLICT (idempotency_fingerprint) DO NOTHING
  RETURNING gta.id INTO v_assessment_id;

  IF v_assessment_id IS NOT NULL THEN
    FOR v_path IN SELECT value FROM jsonb_array_elements(v_canonical_paths) AS paths(value) LOOP
      INSERT INTO public.gold_transmission_paths (
        assessment_id, path_key, transmission_channel, market_variable,
        variable_effect, gold_effect, confidence_state, confidence_value, rationale
      ) VALUES (
        v_assessment_id, v_path ->> 'path_key', v_path ->> 'transmission_channel',
        v_path ->> 'market_variable', v_path ->> 'variable_effect',
        v_path ->> 'gold_effect', v_path ->> 'confidence_state',
        (v_path ->> 'confidence_value')::NUMERIC(5,4), v_path ->> 'rationale'
      ) RETURNING id INTO v_path_id;
      v_inserted_paths := v_inserted_paths + 1;

      INSERT INTO public.gold_transmission_driver_evidence (
        path_id, market_tick_id, market_tick_ts, evidence_role
      )
      SELECT v_path_id, evidence.market_tick_id, evidence.market_tick_ts, evidence.evidence_role
      FROM jsonb_to_recordset(v_path -> 'driver_evidence') AS evidence(
        market_tick_id UUID, market_tick_ts TIMESTAMPTZ, evidence_role TEXT
      );
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_inserted_evidence := v_inserted_evidence + v_row_count;
    END LOOP;

    RETURN QUERY SELECT v_assessment_id, false, v_inserted_paths, v_inserted_evidence;
    RETURN;
  END IF;

  -- A concurrent transaction committed the same unique fingerprint after the
  -- pre-check. Re-enter the function after that commit for one strict replay
  -- comparison; no recursion occurs because the committed row is now visible.
  RETURN QUERY
  SELECT replay.assessment_id, replay.replayed, replay.path_count, replay.evidence_count
  FROM public.fn_gold_transmission_create_assessment(
    p_event_version_id, p_assessment_status, p_assessment_reason,
    p_knowledge_cutoff, p_producer_type, p_producer_actor, p_algorithm_version,
    p_input_fingerprint, p_semantic_fingerprint, p_idempotency_fingerprint,
    p_paths, p_supersedes_assessment_id
  ) AS replay;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.fn_gold_transmission_create_assessment IS
  'GT-2 atomic persistence only: one immutable semantic assessment, then canonical paths and exact native-driver evidence. Exact replay returns replayed=true; a divergent request sharing the fingerprint fails closed. No domain inference or runtime activation.';

REVOKE ALL ON FUNCTION public.fn_gold_transmission_create_assessment(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_gold_transmission_create_assessment(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID
) TO service_role;

COMMIT;
