-- ALPHA-XAU — security baseline hardening
-- Makes legacy public views obey the querying role's RLS policies and freezes
-- the name-resolution path of the five functions reported by the advisor.
-- This migration is independent of Event Facts 0029-0032.

BEGIN;

ALTER VIEW public.v_news_high_impact
  SET (security_invoker = true);
ALTER VIEW public.v_news_actionable
  SET (security_invoker = true);
ALTER VIEW public.v_news_pending_notification
  SET (security_invoker = true);
ALTER VIEW public.v_engine_last_run
  SET (security_invoker = true);
ALTER VIEW public.v_ai_latest
  SET (security_invoker = true);
ALTER VIEW public.v_market_latest
  SET (security_invoker = true);

ALTER FUNCTION public.fn_set_updated_at()
  SET search_path = '';

ALTER FUNCTION public.fn_news_score(numeric, numeric, numeric, numeric, numeric)
  SET search_path = '';

ALTER FUNCTION public.fn_news_articles_append_only()
  SET search_path = '';

CREATE OR REPLACE FUNCTION public.fn_news_classify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_score NUMERIC := public.fn_news_score(
    NEW.macro_score, NEW.volatility_score, NEW.reliability_score,
    NEW.surprise_score, NEW.duration_score
  );
BEGIN
  IF NEW.classification = 'noise' THEN
    NEW.classification := CASE
      WHEN v_score >= 80 THEN 'critical'
      WHEN v_score >= 60 THEN 'major'
      ELSE 'noise'
    END::public.news_class_t;
  END IF;

  NEW.action := CASE
    WHEN v_score >= 80 THEN 'RECALC_H1_H2'
    WHEN v_score >= 60 THEN 'REEVALUATE_H3'
    ELSE 'ARCHIVE_ONLY'
  END::public.news_action_t;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_check_scenario_probability_sum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_analysis    UUID := COALESCE(NEW.analysis_id, OLD.analysis_id);
  v_count       INTEGER;
  v_sum         NUMERIC;
  v_horizon_ct  INTEGER;
BEGIN
  SELECT count(*), COALESCE(sum(s.probability), 0)
    INTO v_count, v_sum
    FROM public.ai_scenarios AS s
   WHERE s.analysis_id = v_analysis;

  SELECT count(*)
    INTO v_horizon_ct
    FROM pg_catalog.pg_enum AS e
   WHERE e.enumtypid = 'public.horizon_t'::pg_catalog.regtype;

  IF v_count = v_horizon_ct AND abs(v_sum - 1) > 0.01 THEN
    RAISE EXCEPTION
      'Distribution invalide pour analysis %: somme des probabilités = % (attendu 1.00 +/- 0.01)',
      v_analysis, v_sum;
  END IF;

  RETURN NULL;
END;
$function$;

COMMIT;
