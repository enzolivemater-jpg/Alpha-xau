// PostgreSQL 17.6 proof for migration 0026 in an empty disposable database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_market_rls_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR,
  'connection overrides are not allowed');

const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
function sql(query) {
  return execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
}

assert.match(sql('SHOW server_version;'), /^17\.6(?:\D|$)/, 'PostgreSQL 17.6 required');
assert.equal(sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p');"), '0');

sql(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE TABLE public.market_ticks(symbol text NOT NULL, ts timestamptz NOT NULL)
    PARTITION BY RANGE (ts);
  CREATE TABLE public.market_ticks_2026_09 PARTITION OF public.market_ticks
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
  CREATE TABLE public.market_ticks_default PARTITION OF public.market_ticks DEFAULT;
  INSERT INTO public.market_ticks VALUES
    ('XAUUSD','2026-09-23T00:00:00Z'),
    ('XAUUSD','2027-03-01T00:00:00Z');
  GRANT SELECT ON public.market_ticks, public.market_ticks_2026_09,
    public.market_ticks_default TO anon, authenticated;
  ALTER TABLE public.market_ticks ENABLE ROW LEVEL SECURITY;
  CREATE POLICY p_market_ticks_read ON public.market_ticks
    FOR SELECT TO anon, authenticated USING (true);
`);

assert.equal(sql("SET ROLE anon; SELECT count(*) FROM public.market_ticks_2026_09;"), '1');
console.log('PASS fixture reproduces direct-partition bypass before migration');

sql(readFileSync(new URL('database/migrations/0026_market_ticks_partition_rls.sql', root), 'utf8'));

assert.equal(sql(`SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
  WHERE i.inhparent='public.market_ticks'::regclass AND c.relrowsecurity;`), '2');
console.log('PASS every existing partition has RLS enabled');
assert.equal(sql("SET ROLE anon; SELECT count(*) FROM public.market_ticks;"), '2');
console.log('PASS parent API still exposes rows allowed by the parent policy');
assert.equal(sql("SET ROLE anon; SELECT count(*) FROM public.market_ticks_2026_09;"), '0');
assert.equal(sql("SET ROLE authenticated; SELECT count(*) FROM public.market_ticks_default;"), '0');
console.log('PASS direct child-table reads fail closed without child policies');

assert.equal(sql("SELECT public.fn_create_market_ticks_partition('2026-10-01');"), 'market_ticks_2026_10 (created)');
assert.equal(sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.market_ticks_2026_10'::regclass;"), 't');
sql('GRANT SELECT ON public.market_ticks_2026_10 TO anon, authenticated;');
assert.equal(sql("SET ROLE anon; SELECT count(*) FROM public.market_ticks_2026_10;"), '0');
console.log('PASS future partitions are born with RLS and fail closed directly even when granted');

assert.equal(sql("ALTER TABLE public.market_ticks_2026_10 DISABLE ROW LEVEL SECURITY; SELECT public.fn_create_market_ticks_partition('2026-10-01');"), 'market_ticks_2026_10 (already exists)');
assert.equal(sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.market_ticks_2026_10'::regclass;"), 't');
console.log('PASS existing-partition path self-heals RLS');

assert.equal(sql("SELECT prosecdef FROM pg_proc WHERE oid='public.fn_create_market_ticks_partition(date)'::regprocedure;"), 'f');
assert.equal(sql("SELECT proconfig @> ARRAY['search_path='] FROM pg_proc WHERE oid='public.fn_create_market_ticks_partition(date)'::regprocedure;"), 't');
console.log('PASS partition function is SECURITY INVOKER with empty search_path');
