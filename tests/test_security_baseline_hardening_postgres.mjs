// PostgreSQL 17 behavioral proof for SB-1 in a disposable database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_security_baseline_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
const sql = query => execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
const rejects = (query, pattern) => assert.throws(() => sql(query), pattern);

assert.equal(sql('SHOW server_version_num;').slice(0, 2), '17');
sql(`
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  DROP ROLE IF EXISTS anon;
  DROP ROLE IF EXISTS authenticated;
  DROP ROLE IF EXISTS service_role;
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;

  CREATE TABLE public.guard_rows (id integer PRIMARY KEY);
  INSERT INTO public.guard_rows VALUES (1);
  ALTER TABLE public.guard_rows ENABLE ROW LEVEL SECURITY;
  CREATE POLICY guard_anon ON public.guard_rows FOR SELECT TO anon USING (false);
  CREATE POLICY guard_authenticated ON public.guard_rows FOR SELECT TO authenticated USING (true);
  GRANT USAGE ON SCHEMA public TO anon, authenticated;
  GRANT SELECT ON public.guard_rows TO anon, authenticated;

  CREATE VIEW public.v_news_high_impact AS SELECT id FROM public.guard_rows;
  CREATE VIEW public.v_news_actionable AS SELECT id FROM public.guard_rows;
  CREATE VIEW public.v_news_pending_notification AS SELECT id FROM public.guard_rows;
  CREATE VIEW public.v_engine_last_run AS SELECT id FROM public.guard_rows;
  CREATE VIEW public.v_ai_latest AS SELECT id FROM public.guard_rows;
  CREATE VIEW public.v_market_latest AS SELECT id FROM public.guard_rows;
  GRANT SELECT ON public.v_news_high_impact, public.v_news_actionable,
    public.v_news_pending_notification, public.v_engine_last_run,
    public.v_ai_latest, public.v_market_latest TO anon, authenticated;

  CREATE TYPE public.news_class_t AS ENUM ('noise','major','critical');
  CREATE TYPE public.news_action_t AS ENUM ('ARCHIVE_ONLY','REEVALUATE_H3','RECALC_H1_H2');
  CREATE TYPE public.horizon_t AS ENUM ('H1','H2','H3','H4','H5');

  CREATE FUNCTION public.fn_news_score(numeric,numeric,numeric,numeric,numeric)
  RETURNS numeric LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT round($1*0.30 + $2*0.20 + $3*0.15 + $4*0.20 + $5*0.15, 2)
  $$;
  CREATE TABLE public.news_events (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    macro_score numeric NOT NULL, volatility_score numeric NOT NULL,
    reliability_score numeric NOT NULL, surprise_score numeric NOT NULL,
    duration_score numeric NOT NULL,
    classification public.news_class_t NOT NULL DEFAULT 'noise',
    action public.news_action_t NOT NULL DEFAULT 'ARCHIVE_ONLY'
  );
  CREATE FUNCTION public.fn_news_classify() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_score numeric := fn_news_score(NEW.macro_score,NEW.volatility_score,
    NEW.reliability_score,NEW.surprise_score,NEW.duration_score);
  BEGIN
    IF NEW.classification='noise' THEN NEW.classification := CASE
      WHEN v_score>=80 THEN 'critical' WHEN v_score>=60 THEN 'major' ELSE 'noise' END::news_class_t;
    END IF;
    NEW.action := CASE WHEN v_score>=80 THEN 'RECALC_H1_H2'
      WHEN v_score>=60 THEN 'REEVALUATE_H3' ELSE 'ARCHIVE_ONLY' END::news_action_t;
    RETURN NEW;
  END $$;
  CREATE TRIGGER classify BEFORE INSERT ON public.news_events
    FOR EACH ROW EXECUTE FUNCTION public.fn_news_classify();

  CREATE TABLE public.ai_scenarios (
    analysis_id uuid NOT NULL, horizon public.horizon_t NOT NULL,
    probability numeric NOT NULL, UNIQUE(analysis_id,horizon)
  );
  CREATE FUNCTION public.fn_check_scenario_probability_sum() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_analysis uuid := coalesce(NEW.analysis_id,OLD.analysis_id); v_count integer; v_sum numeric; v_horizon_ct integer;
  BEGIN
    SELECT count(*),coalesce(sum(probability),0) INTO v_count,v_sum FROM ai_scenarios WHERE analysis_id=v_analysis;
    SELECT count(*) INTO v_horizon_ct FROM pg_enum WHERE enumtypid='horizon_t'::regtype;
    IF v_count=v_horizon_ct AND abs(v_sum-1)>0.01 THEN RAISE EXCEPTION 'invalid distribution'; END IF;
    RETURN NULL;
  END $$;
  CREATE CONSTRAINT TRIGGER probability_sum AFTER INSERT OR UPDATE OR DELETE ON public.ai_scenarios
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_check_scenario_probability_sum();

  CREATE TABLE public.audit_updates (id integer PRIMARY KEY, updated_at timestamptz NOT NULL);
  CREATE FUNCTION public.fn_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at:=now(); RETURN NEW; END $$;
  CREATE TRIGGER set_updated BEFORE UPDATE ON public.audit_updates
    FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

  CREATE TABLE public.news_articles (id integer PRIMARY KEY, payload text);
  CREATE FUNCTION public.fn_news_articles_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'append-only'; END $$;
  CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.news_articles
    FOR EACH ROW EXECUTE FUNCTION public.fn_news_articles_append_only();

  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
`);

const viewAclBefore = sql(`SELECT string_agg(relname||':'||coalesce(relacl::text,''), E'\\n' ORDER BY relname)
  FROM pg_class WHERE relname IN ('v_news_high_impact','v_news_actionable','v_news_pending_notification','v_engine_last_run','v_ai_latest','v_market_latest');`);
const functionAclBefore = sql(`SELECT string_agg(proname||':'||coalesce(proacl::text,''), E'\\n' ORDER BY proname)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND proname IN ('fn_set_updated_at','fn_news_classify','fn_check_scenario_probability_sum','fn_news_score','fn_news_articles_append_only');`);

sql(readFileSync(new URL('database/migrations/0033_security_baseline_hardening.sql', root), 'utf8'));

assert.equal(sql(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname LIKE 'v_%' AND 'security_invoker=true'=ANY(c.reloptions);`), '6');
assert.equal(sql(`SET ROLE anon; SELECT count(*) FROM public.v_market_latest;`), '0');
assert.equal(sql(`SET ROLE authenticated; SELECT count(*) FROM public.v_market_latest;`), '1');
console.log('PASS six views use invoker security and enforce caller RLS');

assert.equal(sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('fn_set_updated_at','fn_news_classify',
    'fn_check_scenario_probability_sum','fn_news_score','fn_news_articles_append_only')
  AND p.proconfig=ARRAY['search_path=""'];`), '5');
assert.equal(sql('SELECT public.fn_news_score(100,100,100,100,100);'), '100.00');
assert.equal(sql(`INSERT INTO public.news_events(macro_score,volatility_score,reliability_score,surprise_score,duration_score)
  VALUES(100,100,100,100,100) RETURNING classification||'|'||action;`), 'critical|RECALC_H1_H2');
console.log('PASS five fixed paths preserve scoring and classification behavior');

const validId='00000000-0000-4000-8000-000000000001';
const invalidId='00000000-0000-4000-8000-000000000002';
const values=id=>['H1','H2','H3','H4','H5'].map(h=>`('${id}','${h}',0.2)`).join(',');
sql(`INSERT INTO public.ai_scenarios VALUES ${values(validId)};`);
rejects(`INSERT INTO public.ai_scenarios VALUES ${values(invalidId).replaceAll('0.2','0.1')};`, /Distribution invalide/);
sql(`INSERT INTO public.audit_updates VALUES(1,'2000-01-01'); UPDATE public.audit_updates SET id=1 WHERE id=1;`);
assert.notEqual(sql(`SELECT updated_at::date FROM public.audit_updates WHERE id=1;`), '2000-01-01');
sql(`INSERT INTO public.news_articles VALUES(1,'original');`);
rejects(`UPDATE public.news_articles SET payload='changed' WHERE id=1;`, /append-only/);
console.log('PASS deferred probability, updated-at, and append-only triggers retain behavior');

assert.equal(sql(`SELECT string_agg(relname||':'||coalesce(relacl::text,''), E'\\n' ORDER BY relname)
  FROM pg_class WHERE relname IN ('v_news_high_impact','v_news_actionable','v_news_pending_notification','v_engine_last_run','v_ai_latest','v_market_latest');`), viewAclBefore);
assert.equal(sql(`SELECT string_agg(proname||':'||coalesce(proacl::text,''), E'\\n' ORDER BY proname)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND proname IN ('fn_set_updated_at','fn_news_classify','fn_check_scenario_probability_sum','fn_news_score','fn_news_articles_append_only');`), functionAclBefore);
console.log('PASS view and function ACLs are unchanged');
