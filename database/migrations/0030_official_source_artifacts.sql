-- EF-5A — immutable, non-canonical retention for official source artifacts.
--
-- This table retains the exact bytes observed by an official-source collector.
-- It deliberately stores no parsed projection, release identity, CES facts, or
-- activation state. Parsing remains a deterministic, replayable derivation.
BEGIN;

CREATE TABLE IF NOT EXISTS public.official_source_artifacts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingest_run_id         UUID NOT NULL
                          REFERENCES public.ingestion_runs (id) ON DELETE RESTRICT,
  authority             TEXT NOT NULL
                          CHECK (authority = btrim(authority) AND authority ~ '^[A-Z][A-Z0-9_]*$'),
  provider              TEXT NOT NULL
                          CHECK (provider = lower(btrim(provider)) AND provider ~ '^[a-z][a-z0-9_]*$'),
  source_code           TEXT NOT NULL
                          REFERENCES public.data_sources (code)
                          ON UPDATE CASCADE ON DELETE RESTRICT,
  source_domain         TEXT NOT NULL
                          CHECK (source_domain = lower(btrim(source_domain))
                                 AND source_domain ~ '^[a-z0-9.-]+$'),
  canonical_url         TEXT NOT NULL
                          CHECK (canonical_url = btrim(canonical_url)
                                 AND canonical_url ~ '^https://'),
  artifact_role         TEXT NOT NULL
                          CHECK (artifact_role IN ('RELEASE_HEADER_HTML', 'RELEASE_TABLE1_XLSX')),
  media_type            TEXT NOT NULL
                          CHECK (
                            (artifact_role = 'RELEASE_HEADER_HTML' AND media_type = 'text/html')
                            OR
                            (artifact_role = 'RELEASE_TABLE1_XLSX'
                             AND media_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                          ),
  content_bytes         BYTEA NOT NULL
                          CHECK (octet_length(content_bytes) BETWEEN 1 AND 10485760),
  content_sha256        TEXT GENERATED ALWAYS AS (
                          encode(extensions.digest(content_bytes, 'sha256'), 'hex')
                        ) STORED,
  observed_at           TIMESTAMPTZ NOT NULL,
  ingested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  observation_hash      TEXT GENERATED ALWAYS AS (
                          encode(
                            extensions.digest(
                              extensions.digest(
                                authority || chr(31) || provider || chr(31)
                                || source_code || chr(31) || source_domain || chr(31)
                                || canonical_url || chr(31) || artifact_role || chr(31)
                                || media_type || chr(31),
                                'sha256'
                              ) || extensions.digest(content_bytes, 'sha256'),
                              'sha256'
                            ),
                            'hex'
                          )
                        ) STORED,
  CONSTRAINT chk_official_source_artifacts_bls_cpi_scope CHECK (
    authority = 'US_BLS'
    AND provider = 'bls'
    AND source_code = 'bls_cpi_release'
    AND source_domain = 'bls.gov'
    AND canonical_url ~ '^https://(www\.)?bls\.gov/'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_official_source_artifacts_observation_hash
  ON public.official_source_artifacts (observation_hash);
CREATE INDEX IF NOT EXISTS idx_official_source_artifacts_run
  ON public.official_source_artifacts (ingest_run_id);
CREATE INDEX IF NOT EXISTS idx_official_source_artifacts_source_observed
  ON public.official_source_artifacts (source_code, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_official_source_artifacts_content_sha256
  ON public.official_source_artifacts (content_sha256);

CREATE OR REPLACE FUNCTION public.fn_official_source_artifacts_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    'official_source_artifacts is append-only: % is forbidden; retain corrected bytes as a new observation',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_official_source_artifacts_append_only
  ON public.official_source_artifacts;
CREATE TRIGGER trg_official_source_artifacts_append_only
  BEFORE UPDATE OR DELETE ON public.official_source_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.fn_official_source_artifacts_append_only();

ALTER TABLE public.official_source_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.official_source_artifacts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.official_source_artifacts TO service_role;

REVOKE ALL ON FUNCTION public.fn_official_source_artifacts_append_only()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_official_source_artifacts_append_only()
  TO service_role;

COMMENT ON TABLE public.official_source_artifacts IS
  'EF-5A immutable exact-byte evidence outside CES. Rows are non-canonical replay inputs, not parsed facts or release identity claims.';
COMMENT ON COLUMN public.official_source_artifacts.content_bytes IS
  'Exact response-body bytes as observed; never decoded, normalized, repaired, or rewritten.';
COMMENT ON COLUMN public.official_source_artifacts.observation_hash IS
  'Idempotency hash over source metadata and exact bytes. Collector time is excluded so exact re-polls collapse; changed bytes are retained.';

COMMIT;
