// PostgreSQL 17 proof for EF-3 in a disposable local database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_event_facts_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR,
  'connection overrides are not allowed');

const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
function sql(query) {
  return execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
}
function rejects(query) {
  assert.throws(() => sql(query), /chk_event_versions_supported_canonical_state|check constraint|fn_event_is_supported/);
}
function literal(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}
function insert(version, state) {
  return `INSERT INTO public.event_versions
    (canonical_event_state_schema_version, canonical_event_state)
    VALUES (${version}, ${literal(state)});`;
}

assert.equal(sql('SHOW server_version_num;').slice(0, 2), '17', 'PostgreSQL 17 required');
sql(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.event_versions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canonical_event_state_schema_version smallint NOT NULL CHECK (canonical_event_state_schema_version > 0),
    canonical_event_state jsonb NOT NULL
  );
  INSERT INTO public.event_versions
    (canonical_event_state_schema_version, canonical_event_state)
  VALUES (1, '{"event_type":"OFFICIAL_SPEECH","subject":"Existing V1","detail":null}');
`);
sql(readFileSync(new URL('database/migrations/0029_event_facts_ces_v2_persistence.sql', root), 'utf8'));

const period = { kind: 'MONTH', year: 2026, month: 8 };
const metric = (metric_code, unit, value) => ({
  metric_code,
  reference_period: period,
  unit,
  actual: { state: 'KNOWN', value },
  consensus: { state: 'UNKNOWN', value: null },
  prior_periods: [],
});
const valid = {
  event_type: 'STATISTICAL_RELEASE',
  subject: 'US Bureau of Labor Statistics releases August 2026 Consumer Price Index',
  detail: null,
  facts: {
    release_family: 'US_CPI',
    metrics: [
      metric('CPI_CORE_MOM', 'PERCENT_CHANGE_MOM', '0.3'),
      metric('CPI_CORE_YOY', 'PERCENT_CHANGE_YOY', '3.1'),
      metric('CPI_HEADLINE_MOM', 'PERCENT_CHANGE_MOM', '0.4'),
      metric('CPI_HEADLINE_YOY', 'PERCENT_CHANGE_YOY', '2.9'),
    ],
  },
};

sql(insert(1, { event_type: 'OFFICIAL_SPEECH', subject: 'New V1', detail: null }));
sql(insert(2, valid));
assert.equal(sql('SELECT count(*) FROM public.event_versions;'), '3');
console.log('PASS existing/new CES V1 and exact BLS CPI CES V2 persist');

const mutate = fn => { const copy = structuredClone(valid); fn(copy); return copy; };
rejects(insert(1, valid));
rejects(insert(3, valid));
rejects(insert(2, mutate(x => { x.extra = true; })));
rejects(insert(2, mutate(x => { x.facts.release_family = 'US_NFP'; })));
rejects(insert(2, mutate(x => { x.facts.metrics.pop(); })));
rejects(insert(2, mutate(x => { x.facts.metrics[1].metric_code = 'CPI_CORE_MOM'; })));
rejects(insert(2, mutate(x => { x.facts.metrics[0].unit = 'PERCENT_CHANGE_YOY'; })));
rejects(insert(2, mutate(x => { x.facts.metrics[0].reference_period.month = 13; })));
rejects(insert(2, mutate(x => { x.facts.metrics[0].reference_period.month = 7; })));
rejects(insert(2, mutate(x => { x.facts.metrics[0].actual.value = '0.30'; })));
rejects(insert(2, mutate(x => { x.facts.metrics[0].actual.value = '-0'; })));
rejects(insert(2, mutate(x => { x.facts.metrics[0].consensus = { state: 'KNOWN', value: '0.2' }; })));
rejects(insert(2, mutate(x => { x.facts.metrics[0].prior_periods = [{}]; })));
assert.equal(sql('SELECT count(*) FROM public.event_versions;'), '3');
console.log('PASS unknown versions/families and malformed CES V2 variants fail closed');

assert.equal(sql(`SELECT
  NOT p.prosecdef
  AND p.provolatile = 'i'
  AND p.proisstrict
  AND p.proparallel = 's'
  AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND has_function_privilege('service_role', p.oid, 'EXECUTE')
FROM pg_proc p
WHERE p.oid = 'public.fn_event_is_supported_canonical_state(smallint,jsonb)'::regprocedure;`), 't');
console.log('PASS validator volatility, invoker security, and grants are exact');
