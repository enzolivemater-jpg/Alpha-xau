-- Behavioral contract against real PostgreSQL, after migrations 0023/0024.
-- Every fixture, helper and assessment in this file is rolled back.
BEGIN;
SET LOCAL statement_timeout = '20s';
SET LOCAL ROLE service_role;
CREATE TEMP TABLE ei_results (label TEXT NOT NULL);

CREATE FUNCTION pg_temp.ei_assert(ok BOOLEAN, label TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  INSERT INTO pg_temp.ei_results VALUES (label);
END;
$$;

CREATE FUNCTION pg_temp.ei_call(request JSONB)
RETURNS TABLE (assessment_id UUID, replayed BOOLEAN, interpretation_count INTEGER)
LANGUAGE sql AS $$
  SELECT * FROM public.fn_event_impact_create_assessment(
    (request->>'event_version_id')::UUID, request->>'assessment_status',
    (request->>'knowledge_cutoff')::TIMESTAMPTZ, request->>'producer_type',
    request->>'producer_actor', request->>'algorithm_version',
    request->>'input_fingerprint', request->>'semantic_fingerprint',
    request->>'idempotency_fingerprint', request->'interpretations',
    (request->>'supersedes_assessment_id')::UUID
  );
$$;

DO $$
DECLARE
  ev RECORD;
  request JSONB;
  children JSONB := '[
    {"horizon":"H1","interpretation_key":"main","interpretation_role":"PRIMARY","direction":"UNKNOWN","magnitude_state":"ESTIMATED","magnitude_value":12.50,"magnitude_unit":"probe-unit","magnitude_basis":"synthetic test only","confidence_state":"ESTIMATED","confidence_value":0.123456,"pricing_state":"UNASSESSED","rationale":"synthetic test only"},
    {"horizon":"H1","interpretation_key":"alternative","interpretation_role":"ALTERNATIVE","direction":"UNKNOWN","magnitude_state":"UNKNOWN","confidence_state":"UNKNOWN","pricing_state":"UNASSESSED"},
    {"horizon":"H2","interpretation_key":"main","interpretation_role":"PRIMARY","direction":"UNKNOWN","magnitude_state":"UNASSESSED","confidence_state":"UNASSESSED","pricing_state":"UNASSESSED"}
  ]'::JSONB;
  first_result RECORD;
  result RECORD;
  successor RECORD;
  reordered JSONB;
  changed JSONB;
  pair RECORD;
  bad JSONB;
  before_parents BIGINT;
  before_children BIGINT;
BEGIN
  SELECT id, knowledge_cutoff INTO STRICT ev FROM public.event_versions ORDER BY id LIMIT 1;
  request := jsonb_build_object(
    'event_version_id', ev.id, 'assessment_status', 'ASSESSED',
    'knowledge_cutoff', ev.knowledge_cutoff, 'producer_type', 'DETERMINISTIC',
    'producer_actor', 'ei-rpc-transactional-probe', 'algorithm_version', 'probe-v1',
    'input_fingerprint', repeat('a',64), 'semantic_fingerprint', repeat('b',64),
    'idempotency_fingerprint', repeat('c',64), 'interpretations', children
  );
  SELECT * INTO first_result FROM pg_temp.ei_call(request);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ei_assert(NOT first_result.replayed AND first_result.interpretation_count=3, 'atomic parent and three children');
  PERFORM pg_temp.ei_assert((SELECT knowledge_cutoff=ev.knowledge_cutoff FROM public.event_impact_assessments WHERE id=first_result.assessment_id), 'microsecond cutoff preserved');
  PERFORM pg_temp.ei_assert((SELECT confidence_value=0.1235 FROM public.event_impact_interpretations WHERE assessment_id=first_result.assessment_id AND horizon='H1' AND interpretation_key='main'), 'confidence stored at schema precision');

  SELECT * INTO result FROM pg_temp.ei_call(request);
  PERFORM pg_temp.ei_assert(result.replayed AND result.assessment_id=first_result.assessment_id AND result.interpretation_count=3, 'exact replay after numeric rounding');

  SELECT jsonb_agg(jsonb_build_object('magnitude_value',NULL,'magnitude_unit',NULL,'magnitude_basis',NULL,'confidence_value',NULL,'rationale',NULL)||item ORDER BY ord DESC)
  INTO reordered FROM jsonb_array_elements(children) WITH ORDINALITY AS items(item,ord);
  SELECT * INTO result FROM pg_temp.ei_call(request||jsonb_build_object('interpretations',reordered));
  PERFORM pg_temp.ei_assert(result.replayed AND result.assessment_id=first_result.assessment_id, 'array order and missing nullable fields do not change replay');
  SELECT * INTO result FROM pg_temp.ei_call(jsonb_set(request,'{interpretations,0,confidence_value}','0.1235'::JSONB));
  PERFORM pg_temp.ei_assert(result.replayed, 'canonical confidence equals stored precision');

  FOR pair IN SELECT * FROM jsonb_each(jsonb_build_object(
    'event_version_id','00000000-0000-0000-0000-000000000099',
    'assessment_status','UNAVAILABLE','knowledge_cutoff','2099-01-01T00:00:00Z',
    'producer_type','HUMAN','producer_actor','another-actor','algorithm_version','probe-v2',
    'input_fingerprint',repeat('d',64),'semantic_fingerprint',repeat('e',64),
    'supersedes_assessment_id','00000000-0000-0000-0000-000000000099'
  )) LOOP
    changed := request||jsonb_build_object(pair.key,pair.value);
    IF pair.key='assessment_status' THEN changed := changed||'{"interpretations":[]}'::JSONB; END IF;
    BEGIN
      PERFORM pg_temp.ei_call(changed);
      RAISE EXCEPTION 'accepted conflicting parent field';
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_temp.ei_assert(SQLERRM LIKE 'EVENT_IMPACT_IDEMPOTENCY_CONFLICT:%', 'parent conflict: '||pair.key);
    END;
  END LOOP;
  FOR pair IN SELECT * FROM jsonb_each('{
    "horizon":"H3","interpretation_key":"different","interpretation_role":"ALTERNATIVE",
    "direction":"NEUTRAL","magnitude_state":"UNKNOWN","magnitude_value":13,
    "magnitude_unit":"different","magnitude_basis":"different","confidence_state":"UNKNOWN",
    "confidence_value":0.1236,"pricing_state":"UNCERTAIN","rationale":"different"
  }'::JSONB) LOOP
    BEGIN
      PERFORM pg_temp.ei_call(jsonb_set(request,ARRAY['interpretations','0',pair.key],pair.value));
      RAISE EXCEPTION 'accepted conflicting child field';
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_temp.ei_assert(SQLERRM LIKE 'EVENT_IMPACT_IDEMPOTENCY_CONFLICT:%', 'child conflict: '||pair.key);
    END;
  END LOOP;

  FOR bad IN SELECT value FROM jsonb_array_elements('[{},null,[1],[null],[{"typo":1}]]'::JSONB) LOOP
    BEGIN
      PERFORM pg_temp.ei_call(request||jsonb_build_object('interpretations',bad));
      RAISE EXCEPTION 'accepted invalid JSON shape/key';
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_temp.ei_assert(SQLERRM LIKE 'EVENT_IMPACT_INVALID_INTERPRETATIONS:%', 'invalid JSON shape/key: '||bad::TEXT);
    END;
  END LOOP;
  BEGIN
    PERFORM pg_temp.ei_call(request-'interpretations');
    RAISE EXCEPTION 'accepted SQL NULL interpretations';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ei_assert(SQLERRM LIKE 'EVENT_IMPACT_INVALID_INTERPRETATIONS:%', 'SQL NULL interpretations rejected');
  END;
  BEGIN
    PERFORM pg_temp.ei_call(request||'{"interpretations":[]}'::JSONB);
    RAISE EXCEPTION 'accepted empty ASSESSED';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ei_assert(SQLERRM LIKE 'EVENT_IMPACT_STATUS_CHILD_CONFLICT:%', 'ASSESSED needs children');
  END;
  BEGIN
    PERFORM pg_temp.ei_call(request||'{"assessment_status":"UNAVAILABLE"}'::JSONB);
    RAISE EXCEPTION 'accepted non-ASSESSED with children';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ei_assert(SQLERRM LIKE 'EVENT_IMPACT_STATUS_CHILD_CONFLICT:%', 'non-ASSESSED rejects children');
  END;
  FOR pair IN SELECT * FROM jsonb_each_text('{"d":"INSUFFICIENT_EVIDENCE","e":"UNAVAILABLE"}'::JSONB) LOOP
    changed := request||jsonb_build_object('assessment_status',pair.value,'interpretations','[]'::JSONB,'idempotency_fingerprint',repeat(pair.key,64));
    SELECT * INTO result FROM pg_temp.ei_call(changed);
    PERFORM pg_temp.ei_assert(NOT result.replayed AND result.interpretation_count=0, pair.value||' persists with zero children');
    SELECT * INTO result FROM pg_temp.ei_call(changed);
    PERFORM pg_temp.ei_assert(result.replayed AND result.interpretation_count=0, pair.value||' replays');
  END LOOP;

  SELECT count(*) INTO before_parents FROM public.event_impact_assessments;
  SELECT count(*) INTO before_children FROM public.event_impact_interpretations;
  BEGIN
    PERFORM pg_temp.ei_call(jsonb_set(request||jsonb_build_object('idempotency_fingerprint',repeat('f',64)),'{interpretations,0,horizon}','"H6"'::JSONB));
    RAISE EXCEPTION 'accepted H6';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.ei_assert(TRUE, 'H6 rejected by schema');
  END;
  BEGIN
    PERFORM pg_temp.ei_call(request||jsonb_build_object('idempotency_fingerprint',repeat('f',64),'interpretations',jsonb_build_array(children->1)));
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'accepted horizon without PRIMARY';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ei_assert(SQLERRM LIKE '%aucune interprétation PRIMARY%', 'missing PRIMARY rejected at transaction boundary');
  END;
  BEGIN
    PERFORM pg_temp.ei_call(request||jsonb_build_object('idempotency_fingerprint',repeat('f',64),'knowledge_cutoff',ev.knowledge_cutoff-interval '1 microsecond'));
    RAISE EXCEPTION 'accepted cutoff regression';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.ei_assert(SQLERRM LIKE '%antérieur au knowledge_cutoff%', 'cutoff regression rejected');
  END;
  PERFORM pg_temp.ei_assert((SELECT count(*)=before_parents FROM public.event_impact_assessments) AND (SELECT count(*)=before_children FROM public.event_impact_interpretations), 'failed calls leave no partial parent or children');

  changed := request||jsonb_build_object('idempotency_fingerprint',repeat('7',64),'semantic_fingerprint',repeat('8',64),'supersedes_assessment_id',first_result.assessment_id);
  SELECT * INTO successor FROM pg_temp.ei_call(changed);
  SELECT * INTO result FROM pg_temp.ei_call(changed);
  PERFORM pg_temp.ei_assert(result.replayed AND result.assessment_id=successor.assessment_id, 'superseding assessment replays');
  SELECT * INTO result FROM pg_temp.ei_call(request||jsonb_build_object('idempotency_fingerprint',repeat('9',64),'supersedes_assessment_id',successor.assessment_id));
  PERFORM pg_temp.ei_assert(NOT result.replayed AND result.assessment_id<>first_result.assessment_id, 'A to B to A remains representable');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.ei_assert(TRUE, 'all deferred invariants satisfied');
END;
$$;

SELECT count(*) AS passed_transactional_assertions FROM pg_temp.ei_results;
ROLLBACK;
