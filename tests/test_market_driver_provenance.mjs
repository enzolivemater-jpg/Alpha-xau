// Deterministic application contract for native market-driver provenance.
// Executes the real TypeScript modules after local transpilation; only fetch
// is simulated. No provider, live database, or deployment is contacted.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKET = path.join(ROOT, 'backend', 'market_engine');
let passed = 0;
let failed = 0;
const t = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  OK  ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

function transpile(file) {
  return ts.transpileModule(readFileSync(path.join(MARKET, file), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText.replaceAll(/(['"])\.\/([a-z_]+)\.js\1/g, '$1./$2.mjs$1');
}

const temp = mkdtempSync(path.join(tmpdir(), 'market-driver-provenance-'));
let ingest;
let context;
let validate;
try {
  mkdirSync(temp, { recursive: true });
  for (const file of ['types.ts', 'providers.ts', 'validate.ts', 'ingest_market.ts', 'context.ts']) {
    writeFileSync(path.join(temp, file.replace(/\.ts$/, '.mjs')), transpile(file), 'utf8');
  }
  ingest = await import(pathToFileURL(path.join(temp, 'ingest_market.mjs')).href);
  context = await import(pathToFileURL(path.join(temp, 'context.mjs')).href);
  validate = await import(pathToFileURL(path.join(temp, 'validate.mjs')).href);
} catch (error) {
  console.error('Unable to load real market-engine modules:', error);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

t('real ingest module loads', Boolean(ingest));
t('real context module loads', Boolean(context));
t('real validate module loads', Boolean(validate));
if (!ingest || !context || !validate) process.exit(1);

const base = {
  freshness: 'LIVE', ageSeconds: 60,
  open: null, high: null, low: null, bid: null, ask: null, volume: null,
};
const points = [
  { ...base, symbol: 'XAUUSD', source: 'twelve_data', value: 3750.25, observedAt: '2026-09-23T08:05:00.000Z', bid: 3750.1, ask: 3750.4 },
  { ...base, symbol: 'US10Y', source: 'fred', value: -0.25, observedAt: '2026-09-22T00:00:00.000Z' },
  { ...base, symbol: 'US10YR', source: 'fred', value: -1.2, observedAt: '2026-09-21T00:00:00.000Z' },
  { ...base, symbol: 'VIX', source: 'fred', value: 18.4, observedAt: '2026-09-22T00:00:00.000Z' },
  { ...base, symbol: 'WTI', source: 'fred', value: 67.3, observedAt: '2026-09-22T00:00:00.000Z' },
];
const rows = ingest.buildTickRows(points);

t('A) one native row exists for every validated symbol', rows.length === 5, JSON.stringify(rows.map((r) => r.symbol)));
for (const symbol of ['XAUUSD', 'US10Y', 'US10YR', 'VIX', 'WTI']) {
  t(`A) native ${symbol} row exists`, rows.some((row) => row.symbol === symbol));
}
for (const point of points.filter((item) => item.source === 'fred')) {
  const row = rows.find((item) => item.symbol === point.symbol);
  t(`B) ${point.symbol} preserves source`, row?.source === 'fred');
  t(`B) ${point.symbol} preserves observedAt`, row?.ts === point.observedAt);
  t(`B) ${point.symbol} preserves close`, row?.close === point.value);
}
const gold = rows.find((row) => row.symbol === 'XAUUSD');
t('C) XAU compatibility stamp preserves US10Y', gold?.us10y_yield === -0.25);
t('C) XAU compatibility stamp preserves US10YR', gold?.real_yield === -1.2);
t('C) XAU compatibility stamp preserves VIX', gold?.vix === 18.4);
t('C) XAU compatibility stamp preserves WTI', gold?.wti === 67.3);
t('D) identical FRED observation yields identical dedup key',
  validate.dedupKey('US10Y', 'tick', points[1].observedAt, 'fred')
    === validate.dedupKey('US10Y', 'tick', points[1].observedAt, 'fred'));
t('D) duplicate native point is removed within a batch',
  ingest.buildTickRows([...points, points[1]]).filter((row) => row.symbol === 'US10Y').length === 1);
t('E) valid negative US10YR survives buildTickRows', rows.find((row) => row.symbol === 'US10YR')?.close === -1.2);
t('F) valid negative US10Y survives buildTickRows', rows.find((row) => row.symbol === 'US10Y')?.close === -0.25);

const validationNow = new Date('2026-09-23T12:00:00.000Z');
const raw = (symbol, value) => ({ symbol, source: symbol === 'XAUUSD' ? 'twelve_data' : 'fred', value, observedAt: '2026-09-23T11:00:00.000Z' });
t('G) XAU positive value accepted by application validation', validate.validatePoint(raw('XAUUSD', 3750), validationNow).ok);
t('G) XAU zero rejected by application validation', !validate.validatePoint(raw('XAUUSD', 0), validationNow).ok);
t('G) XAU negative rejected by application validation', !validate.validatePoint(raw('XAUUSD', -1), validationNow).ok);
t('F) boundary-valid negative US10Y accepted by application validation', validate.validatePoint(raw('US10Y', -5), validationNow).ok);
t('E) boundary-valid negative US10YR accepted by application validation', validate.validatePoint(raw('US10YR', -10), validationNow).ok);

const latest = ({ symbol, close, source, ts, age, stamps = {} }) => ({
  symbol, bid: null, ask: null, close,
  dxy_value: null, us10y_yield: null, real_yield: null, vix: null, wti: null,
  source, ts, staleness_seconds: age, ...stamps,
});
const goldLatest = latest({
  symbol: 'XAUUSD', close: 3750.25, source: 'twelve_data',
  ts: '2026-09-23T11:59:00.000Z', age: 60,
  stamps: { us10y_yield: 99, real_yield: 98, vix: 97, wti: 96 },
});
const driverRows = [
  latest({ symbol: 'US10Y', close: 4.12, source: 'fred', ts: '2026-09-21T00:00:00.000Z', age: 216000 }),
  latest({ symbol: 'US10YR', close: -1.2, source: 'fred', ts: '2026-09-22T00:00:00.000Z', age: 129600 }),
  latest({ symbol: 'VIX', close: 18.4, source: 'fred', ts: '2026-09-22T00:00:00.000Z', age: 129600 }),
  latest({ symbol: 'WTI', close: 67.3, source: 'fred', ts: '2026-09-22T00:00:00.000Z', age: 129600 }),
];
const snapshot = context.buildSnapshot([goldLatest, ...driverRows]);
t('H) context reads native US10Y value, not XAU stamp', snapshot.us10y.value === 4.12);
t('H) context reads native US10Y source', snapshot.us10y.source === 'fred');
t('H) context reads native US10Y timestamp', snapshot.us10y.observedAt === driverRows[0].ts);
t('I) context reads native US10Y age', snapshot.us10y.ageSeconds === 216000);
t('J) fresh XAU remains LIVE', snapshot.spot.status === 'LIVE');
t('J) old native US10Y is STALE despite fresh XAU', snapshot.us10y.status === 'STALE');
t('H) negative native real yield remains available', snapshot.realYield.value === -1.2);
t('L) DXY remains UNAVAILABLE', snapshot.dxy.status === 'UNAVAILABLE' && snapshot.dxy.value === null);

const stampsOnly = context.buildSnapshot([goldLatest]);
t('K) absent native US10Y is UNAVAILABLE despite XAU stamp', stampsOnly.us10y.status === 'UNAVAILABLE' && stampsOnly.us10y.value === null);
t('K) absent native US10YR is UNAVAILABLE despite XAU stamp', stampsOnly.realYield.status === 'UNAVAILABLE' && stampsOnly.realYield.value === null);
t('K) absent native VIX is UNAVAILABLE despite XAU stamp', stampsOnly.vix.status === 'UNAVAILABLE' && stampsOnly.vix.value === null);
t('K) absent native WTI is UNAVAILABLE despite XAU stamp', stampsOnly.wti.status === 'UNAVAILABLE' && stampsOnly.wti.value === null);

const originalFetch = globalThis.fetch;
try {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const env = { SUPABASE_URL: 'https://example.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test-only' };
  const db = new ingest.MarketDb(env);
  await db.request('GET', 'v_market_latest', undefined, {
    apikey: 'attacker-key', Authorization: 'Bearer attacker-token', prefer: 'return=representation',
  });
  await context.fetchMarketSnapshot(env);

  const dbHeaders = calls[0].init.headers;
  const contextHeaders = calls[1].init.headers;
  t('N) MarketDb sends authoritative apikey', dbHeaders.apikey === env.SUPABASE_SERVICE_ROLE_KEY);
  t('N) MarketDb preserves non-auth extra headers', dbHeaders.prefer === 'return=representation');
  t('N) MarketDb extra apikey cannot override authority', dbHeaders.apikey !== 'attacker-key');
  t('O) MarketDb sends no Authorization header', !Object.keys(dbHeaders).some((key) => key.toLowerCase() === 'authorization'));
  t('N) fetchMarketSnapshot sends authoritative apikey', contextHeaders.apikey === env.SUPABASE_SERVICE_ROLE_KEY);
  t('O) fetchMarketSnapshot sends no Authorization header', !Object.keys(contextHeaders).some((key) => key.toLowerCase() === 'authorization'));
} finally {
  globalThis.fetch = originalFetch;
}

const combinedSource = [
  readFileSync(path.join(MARKET, 'ingest_market.ts'), 'utf8'),
  readFileSync(path.join(MARKET, 'context.ts'), 'utf8'),
].join('\n');
t('M) touched market paths introduce no Gold Transmission logic', !/transmission channel|gold direction|event impact interpretation/i.test(combinedSource));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
