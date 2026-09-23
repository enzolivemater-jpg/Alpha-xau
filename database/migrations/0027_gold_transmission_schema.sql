-- Gold Transmission V1 persistence foundation (schema only).
-- Model S is semantic/ex-ante. No processor, RPC, runtime, pricing,
-- positioning, magnitude, Committee decision, or production row is added.
BEGIN;

CREATE TABLE public.gold_transmission_assessments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_version_id        UUID NOT NULL
                            REFERENCES public.event_versions (id) ON DELETE RESTRICT,
  model_variant           TEXT NOT NULL DEFAULT 'SEMANTIC'
                            CHECK (model_variant = 'SEMANTIC'),
  assessment_status       TEXT NOT NULL
                            CHECK (assessment_status IN (
                              'ASSESSED', 'INSUFFICIENT_EVIDENCE', 'UNAVAILABLE'
                            )),
  assessment_reason       TEXT,
  knowledge_cutoff        TIMESTAMPTZ NOT NULL,
  producer_type           TEXT NOT NULL
                            CHECK (producer_type IN ('DETERMINISTIC', 'QUANT', 'AI', 'HUMAN')),
  producer_actor          TEXT NOT NULL CHECK (length(btrim(producer_actor)) > 0),
  algorithm_version       TEXT NOT NULL CHECK (length(btrim(algorithm_version)) > 0),
  input_fingerprint       TEXT NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  semantic_fingerprint    TEXT NOT NULL CHECK (semantic_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_fingerprint TEXT NOT NULL CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
  supersedes_assessment_id UUID
                            REFERENCES public.gold_transmission_assessments (id)
                            ON DELETE RESTRICT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_gold_transmission_assessment_reason CHECK (
    (assessment_status = 'ASSESSED' AND assessment_reason IS NULL)
    OR
    (assessment_status IN ('INSUFFICIENT_EVIDENCE', 'UNAVAILABLE')
      AND assessment_reason IS NOT NULL
      AND length(btrim(assessment_reason)) > 0)
  )
);

CREATE UNIQUE INDEX uq_gold_transmission_assessments_idempotency
  ON public.gold_transmission_assessments (idempotency_fingerprint);

CREATE UNIQUE INDEX uq_gold_transmission_assessments_supersedes
  ON public.gold_transmission_assessments (supersedes_assessment_id)
  WHERE supersedes_assessment_id IS NOT NULL;

CREATE INDEX idx_gold_transmission_assessments_event_version_created
  ON public.gold_transmission_assessments (event_version_id, created_at DESC);

COMMENT ON TABLE public.gold_transmission_assessments IS
  'GT-1 — immutable Model S assessment envelope for exactly one Event Version. Append-only; no causal path means an explicit non-ASSESSED status.';

CREATE TABLE public.gold_transmission_paths (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id         UUID NOT NULL
                          REFERENCES public.gold_transmission_assessments (id)
                          ON DELETE RESTRICT,
  path_key              TEXT NOT NULL CHECK (length(btrim(path_key)) > 0),
  transmission_channel  TEXT NOT NULL
                          CHECK (transmission_channel IN (
                            'NOMINAL_YIELDS',
                            'REAL_YIELDS',
                            'USD',
                            'MONETARY_POLICY_EXPECTATIONS',
                            'INFLATION_EXPECTATIONS',
                            'RISK_OFF_SAFE_HAVEN',
                            'LIQUIDITY',
                            'GEOPOLITICAL_RISK',
                            'POSITIONING_CROWDING',
                            'PHYSICAL_ETF_STRUCTURAL_DEMAND',
                            'VOLATILITY'
                          )),
  market_variable       TEXT NOT NULL
                          CHECK (market_variable IN (
                            'NOMINAL_YIELD',
                            'REAL_YIELD',
                            'USD',
                            'POLICY_RATE_EXPECTATIONS',
                            'INFLATION_EXPECTATIONS',
                            'SAFE_HAVEN_DEMAND',
                            'LIQUIDITY',
                            'GEOPOLITICAL_RISK',
                            'POSITIONING',
                            'PHYSICAL_DEMAND',
                            'ETF_DEMAND',
                            'VOLATILITY'
                          )),
  variable_effect       TEXT NOT NULL
                          CHECK (variable_effect IN ('UP', 'DOWN', 'FLAT', 'UNKNOWN')),
  gold_effect           TEXT NOT NULL
                          CHECK (gold_effect IN ('BULLISH', 'BEARISH', 'NEUTRAL', 'UNKNOWN')),
  confidence_state      TEXT NOT NULL
                          CHECK (confidence_state IN ('UNASSESSED', 'UNKNOWN', 'ESTIMATED')),
  confidence_value      NUMERIC(5,4),
  rationale             TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_gold_transmission_paths_identity
    UNIQUE (assessment_id, path_key),
  CONSTRAINT chk_gold_transmission_paths_confidence CHECK (
    (confidence_state = 'ESTIMATED'
      AND confidence_value IS NOT NULL
      AND confidence_value BETWEEN 0 AND 1)
    OR
    (confidence_state IN ('UNASSESSED', 'UNKNOWN')
      AND confidence_value IS NULL)
  )
);

COMMENT ON TABLE public.gold_transmission_paths IS
  'GT-1 — machine-readable EVENT -> TRANSMISSION CHANNEL -> MARKET VARIABLE -> GOLD EFFECT paths. No horizon, pricing, positioning inference, magnitude, or final trade decision.';
COMMENT ON COLUMN public.gold_transmission_paths.gold_effect IS
  'BULLISH, BEARISH, NEUTRAL, or UNKNOWN. NEUTRAL is a conclusion; UNKNOWN is insufficient causal direction.';

CREATE TABLE public.gold_transmission_driver_evidence (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path_id            UUID NOT NULL
                       REFERENCES public.gold_transmission_paths (id)
                       ON DELETE RESTRICT,
  market_tick_id     UUID NOT NULL,
  market_tick_ts     TIMESTAMPTZ NOT NULL,
  evidence_role      TEXT NOT NULL
                       CHECK (evidence_role IN ('PRIMARY', 'SUPPORTING', 'CONTRADICTING')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_gold_transmission_driver_evidence_tick
    FOREIGN KEY (market_tick_id, market_tick_ts)
    REFERENCES public.market_ticks (id, ts)
    ON DELETE RESTRICT,
  CONSTRAINT uq_gold_transmission_driver_evidence_identity
    UNIQUE (path_id, market_tick_id, market_tick_ts, evidence_role)
);

CREATE INDEX idx_gold_transmission_driver_evidence_tick
  ON public.gold_transmission_driver_evidence (market_tick_id, market_tick_ts);

COMMENT ON TABLE public.gold_transmission_driver_evidence IS
  'GT-1 — exact native market-driver observations supporting or contradicting one causal path. XAUUSD macro stamps are never authoritative evidence.';

CREATE OR REPLACE FUNCTION public.fn_gold_transmission_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only (Gold Transmission): % forbidden; insert a new assessment instead.',
    TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_gold_transmission_validate_assessment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_event_cutoff       TIMESTAMPTZ;
  v_previous           public.gold_transmission_assessments%ROWTYPE;
BEGIN
  SELECT ev.knowledge_cutoff
    INTO v_event_cutoff
    FROM public.event_versions AS ev
   WHERE ev.id = NEW.event_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown event_version_id %', NEW.event_version_id;
  END IF;

  IF NEW.knowledge_cutoff < v_event_cutoff THEN
    RAISE EXCEPTION 'Gold Transmission knowledge_cutoff cannot precede Event Version knowledge_cutoff';
  END IF;
  IF NEW.knowledge_cutoff > pg_catalog.transaction_timestamp() THEN
    RAISE EXCEPTION 'Gold Transmission knowledge_cutoff cannot be in the future';
  END IF;

  IF NEW.supersedes_assessment_id IS NOT NULL THEN
    SELECT gta.*
      INTO v_previous
      FROM public.gold_transmission_assessments AS gta
     WHERE gta.id = NEW.supersedes_assessment_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown supersedes_assessment_id %', NEW.supersedes_assessment_id;
    END IF;
    IF v_previous.event_version_id IS DISTINCT FROM NEW.event_version_id
       OR v_previous.model_variant IS DISTINCT FROM NEW.model_variant THEN
      RAISE EXCEPTION 'superseded assessment must share event_version_id and model_variant';
    END IF;
    IF NEW.knowledge_cutoff < v_previous.knowledge_cutoff THEN
      RAISE EXCEPTION 'Gold Transmission knowledge_cutoff cannot regress';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_gold_transmission_validate_path()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT gta.assessment_status
    INTO v_status
    FROM public.gold_transmission_assessments AS gta
   WHERE gta.id = NEW.assessment_id;

  IF v_status IS DISTINCT FROM 'ASSESSED' THEN
    RAISE EXCEPTION 'Gold Transmission paths require an ASSESSED parent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_gold_transmission_validate_driver_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_cutoff          TIMESTAMPTZ;
  v_symbol          TEXT;
  v_tick_created_at TIMESTAMPTZ;
BEGIN
  SELECT gta.knowledge_cutoff
    INTO v_cutoff
    FROM public.gold_transmission_paths AS gtp
    JOIN public.gold_transmission_assessments AS gta ON gta.id = gtp.assessment_id
   WHERE gtp.id = NEW.path_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown Gold Transmission path_id %', NEW.path_id;
  END IF;

  SELECT mt.symbol, mt.created_at
    INTO v_symbol, v_tick_created_at
    FROM public.market_ticks AS mt
   WHERE mt.id = NEW.market_tick_id
     AND mt.ts = NEW.market_tick_ts;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown market driver observation (%, %)', NEW.market_tick_id, NEW.market_tick_ts;
  END IF;
  IF v_symbol NOT IN ('DXY', 'US10Y', 'US10YR', 'VIX', 'WTI') THEN
    RAISE EXCEPTION 'symbol % is not canonical Gold Transmission driver evidence', v_symbol;
  END IF;
  IF NEW.market_tick_ts > v_cutoff OR v_tick_created_at > v_cutoff THEN
    RAISE EXCEPTION 'market driver evidence must have both observation and ingestion at or before assessment knowledge_cutoff';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_gold_transmission_assert_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.assessment_status = 'ASSESSED'
     AND NOT EXISTS (
       SELECT 1
         FROM public.gold_transmission_paths AS gtp
        WHERE gtp.assessment_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'ASSESSED Gold Transmission assessment requires at least one causal path';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_gold_transmission_assessments_validate
  BEFORE INSERT ON public.gold_transmission_assessments
  FOR EACH ROW EXECUTE FUNCTION public.fn_gold_transmission_validate_assessment();

CREATE CONSTRAINT TRIGGER trg_gold_transmission_assessments_complete
  AFTER INSERT ON public.gold_transmission_assessments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_gold_transmission_assert_complete();

CREATE TRIGGER trg_gold_transmission_paths_validate
  BEFORE INSERT ON public.gold_transmission_paths
  FOR EACH ROW EXECUTE FUNCTION public.fn_gold_transmission_validate_path();

CREATE TRIGGER trg_gold_transmission_driver_evidence_validate
  BEFORE INSERT ON public.gold_transmission_driver_evidence
  FOR EACH ROW EXECUTE FUNCTION public.fn_gold_transmission_validate_driver_evidence();

CREATE TRIGGER trg_gold_transmission_assessments_append_only
  BEFORE UPDATE OR DELETE ON public.gold_transmission_assessments
  FOR EACH ROW EXECUTE FUNCTION public.fn_gold_transmission_append_only();

CREATE TRIGGER trg_gold_transmission_paths_append_only
  BEFORE UPDATE OR DELETE ON public.gold_transmission_paths
  FOR EACH ROW EXECUTE FUNCTION public.fn_gold_transmission_append_only();

CREATE TRIGGER trg_gold_transmission_driver_evidence_append_only
  BEFORE UPDATE OR DELETE ON public.gold_transmission_driver_evidence
  FOR EACH ROW EXECUTE FUNCTION public.fn_gold_transmission_append_only();

ALTER TABLE public.gold_transmission_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gold_transmission_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gold_transmission_driver_evidence ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.gold_transmission_assessments FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.gold_transmission_paths FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.gold_transmission_driver_evidence FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT ON TABLE public.gold_transmission_assessments TO service_role;
GRANT SELECT, INSERT ON TABLE public.gold_transmission_paths TO service_role;
GRANT SELECT, INSERT ON TABLE public.gold_transmission_driver_evidence TO service_role;

REVOKE ALL ON FUNCTION public.fn_gold_transmission_append_only() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_gold_transmission_validate_assessment() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_gold_transmission_validate_path() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_gold_transmission_validate_driver_evidence() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_gold_transmission_assert_complete() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_gold_transmission_append_only() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gold_transmission_validate_assessment() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gold_transmission_validate_path() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gold_transmission_validate_driver_evidence() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gold_transmission_assert_complete() TO service_role;

COMMIT;
