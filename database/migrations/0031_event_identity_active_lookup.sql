-- EF-6 — exact, read-only active release-identity claim lookup.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_event_lookup_active_identity_claims(
  p_authority_namespace TEXT,
  p_identity_type       TEXT,
  p_identity_value      TEXT
)
RETURNS TABLE (
  cluster_id          UUID,
  identity_claim_id   UUID,
  strong_identity_key TEXT
)
LANGUAGE plpgsql
STABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_strong_identity_key TEXT;
BEGIN
  IF length(btrim(p_authority_namespace)) = 0
     OR length(btrim(p_identity_type)) = 0
     OR length(btrim(p_identity_value)) = 0
  THEN
    RAISE EXCEPTION 'fn_event_lookup_active_identity_claims: identity fields must be non-blank';
  END IF;

  v_strong_identity_key := encode(
    extensions.digest(
      p_authority_namespace || chr(31) || p_identity_type || chr(31) || p_identity_value,
      'sha256'
    ),
    'hex'
  );

  RETURN QUERY
  SELECT claim.cluster_id, claim.identity_claim_id, claim.strong_identity_key
  FROM public.event_cluster_identity_claims AS claim
  WHERE claim.strong_identity_key = v_strong_identity_key
    AND NOT EXISTS (
      SELECT 1
      FROM public.event_cluster_identity_claims AS successor
      WHERE successor.supersedes_claim_id = claim.identity_claim_id
    )
  ORDER BY claim.identity_claim_id
  LIMIT 2;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_event_lookup_active_identity_claims(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_event_lookup_active_identity_claims(TEXT, TEXT, TEXT)
  TO service_role;

COMMENT ON FUNCTION public.fn_event_lookup_active_identity_claims(TEXT, TEXT, TEXT) IS
  'EF-6 exact read-only lookup of active strong-identity claims. Returns 0, 1, or 2 rows (2 means collision); callers must fail closed on more than one.';

COMMIT;
