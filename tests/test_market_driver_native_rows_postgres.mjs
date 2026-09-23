// PostgreSQL 17.6 contract for migration 0025 in an empty disposable DB.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_market_driver_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR,
  'connection overrides are not allowed');

const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
function sql(query) {
  return execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
}
function accepts(symbol, close) {
  assert.match(symbol, /^[A-Z0-9]+$/);
  assert.equal(typeof close, 'number');
  sql(`INSERT INTO public.market_ticks(symbol, close) VALUES ('${symbol}', ${close});`);
}
function rejects(symbol, close) {
  assert.throws(() => accepts(symbol, close), /market_ticks_close_check|violates check constraint/);
}

assert.match(sql('SHOW server_version;'), /^17\.6(?:\D|$)/, 'PostgreSQL 17.6 required');
assert.equal(sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p');"), '0', 'database must be empty');

sql(`
  CREATE TABLE public.market_ticks (
    symbol text NOT NULL,
    close numeric(14,5) NOT NULL,
    CONSTRAINT market_ticks_close_check CHECK (close > 0)
  );
  INSERT INTO public.market_ticks(symbol, close) VALUES ('XAUUSD', 3750.25);
`);
sql(readFileSync(new URL('database/migrations/0025_market_driver_native_rows.sql', root), 'utf8'));

assert.equal(sql("SELECT count(*) FROM public.market_ticks WHERE symbol='XAUUSD' AND close=3750.25;"), '1');
console.log('PASS existing positive XAU row remains valid');

accepts('US10Y', 4.25); accepts('US10Y', -5); rejects('US10Y', -5.00001); rejects('US10Y', 25.00001);
console.log('PASS US10Y accepts [-5,25] and rejects values outside');
accepts('US10YR', -1.2); accepts('US10YR', -10); rejects('US10YR', -10.00001); rejects('US10YR', 25.00001);
console.log('PASS US10YR accepts [-10,25] and rejects values outside');
accepts('VIX', 0); rejects('VIX', -0.00001);
console.log('PASS VIX accepts zero and rejects negative values');
accepts('WTI', 0); rejects('WTI', -0.00001);
console.log('PASS WTI accepts zero and rejects negative values');
rejects('XAUUSD', 0); rejects('XAUUSD', -0.00001);
console.log('PASS XAUUSD remains strictly positive');
accepts('EURUSD', 1.1); rejects('EURUSD', 0); rejects('EURUSD', -0.00001);
console.log('PASS unrelated ordinary symbols remain strictly positive');

assert.equal(sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.market_ticks'::regclass AND conname='market_ticks_close_check';").includes("'US10YR'"), true);
console.log('PASS real migration SQL installed the named symbol-aware constraint');
