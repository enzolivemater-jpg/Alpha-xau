// PostgreSQL 17.6 contract for migration 0027 in an empty disposable database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_gold_transmission_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR,
  'connection overrides are not allowed');

const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
function sql(query) {
  return execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
}
function rejects(query, pattern) {
  assert.throws(() => sql(query), pattern);
}

const eventId = '10000000-0000-4000-8000-000000000001';
const otherEventId = '10000000-0000-4000-8000-000000000002';
const insufficientId = '20000000-0000-4000-8000-000000000001';
const assessedId = '20000000-0000-4000-8000-000000000002';
const pathId = '30000000-0000-4000-8000-000000000001';
const validTickId = '40000000-0000-4000-8000-000000000001';
const lateTickId = '40000000-0000-4000-8000-000000000002';
const xauTickId = '40000000-0000-4000-8000-000000000003';
const cutoff = '2020-09-23T12:00:00Z';

function assessmentValues({ id, event = eventId, status = 'INSUFFICIENT_EVIDENCE', reason = "'typed upstream facts unavailable'", knowledgeCutoff = cutoff, supersedes = 'NULL', digit = 'a' }) {
  return `('${id}','${event}','SEMANTIC','${status}',${reason},'${knowledgeCutoff}',
    'DETERMINISTIC','gt-schema-test','gt-v1','${digit.repeat(64)}','${digit.repeat(64)}','${digit.repeat(64)}',${supersedes})`;
}

assert.match(sql('SHOW server_version;'), /^17\.6(?:\D|$)/, 'PostgreSQL 17.6 required');
assert.equal(sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p');"), '0');

sql(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;

  CREATE TABLE public.event_versions (
    id uuid PRIMARY KEY,
    knowledge_cutoff timestamptz NOT NULL
  );
  CREATE TABLE public.market_ticks (
    id uuid NOT NULL,
    symbol text NOT NULL,
    ts timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (id, ts)
  ) PARTITION BY RANGE (ts);
  CREATE TABLE public.market_ticks_2020_09 PARTITION OF public.market_ticks
    FOR VALUES FROM ('2020-09-01') TO ('2020-10-01');

  INSERT INTO public.event_versions VALUES
    ('${eventId}', '2020-09-23T10:00:00Z'),
    ('${otherEventId}', '2020-09-23T10:00:00Z');
  INSERT INTO public.market_ticks VALUES
    ('${validTickId}', 'DXY', '2020-09-23T11:00:00Z', '2020-09-23T11:01:00Z'),
    ('${lateTickId}', 'US10Y', '2020-09-23T11:00:00Z', '2020-09-23T12:01:00Z'),
    ('${xauTickId}', 'XAUUSD', '2020-09-23T11:00:00Z', '2020-09-23T11:01:00Z');
  GRANT SELECT ON public.event_versions, public.market_ticks TO service_role;
`);

sql(readFileSync(new URL('database/migrations/0027_gold_transmission_schema.sql', root), 'utf8'));

assert.equal(sql(`SELECT count(*) FROM pg_class
  WHERE oid IN ('public.gold_transmission_assessments'::regclass,
                'public.gold_transmission_paths'::regclass,
                'public.gold_transmission_driver_evidence'::regclass)
    AND relrowsecurity;`), '3');
assert.equal(sql(`SELECT count(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'fn_gold_transmission_%'
    AND NOT p.prosecdef
    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) setting
                WHERE setting IN ('search_path=', 'search_path=""'));`), '5');
console.log('PASS all GT-1 tables use RLS and all trigger functions are invoker-safe');

assert.equal(sql(`SELECT bool_and(
    has_table_privilege('service_role', oid, 'SELECT')
    AND has_table_privilege('service_role', oid, 'INSERT')
    AND NOT has_table_privilege('service_role', oid, 'UPDATE')
    AND NOT has_table_privilege('service_role', oid, 'DELETE')
    AND NOT has_table_privilege('anon', oid, 'SELECT')
    AND NOT has_table_privilege('authenticated', oid, 'SELECT'))
  FROM pg_class WHERE oid IN (
    'public.gold_transmission_assessments'::regclass,
    'public.gold_transmission_paths'::regclass,
    'public.gold_transmission_driver_evidence'::regclass);`), 't');
console.log('PASS only service_role has SELECT/INSERT; UPDATE/DELETE and client reads are denied');

sql(`SET ROLE service_role;
  INSERT INTO public.gold_transmission_assessments
    (id,event_version_id,model_variant,assessment_status,assessment_reason,knowledge_cutoff,
     producer_type,producer_actor,algorithm_version,input_fingerprint,semantic_fingerprint,
     idempotency_fingerprint,supersedes_assessment_id)
  VALUES ${assessmentValues({ id: insufficientId, digit: '1' })};`);
console.log('PASS explicit insufficient-evidence outcome commits without a causal path');

rejects(`SET ROLE service_role;
  INSERT INTO public.gold_transmission_assessments
    (id,event_version_id,model_variant,assessment_status,assessment_reason,knowledge_cutoff,
     producer_type,producer_actor,algorithm_version,input_fingerprint,semantic_fingerprint,
     idempotency_fingerprint,supersedes_assessment_id)
  VALUES ${assessmentValues({ id: '20000000-0000-4000-8000-000000000010', reason: 'NULL', digit: '2' })};`,
  /chk_gold_transmission_assessment_reason|violates check constraint/);

rejects(`SET ROLE service_role; BEGIN;
  INSERT INTO public.gold_transmission_assessments
    (id,event_version_id,model_variant,assessment_status,assessment_reason,knowledge_cutoff,
     producer_type,producer_actor,algorithm_version,input_fingerprint,semantic_fingerprint,
     idempotency_fingerprint,supersedes_assessment_id)
  VALUES ${assessmentValues({ id: '20000000-0000-4000-8000-000000000011', status: 'ASSESSED', reason: 'NULL', digit: '3' })};
  COMMIT;`, /requires at least one causal path/);
console.log('PASS invalid reason pairing and pathless ASSESSED outcomes fail closed');

sql(`SET ROLE service_role; BEGIN;
  INSERT INTO public.gold_transmission_assessments
    (id,event_version_id,model_variant,assessment_status,assessment_reason,knowledge_cutoff,
     producer_type,producer_actor,algorithm_version,input_fingerprint,semantic_fingerprint,
     idempotency_fingerprint,supersedes_assessment_id)
  VALUES ${assessmentValues({ id: assessedId, status: 'ASSESSED', reason: 'NULL', digit: '4' })};
  INSERT INTO public.gold_transmission_paths
    (id,assessment_id,path_key,transmission_channel,market_variable,variable_effect,
     gold_effect,confidence_state,confidence_value,rationale)
  VALUES ('${pathId}','${assessedId}','usd-path','USD','USD','DOWN','BULLISH','ESTIMATED',0.7500,
          'Semantic ex-ante USD channel');
  COMMIT;`);
console.log('PASS an ASSESSED envelope and at least one causal path commit atomically');

rejects(`SET ROLE service_role;
  INSERT INTO public.gold_transmission_paths
    (assessment_id,path_key,transmission_channel,market_variable,variable_effect,gold_effect,confidence_state)
  VALUES ('${insufficientId}','invalid','USD','USD','UNKNOWN','UNKNOWN','UNKNOWN');`,
  /paths require an ASSESSED parent/);

sql(`SET ROLE service_role;
  INSERT INTO public.gold_transmission_driver_evidence
    (path_id,market_tick_id,market_tick_ts,evidence_role)
  VALUES ('${pathId}','${validTickId}','2020-09-23T11:00:00Z','PRIMARY');`);
rejects(`SET ROLE service_role;
  INSERT INTO public.gold_transmission_driver_evidence
    (path_id,market_tick_id,market_tick_ts,evidence_role)
  VALUES ('${pathId}','${lateTickId}','2020-09-23T11:00:00Z','SUPPORTING');`,
  /both observation and ingestion at or before/);
rejects(`SET ROLE service_role;
  INSERT INTO public.gold_transmission_driver_evidence
    (path_id,market_tick_id,market_tick_ts,evidence_role)
  VALUES ('${pathId}','${xauTickId}','2020-09-23T11:00:00Z','SUPPORTING');`,
  /not canonical Gold Transmission driver evidence/);
console.log('PASS native drivers obey observation+ingestion cutoff; XAU macro stamps are rejected');

rejects(`SET ROLE service_role;
  INSERT INTO public.gold_transmission_assessments
    (id,event_version_id,model_variant,assessment_status,assessment_reason,knowledge_cutoff,
     producer_type,producer_actor,algorithm_version,input_fingerprint,semantic_fingerprint,
     idempotency_fingerprint,supersedes_assessment_id)
  VALUES ${assessmentValues({ id: '20000000-0000-4000-8000-000000000012', knowledgeCutoff: '2999-01-01T00:00:00Z', digit: '5' })};`,
  /knowledge_cutoff cannot be in the future/);
rejects(`SET ROLE service_role;
  INSERT INTO public.gold_transmission_assessments
    (id,event_version_id,model_variant,assessment_status,assessment_reason,knowledge_cutoff,
     producer_type,producer_actor,algorithm_version,input_fingerprint,semantic_fingerprint,
     idempotency_fingerprint,supersedes_assessment_id)
  VALUES ${assessmentValues({ id: '20000000-0000-4000-8000-000000000013', event: otherEventId, supersedes: `'${insufficientId}'`, digit: '6' })};`,
  /must share event_version_id and model_variant/);
rejects(`SET ROLE service_role;
  INSERT INTO public.gold_transmission_assessments
    (id,event_version_id,model_variant,assessment_status,assessment_reason,knowledge_cutoff,
     producer_type,producer_actor,algorithm_version,input_fingerprint,semantic_fingerprint,
     idempotency_fingerprint,supersedes_assessment_id)
  VALUES ${assessmentValues({ id: '20000000-0000-4000-8000-000000000014', knowledgeCutoff: '2020-09-23T11:59:59Z', supersedes: `'${insufficientId}'`, digit: '7' })};`,
  /knowledge_cutoff cannot regress/);
console.log('PASS future knowledge and invalid supersession are rejected');

rejects(`UPDATE public.gold_transmission_assessments
  SET producer_actor='mutated' WHERE id='${insufficientId}';`, /append-only/);
rejects(`DELETE FROM public.gold_transmission_paths WHERE id='${pathId}';`, /append-only/);
assert.equal(sql(`SELECT
  (SELECT count(*) FROM public.gold_transmission_assessments) || ',' ||
  (SELECT count(*) FROM public.gold_transmission_paths) || ',' ||
  (SELECT count(*) FROM public.gold_transmission_driver_evidence);`), '2,1,1');
console.log('PASS append-only enforcement and exact committed row counts');
