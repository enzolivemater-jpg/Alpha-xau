-- EF-8 — atomic, replay-safe BLS CPI Event Facts production.
--
-- This migration does not schedule, fetch, parse, or activate a producer. It
-- persists only an already-reviewed EF-7 plan and exact retained evidence.
BEGIN;

CREATE TABLE IF NOT EXISTS public.event_version_official_artifacts (
  event_version_id UUID NOT NULL
    REFERENCES public.event_versions(id) ON DELETE RESTRICT,
  artifact_id UUID NOT NULL
    REFERENCES public.official_source_artifacts(id) ON DELETE RESTRICT,
  artifact_role TEXT NOT NULL
    CHECK (artifact_role IN ('RELEASE_HEADER_HTML', 'RELEASE_TABLE1_XLSX')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_version_id, artifact_id),
  UNIQUE (event_version_id, artifact_role)
);

CREATE OR REPLACE FUNCTION public.fn_event_fact_artifact_role_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_actual_role TEXT;
BEGIN
  SELECT a.artifact_role INTO v_actual_role
  FROM public.official_source_artifacts AS a
  WHERE a.id = NEW.artifact_id;
  IF NOT FOUND OR v_actual_role IS DISTINCT FROM NEW.artifact_role THEN
    RAISE EXCEPTION 'event fact artifact role mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_event_fact_artifact_role_guard
  BEFORE INSERT ON public.event_version_official_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.fn_event_fact_artifact_role_guard();
CREATE TRIGGER trg_event_version_official_artifacts_append_only
  BEFORE UPDATE OR DELETE ON public.event_version_official_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.fn_event_schema_append_only();

CREATE TABLE IF NOT EXISTS public.event_fact_production_operations (
  operation_idempotency_fingerprint TEXT PRIMARY KEY
    CHECK (length(btrim(operation_idempotency_fingerprint)) > 0),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  observation_id UUID NOT NULL REFERENCES public.news_articles(id) ON DELETE RESTRICT,
  header_artifact_id UUID NOT NULL REFERENCES public.official_source_artifacts(id) ON DELETE RESTRICT,
  table_artifact_id UUID NOT NULL REFERENCES public.official_source_artifacts(id) ON DELETE RESTRICT,
  cluster_id UUID NOT NULL REFERENCES public.event_clusters(id) ON DELETE RESTRICT,
  decision_id UUID NOT NULL REFERENCES public.event_observation_memberships(decision_id) ON DELETE RESTRICT,
  identity_claim_id UUID NOT NULL REFERENCES public.event_cluster_identity_claims(identity_claim_id) ON DELETE RESTRICT,
  event_version_id UUID NOT NULL REFERENCES public.event_versions(id) ON DELETE RESTRICT,
  knowledge_cutoff TIMESTAMPTZ NOT NULL,
  version_outcome TEXT NOT NULL CHECK (version_outcome IN ('CREATED', 'NO_MATERIAL_CHANGE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_version_official_artifacts_artifact
  ON public.event_version_official_artifacts (artifact_id);
CREATE INDEX IF NOT EXISTS idx_event_fact_operations_observation
  ON public.event_fact_production_operations (observation_id);
CREATE INDEX IF NOT EXISTS idx_event_fact_operations_header_artifact
  ON public.event_fact_production_operations (header_artifact_id);
CREATE INDEX IF NOT EXISTS idx_event_fact_operations_table_artifact
  ON public.event_fact_production_operations (table_artifact_id);
CREATE INDEX IF NOT EXISTS idx_event_fact_operations_cluster
  ON public.event_fact_production_operations (cluster_id);
CREATE INDEX IF NOT EXISTS idx_event_fact_operations_decision
  ON public.event_fact_production_operations (decision_id);
CREATE INDEX IF NOT EXISTS idx_event_fact_operations_identity_claim
  ON public.event_fact_production_operations (identity_claim_id);
CREATE INDEX IF NOT EXISTS idx_event_fact_operations_event_version
  ON public.event_fact_production_operations (event_version_id);

CREATE TRIGGER trg_event_fact_production_operations_append_only
  BEFORE UPDATE OR DELETE ON public.event_fact_production_operations
  FOR EACH ROW EXECUTE FUNCTION public.fn_event_schema_append_only();

ALTER TABLE public.event_version_official_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_fact_production_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_version_official_artifacts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.event_fact_production_operations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.event_version_official_artifacts TO service_role;
GRANT SELECT, INSERT ON public.event_fact_production_operations TO service_role;

CREATE OR REPLACE FUNCTION public.fn_event_fact_produce_bls_cpi(
  p_observation_id UUID,
  p_header_artifact_id UUID,
  p_table_artifact_id UUID,
  p_authority_namespace TEXT,
  p_identity_type TEXT,
  p_identity_value TEXT,
  p_canonical_event_state JSONB,
  p_operation_idempotency_fingerprint TEXT
)
RETURNS TABLE (
  cluster_id UUID,
  decision_id UUID,
  identity_claim_id UUID,
  event_version_id UUID,
  version_outcome TEXT,
  operation_replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_input_fingerprint TEXT;
  v_strong_identity_key TEXT;
  v_existing_operation RECORD;
  v_observation RECORD;
  v_header RECORD;
  v_table RECORD;
  v_active_claims RECORD;
  v_active_claim_count INTEGER;
  v_target_cluster_id UUID;
  v_membership RECORD;
  v_claim RECORD;
  v_identity_claim_id UUID;
  v_tip RECORD;
  v_version RECORD;
  v_knowledge_cutoff TIMESTAMPTZ;
  v_evidence_digest TEXT;
  v_semantic_fingerprint TEXT;
  v_membership_fingerprint TEXT;
  v_claim_fingerprint TEXT;
  v_version_fingerprint TEXT;
  v_transition_type TEXT;
BEGIN
  IF p_observation_id IS NULL OR p_header_artifact_id IS NULL OR p_table_artifact_id IS NULL THEN
    RAISE EXCEPTION 'EF8_REQUIRED_ID_MISSING';
  END IF;
  IF p_header_artifact_id = p_table_artifact_id THEN
    RAISE EXCEPTION 'EF8_ARTIFACT_IDS_MUST_DIFFER';
  END IF;
  IF p_authority_namespace IS DISTINCT FROM 'xau_v2:official_release:us_bls:v1'
     OR p_identity_type IS DISTINCT FROM 'official_release_id:bls_cpi_v1'
     OR p_identity_value IS NULL OR length(btrim(p_identity_value)) = 0 THEN
    RAISE EXCEPTION 'EF8_IDENTITY_SCOPE_INVALID';
  END IF;
  IF p_operation_idempotency_fingerprint IS NULL
     OR p_operation_idempotency_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'EF8_OPERATION_FINGERPRINT_INVALID';
  END IF;
  IF NOT public.fn_event_is_supported_canonical_state(2, p_canonical_event_state) THEN
    RAISE EXCEPTION 'EF8_CANONICAL_STATE_INVALID';
  END IF;

  v_input_fingerprint := encode(extensions.digest(
    jsonb_build_object(
      'observation_id', p_observation_id,
      'header_artifact_id', p_header_artifact_id,
      'table_artifact_id', p_table_artifact_id,
      'authority_namespace', p_authority_namespace,
      'identity_type', p_identity_type,
      'identity_value', p_identity_value,
      'canonical_event_state', p_canonical_event_state
    )::text,
    'sha256'
  ), 'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('xau_v2:event_facts_operation' || chr(31)
      || p_operation_idempotency_fingerprint, 0)
  );

  SELECT o.* INTO v_existing_operation
  FROM public.event_fact_production_operations AS o
  WHERE o.operation_idempotency_fingerprint = p_operation_idempotency_fingerprint;
  IF FOUND THEN
    IF v_existing_operation.input_fingerprint IS DISTINCT FROM v_input_fingerprint THEN
      RAISE EXCEPTION 'EF8_OPERATION_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN QUERY SELECT
      v_existing_operation.cluster_id,
      v_existing_operation.decision_id,
      v_existing_operation.identity_claim_id,
      v_existing_operation.event_version_id,
      v_existing_operation.version_outcome,
      true;
    RETURN;
  END IF;

  SELECT n.ingest_run_id, n.provider, n.source_code, n.source_domain,
         n.canonical_url, n.observed_at, n.ingested_at
    INTO v_observation
  FROM public.news_articles AS n WHERE n.id = p_observation_id;
  IF NOT FOUND
     OR v_observation.provider IS DISTINCT FROM 'bls'
     OR v_observation.source_code IS DISTINCT FROM 'bls_cpi_release'
     OR v_observation.source_domain IS DISTINCT FROM 'bls.gov'
     OR v_observation.canonical_url IS NULL
     OR v_observation.canonical_url !~ '^https://(www\.)?bls\.gov/' THEN
    RAISE EXCEPTION 'EF8_RAW_OBSERVATION_INVALID';
  END IF;

  SELECT a.ingest_run_id, a.artifact_role, a.content_sha256,
         a.observed_at, a.ingested_at
    INTO v_header
  FROM public.official_source_artifacts AS a WHERE a.id = p_header_artifact_id;
  SELECT a.ingest_run_id, a.artifact_role, a.content_sha256,
         a.observed_at, a.ingested_at
    INTO v_table
  FROM public.official_source_artifacts AS a WHERE a.id = p_table_artifact_id;
  IF v_header.artifact_role IS DISTINCT FROM 'RELEASE_HEADER_HTML'
     OR v_table.artifact_role IS DISTINCT FROM 'RELEASE_TABLE1_XLSX'
     OR v_header.ingest_run_id IS DISTINCT FROM v_table.ingest_run_id
     OR v_header.ingest_run_id IS DISTINCT FROM v_observation.ingest_run_id THEN
    RAISE EXCEPTION 'EF8_ARTIFACT_BUNDLE_INVALID';
  END IF;

  v_knowledge_cutoff := pg_catalog.transaction_timestamp();
  IF GREATEST(v_observation.observed_at, v_observation.ingested_at,
              v_header.observed_at, v_header.ingested_at,
              v_table.observed_at, v_table.ingested_at) > v_knowledge_cutoff THEN
    RAISE EXCEPTION 'EF8_FUTURE_EVIDENCE_FORBIDDEN';
  END IF;

  v_strong_identity_key := encode(extensions.digest(
    p_authority_namespace || chr(31) || p_identity_type || chr(31) || p_identity_value,
    'sha256'), 'hex');
  SELECT count(*) INTO v_active_claim_count
  FROM public.event_cluster_identity_claims AS c
  WHERE c.strong_identity_key = v_strong_identity_key
    AND NOT EXISTS (
      SELECT 1 FROM public.event_cluster_identity_claims AS successor
      WHERE successor.supersedes_claim_id = c.identity_claim_id
    );
  IF v_active_claim_count > 1 THEN RAISE EXCEPTION 'EF8_IDENTITY_COLLISION'; END IF;
  IF v_active_claim_count = 1 THEN
    SELECT c.cluster_id, c.identity_claim_id INTO v_active_claims
    FROM public.event_cluster_identity_claims AS c
    WHERE c.strong_identity_key = v_strong_identity_key
      AND NOT EXISTS (
        SELECT 1 FROM public.event_cluster_identity_claims AS successor
        WHERE successor.supersedes_claim_id = c.identity_claim_id
      );
    v_target_cluster_id := v_active_claims.cluster_id;
  END IF;

  v_evidence_digest := encode(extensions.digest(
    v_header.content_sha256 || chr(31) || v_table.content_sha256, 'sha256'), 'hex');
  v_semantic_fingerprint := encode(extensions.digest(p_canonical_event_state::text, 'sha256'), 'hex');
  v_membership_fingerprint := encode(extensions.digest(
    'ef8:membership' || chr(31) || p_operation_idempotency_fingerprint, 'sha256'), 'hex');
  v_claim_fingerprint := encode(extensions.digest(
    'ef8:identity' || chr(31) || p_operation_idempotency_fingerprint, 'sha256'), 'hex');
  v_version_fingerprint := encode(extensions.digest(
    'ef8:event-version' || chr(31) || p_operation_idempotency_fingerprint, 'sha256'), 'hex');

  IF v_target_cluster_id IS NOT NULL THEN
    PERFORM public.fn_event_lock_cluster(v_target_cluster_id);
    SELECT m.cluster_id, m.decision_id, false AS cluster_created_now, true AS replayed
      INTO v_membership
    FROM public.event_observation_memberships AS m
    WHERE m.observation_id = p_observation_id
      AND m.cluster_id = v_target_cluster_id
      AND m.decision_type IN ('ASSIGN', 'AMEND')
      AND NOT EXISTS (
        SELECT 1 FROM public.event_observation_memberships AS successor
        WHERE successor.supersedes_decision_id = m.decision_id
      )
    ORDER BY m.assigned_at DESC, m.decision_id DESC
    LIMIT 1;
  END IF;
  IF NOT FOUND OR v_target_cluster_id IS NULL THEN
    SELECT * INTO v_membership FROM public.fn_event_assign_observation(
      p_observation_id => p_observation_id,
      p_membership_method => 'CURATED_OFFICIAL_RELEASE',
      p_evidence_digest => v_evidence_digest,
      p_membership_algorithm_version => 'ef8-bls-cpi-atomic-production-v1',
      p_decision_actor => 'event-facts-bls-cpi-v1',
      p_idempotency_fingerprint => v_membership_fingerprint,
      p_semantic_state_fingerprint => v_semantic_fingerprint,
      p_cluster_id => v_target_cluster_id,
      p_cluster_key => CASE WHEN v_target_cluster_id IS NULL
        THEN 'official-release:' || v_strong_identity_key ELSE NULL END,
      p_category => CASE WHEN v_target_cluster_id IS NULL THEN 'STATISTICAL_RELEASE' ELSE NULL END,
      p_region => CASE WHEN v_target_cluster_id IS NULL THEN 'US' ELSE NULL END,
      p_cluster_algorithm_version => CASE WHEN v_target_cluster_id IS NULL
        THEN 'ef8-bls-cpi-cluster-v1' ELSE NULL END,
      p_membership_confidence => 1,
      p_editorial_origin_key => 'authority:us_bls',
      p_wire_lineage_key => NULL,
      p_lineage_resolution_method => 'DIRECT_OFFICIAL_SOURCE',
      p_lineage_resolution_confidence => 1,
      p_lineage_evidence => 'exact retained BLS CPI release header and Table 1 bytes'
    );
  END IF;
  v_target_cluster_id := v_membership.cluster_id;

  IF v_active_claim_count = 0 THEN
    SELECT * INTO v_claim FROM public.fn_event_assert_identity_claim(
      p_cluster_id => v_target_cluster_id,
      p_authority_namespace => p_authority_namespace,
      p_identity_type => p_identity_type,
      p_identity_value => p_identity_value,
      p_knowledge_cutoff => v_knowledge_cutoff,
      p_algorithm_version => 'ef8-bls-cpi-identity-v1',
      p_decision_actor => 'event-facts-bls-cpi-v1',
      p_reason => 'exact official BLS release identifier from retained header bytes',
      p_idempotency_fingerprint => v_claim_fingerprint,
      p_supersedes_claim_id => NULL
    );
    v_identity_claim_id := v_claim.identity_claim_id;
  ELSE
    -- The membership RPC holds the cluster lock. Re-read after that lock so
    -- a concurrent supersession/collision can never be silently ignored.
    SELECT c.cluster_id, c.identity_claim_id INTO v_active_claims
    FROM public.event_cluster_identity_claims AS c
    WHERE c.strong_identity_key = v_strong_identity_key
      AND NOT EXISTS (
        SELECT 1 FROM public.event_cluster_identity_claims AS successor
        WHERE successor.supersedes_claim_id = c.identity_claim_id
      );
    IF NOT FOUND OR v_active_claims.cluster_id IS DISTINCT FROM v_target_cluster_id THEN
      RAISE EXCEPTION 'EF8_IDENTITY_CHANGED_DURING_OPERATION';
    END IF;
    v_identity_claim_id := v_active_claims.identity_claim_id;
  END IF;

  SELECT ev.id, ev.version_number INTO v_tip
  FROM public.event_versions AS ev
  WHERE ev.cluster_id = v_target_cluster_id
  ORDER BY ev.version_number DESC LIMIT 1;
  v_transition_type := CASE WHEN FOUND THEN 'CORRECTION' ELSE 'NOVELTY' END;

  SELECT * INTO v_version FROM public.fn_event_create_event_version(
    p_cluster_id => v_target_cluster_id,
    p_transition_type => v_transition_type,
    p_knowledge_cutoff => v_knowledge_cutoff,
    p_effective_time => NULL,
    p_effective_time_precision => NULL,
    p_canonical_event_state_schema_version => 2,
    p_canonical_event_state => p_canonical_event_state,
    p_official_confirmation_state => 'OFFICIALLY_CONFIRMED',
    p_source_independence_state => 'SINGLE_EDITORIAL_ORIGIN',
    p_algorithm_version => 'ef8-bls-cpi-event-version-v1',
    p_decision_actor => 'event-facts-bls-cpi-v1',
    p_idempotency_fingerprint => v_version_fingerprint,
    p_supersedes_version_id => v_tip.id
  );
  IF v_version.outcome NOT IN ('CREATED', 'NO_MATERIAL_CHANGE') THEN
    RAISE EXCEPTION 'EF8_UNEXPECTED_VERSION_OUTCOME';
  END IF;

  IF v_version.outcome = 'CREATED' THEN
    INSERT INTO public.event_version_official_artifacts
      (event_version_id, artifact_id, artifact_role)
    VALUES
      (v_version.event_version_id, p_header_artifact_id, 'RELEASE_HEADER_HTML'),
      (v_version.event_version_id, p_table_artifact_id, 'RELEASE_TABLE1_XLSX');
  END IF;

  INSERT INTO public.event_fact_production_operations (
    operation_idempotency_fingerprint, input_fingerprint, observation_id,
    header_artifact_id, table_artifact_id, cluster_id, decision_id,
    identity_claim_id, event_version_id, knowledge_cutoff, version_outcome
  ) VALUES (
    p_operation_idempotency_fingerprint, v_input_fingerprint, p_observation_id,
    p_header_artifact_id, p_table_artifact_id, v_target_cluster_id,
    v_membership.decision_id, v_identity_claim_id,
    v_version.event_version_id, v_knowledge_cutoff, v_version.outcome
  );

  RETURN QUERY SELECT v_target_cluster_id, v_membership.decision_id,
    v_identity_claim_id, v_version.event_version_id,
    v_version.outcome, false;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_event_fact_artifact_role_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_event_fact_artifact_role_guard() TO service_role;
REVOKE ALL ON FUNCTION public.fn_event_fact_produce_bls_cpi(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_event_fact_produce_bls_cpi(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT
) TO service_role;

COMMENT ON FUNCTION public.fn_event_fact_produce_bls_cpi IS
  'EF-8 atomic persistence of one already-reviewed EF-7 BLS CPI plan. Exact replay returns the committed operation; divergent reuse fails. All nested cluster, membership, identity, Event Version, artifact-link, and operation writes commit together or roll back together. No fetch, parse, schedule, deploy, or CES V2 activation.';
COMMENT ON TABLE public.event_version_official_artifacts IS
  'Immutable exact-artifact evidence attached only to a newly created Event Version; one header and one Table 1 workbook per EF-8 version.';
COMMENT ON TABLE public.event_fact_production_operations IS
  'EF-8 append-only operation ledger. It closes retry ambiguity after commit and records the exact observation/artifact inputs and canonical output identifiers.';

COMMIT;
