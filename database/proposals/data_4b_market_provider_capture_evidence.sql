-- DATA-4B — OFFLINE DRAFT ONLY. Never apply to main or production.
-- Isolated PostgreSQL CI validates a proposal for retention of provider bytes
-- and *every* declared attempt, including failed/timeout/quota attempts.
-- Neither successful SQL persistence nor a digest proves source authenticity,
-- declared schedule exhaustiveness, market coverage or trading readiness.
BEGIN;

CREATE TABLE public.market_provider_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('fred', 'twelve_data')),
  source_record_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  body_bytes BYTEA NOT NULL CHECK (octet_length(body_bytes) BETWEEN 1 AND 2097152),
  content_sha256 TEXT GENERATED ALWAYS AS (
    encode(extensions.digest(body_bytes, 'sha256'), 'hex')
  ) STORED,
  -- The collector reports receipt time; it is NOT the authoritative database
  -- first-knowledge timestamp. Never reconstruct a publication time from it.
  source_received_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT chk_market_provider_series CHECK (
    (provider='fred' AND (
      (source_record_id='DGS10' AND symbol='US10Y') OR
      (source_record_id='DFII10' AND symbol='US10YR') OR
      (source_record_id='VIXCLS' AND symbol='VIX') OR
      (source_record_id='DCOILWTICO' AND symbol='WTI')
    ))
    OR (provider='twelve_data' AND source_record_id='XAU/USD' AND symbol='XAUUSD')
  ),
  CONSTRAINT chk_market_provider_received_before_recorded
    CHECK (source_received_at <= recorded_at),
  CONSTRAINT uq_market_provider_response_identity
    UNIQUE (provider, source_record_id, symbol, content_sha256),
  CONSTRAINT uq_market_provider_response_fk
    UNIQUE (id, provider, source_record_id, symbol)
);

CREATE TABLE public.market_capture_attempt_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id TEXT NOT NULL CHECK (plan_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  slot_id TEXT NOT NULL CHECK (slot_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  provider TEXT NOT NULL CHECK (provider IN ('fred','twelve_data')),
  source_record_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('CAPTURED','FAILED')),
  response_id UUID,
  failure_code TEXT CHECK (failure_code IN (
    'HTTP_ERROR','TIMEOUT','QUOTA','TRANSPORT_ERROR','PARSE_REJECTED','OTHER'
  )),
  source_received_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT chk_market_receipt_outcome CHECK (
    (outcome='CAPTURED' AND response_id IS NOT NULL AND failure_code IS NULL)
    OR
    (outcome='FAILED' AND response_id IS NULL AND failure_code IS NOT NULL)
  ),
  CONSTRAINT chk_market_receipt_received_before_recorded
    CHECK (source_received_at <= recorded_at),
  CONSTRAINT uq_market_receipt_slot UNIQUE (plan_id, slot_id),
  CONSTRAINT fk_market_receipt_response_same_source FOREIGN KEY
    (response_id, provider, source_record_id, symbol)
    REFERENCES public.market_provider_responses (id, provider, source_record_id, symbol)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_market_capture_receipts_as_of
  ON public.market_capture_attempt_receipts (plan_id, recorded_at, slot_id);
CREATE INDEX idx_market_capture_receipts_response
  ON public.market_capture_attempt_receipts (response_id)
  WHERE response_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_market_capture_proof_append_only()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'market capture evidence is append-only: % forbidden', TG_OP;
END;
$$;

CREATE TRIGGER trg_market_provider_responses_append_only
  BEFORE UPDATE OR DELETE ON public.market_provider_responses
  FOR EACH ROW EXECUTE FUNCTION public.fn_market_capture_proof_append_only();
CREATE TRIGGER trg_market_capture_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.market_capture_attempt_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_market_capture_proof_append_only();

-- The caller supplies only source/slot/outcome and (for CAPTURED) raw bytes.
-- A single transaction adds payload + receipt or nothing; a repeated slot is
-- idempotent only for identical claims and bytes. Errors must not echo bodies.
CREATE OR REPLACE FUNCTION public.fn_market_capture_record_attempt(
  p_plan_id TEXT,
  p_slot_id TEXT,
  p_provider TEXT,
  p_source_record_id TEXT,
  p_symbol TEXT,
  p_outcome TEXT,
  p_source_received_at TIMESTAMPTZ,
  p_body_bytes BYTEA,
  p_failure_code TEXT
)
RETURNS TABLE (
  receipt_id UUID, write_outcome TEXT, recorded_at TIMESTAMPTZ,
  content_sha256 TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_existing public.market_capture_attempt_receipts%ROWTYPE;
  v_response_id UUID;
  v_digest TEXT;
  v_now TIMESTAMPTZ := statement_timestamp();
  v_receipt public.market_capture_attempt_receipts%ROWTYPE;
BEGIN
  IF p_plan_id IS NULL OR p_slot_id IS NULL OR
      p_provider IS NULL OR p_source_record_id IS NULL OR p_symbol IS NULL OR
      p_source_received_at IS NULL OR NOT isfinite(p_source_received_at) OR
      p_source_received_at > v_now THEN
    RAISE EXCEPTION 'invalid market capture identity or future receipt time'
      USING ERRCODE='22023';
  END IF;
  IF NOT (
      (p_outcome='CAPTURED' AND p_body_bytes IS NOT NULL AND p_failure_code IS NULL)
      OR
      (p_outcome='FAILED' AND p_body_bytes IS NULL AND p_failure_code IS NOT NULL)
    ) THEN
    RAISE EXCEPTION 'market capture outcome does not match its evidence'
      USING ERRCODE='22023';
  END IF;
  IF p_body_bytes IS NOT NULL THEN
    IF octet_length(p_body_bytes) < 1 OR octet_length(p_body_bytes) > 2097152 THEN
      RAISE EXCEPTION 'provider body size outside cap'
        USING ERRCODE='22023';
    END IF;
    v_digest := encode(extensions.digest(p_body_bytes,'sha256'),'hex');
  END IF;

  SELECT * INTO v_existing FROM public.market_capture_attempt_receipts a
    WHERE a.plan_id=p_plan_id AND a.slot_id=p_slot_id;
  IF FOUND THEN
    IF v_existing.provider <> p_provider OR
        v_existing.source_record_id <> p_source_record_id OR
        v_existing.symbol <> p_symbol OR v_existing.outcome <> p_outcome OR
        v_existing.source_received_at <> p_source_received_at OR
        v_existing.failure_code IS DISTINCT FROM p_failure_code OR
        (p_outcome='CAPTURED' AND NOT EXISTS (
          SELECT 1 FROM public.market_provider_responses r
          WHERE r.id=v_existing.response_id AND r.content_sha256=v_digest
            AND r.body_bytes=p_body_bytes
        )) THEN
      RAISE EXCEPTION 'market capture slot reused with divergent evidence'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, 'REPLAYED'::TEXT, v_existing.recorded_at, v_digest;
    RETURN;
  END IF;

  IF p_outcome='CAPTURED' THEN
    INSERT INTO public.market_provider_responses
      (provider,source_record_id,symbol,body_bytes,source_received_at)
    VALUES (p_provider,p_source_record_id,p_symbol,p_body_bytes,p_source_received_at)
    ON CONFLICT ON CONSTRAINT uq_market_provider_response_identity DO NOTHING
    RETURNING id INTO v_response_id;

    IF v_response_id IS NULL THEN
      SELECT id INTO v_response_id FROM public.market_provider_responses r
      WHERE r.provider=p_provider AND r.source_record_id=p_source_record_id
        AND r.symbol=p_symbol AND r.content_sha256=v_digest AND r.body_bytes=p_body_bytes;
      IF v_response_id IS NULL THEN
        RAISE EXCEPTION 'provider body hash identity collision'
          USING ERRCODE='23505';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.market_capture_attempt_receipts
    (plan_id,slot_id,provider,source_record_id,symbol,outcome,
     response_id,failure_code,source_received_at)
  VALUES
    (p_plan_id,p_slot_id,p_provider,p_source_record_id,p_symbol,p_outcome,
     v_response_id,p_failure_code,p_source_received_at)
  ON CONFLICT ON CONSTRAINT uq_market_receipt_slot DO NOTHING
  RETURNING * INTO v_receipt;

  IF NOT FOUND THEN
    -- Another transaction wrote the slot concurrently. Abort rather than
    -- accidentally accepting a possibly divergent identity; retry safely.
    RAISE EXCEPTION 'market capture concurrent slot conflict; retry'
      USING ERRCODE='40001';
  END IF;
  RETURN QUERY SELECT v_receipt.id, 'PERSISTED'::TEXT, v_receipt.recorded_at, v_digest;
END;
$$;

-- Read of receipts is complete-or-error, never silently truncated, and uses
-- the database first-knowledge timestamp rather than an operator clock.
CREATE OR REPLACE FUNCTION public.fn_market_capture_receipts_as_of(
  p_plan_id TEXT, p_cutoff TIMESTAMPTZ, p_max_rows INTEGER DEFAULT 2048
)
RETURNS TABLE (
  plan_id TEXT, slot_id TEXT, provider TEXT, source_record_id TEXT, symbol TEXT,
  outcome TEXT, source_received_at TIMESTAMPTZ, recorded_at TIMESTAMPTZ,
  failure_code TEXT, content_sha256 TEXT
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  IF p_plan_id IS NULL OR p_plan_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}
    p_max_rows IS NULL OR p_max_rows NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid market receipt cutoff or bound' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO v_count FROM public.market_capture_attempt_receipts a
    WHERE a.plan_id=p_plan_id AND a.recorded_at <= p_cutoff;
  IF v_count > p_max_rows THEN
    RAISE EXCEPTION 'market receipt history exceeds explicit bound (% > %)',
      v_count, p_max_rows USING ERRCODE='54000';
  END IF;
  RETURN QUERY SELECT a.plan_id,a.slot_id,a.provider,a.source_record_id,
    a.symbol,a.outcome,a.source_received_at,a.recorded_at,a.failure_code,
    r.content_sha256
    FROM public.market_capture_attempt_receipts a
    LEFT JOIN public.market_provider_responses r ON r.id=a.response_id
    WHERE a.plan_id=p_plan_id AND a.recorded_at <= p_cutoff
    ORDER BY a.recorded_at,a.slot_id;
END;
$$;

ALTER TABLE public.market_provider_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_capture_attempt_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_provider_responses FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.market_capture_attempt_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT (provider,source_record_id,symbol,body_bytes,source_received_at)
  ON public.market_provider_responses TO service_role;
GRANT SELECT, INSERT
  (plan_id,slot_id,provider,source_record_id,symbol,outcome,response_id,failure_code,source_received_at)
  ON public.market_capture_attempt_receipts TO service_role;

REVOKE ALL ON FUNCTION public.fn_market_capture_proof_append_only()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_market_capture_record_attempt(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,BYTEA,TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_market_capture_receipts_as_of(
  TEXT,TIMESTAMPTZ,INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_market_capture_record_attempt(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,BYTEA,TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_market_capture_receipts_as_of(
  TEXT,TIMESTAMPTZ,INTEGER
) TO service_role;

COMMENT ON TABLE public.market_provider_responses IS
  'DATA-4B NOT DEPLOYED: raw exact bytes, dedup per provider series, no claim of provider authentication.';
COMMENT ON TABLE public.market_capture_attempt_receipts IS
  'DATA-4B NOT DEPLOYED: explicit attempt receipts; an attempt ledger is not proof of a complete scheduler or market coverage.';
COMMENT ON COLUMN public.market_capture_attempt_receipts.recorded_at IS
  'Database first-knowledge time for as-of; not the supplier publication time or client-reported receipt time.';
COMMIT;
 OR
    p_cutoff IS NULL OR NOT isfinite(p_cutoff) OR
    p_max_rows IS NULL OR p_max_rows NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid market receipt cutoff or bound' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO v_count FROM public.market_capture_attempt_receipts a
    WHERE a.recorded_at <= p_cutoff;
  IF v_count > p_max_rows THEN
    RAISE EXCEPTION 'market receipt history exceeds explicit bound (% > %)',
      v_count, p_max_rows USING ERRCODE='54000';
  END IF;
  RETURN QUERY SELECT a.plan_id,a.slot_id,a.provider,a.source_record_id,
    a.symbol,a.outcome,a.source_received_at,a.recorded_at,a.failure_code,
    r.content_sha256
    FROM public.market_capture_attempt_receipts a
    LEFT JOIN public.market_provider_responses r ON r.id=a.response_id
    WHERE a.recorded_at <= p_cutoff
    ORDER BY a.recorded_at,a.plan_id,a.slot_id;
END;
$$;

ALTER TABLE public.market_provider_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_capture_attempt_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_provider_responses FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.market_capture_attempt_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT (provider,source_record_id,symbol,body_bytes,source_received_at)
  ON public.market_provider_responses TO service_role;
GRANT SELECT, INSERT
  (plan_id,slot_id,provider,source_record_id,symbol,outcome,response_id,failure_code,source_received_at)
  ON public.market_capture_attempt_receipts TO service_role;

REVOKE ALL ON FUNCTION public.fn_market_capture_proof_append_only()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_market_capture_record_attempt(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,BYTEA,TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_market_capture_receipts_as_of(
  TIMESTAMPTZ,INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_market_capture_record_attempt(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,BYTEA,TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_market_capture_receipts_as_of(
  TIMESTAMPTZ,INTEGER
) TO service_role;

COMMENT ON TABLE public.market_provider_responses IS
  'DATA-4B NOT DEPLOYED: raw exact bytes, dedup per provider series, no claim of provider authentication.';
COMMENT ON TABLE public.market_capture_attempt_receipts IS
  'DATA-4B NOT DEPLOYED: explicit attempt receipts; an attempt ledger is not proof of a complete scheduler or market coverage.';
COMMENT ON COLUMN public.market_capture_attempt_receipts.recorded_at IS
  'Database first-knowledge time for as-of; not the supplier publication time or client-reported receipt time.';
COMMIT;
