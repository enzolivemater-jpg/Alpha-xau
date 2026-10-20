/**
 * OFFLINE research-only approximation of the ICE USDX formula from ECB EUR
 * reference rates. NEVER an ICE DXY observation, MP-0 VERIFIED field or
 * tradable market quote. Accepts downloaded ECB SDMX CSV, never fetches.
 * Inputs: six currency units per EUR, same TIME_PERIOD, positive finite.
 */
export const PROXY_KIND = 'DXY_PROXY_RECONSTRUCTED_ECB_DAILY';
export const REQUIRED_CURRENCIES = Object.freeze(['USD','JPY','GBP','CAD','SEK','CHF']);
export const ECB_SERIES_URL = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD+JPY+GBP+CAD+SEK+CHF.EUR.SP00.A?format=csvdata';
const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;

function splitCsvLine(line) {
  const out=[]; let value=''; let quoted=false;
  for (let i=0;i<line.length;i++) {
    const c=line[i];
    if (c==='"') {
      if (quoted && line[i+1]==='"') {value+='"';i++;} else quoted=!quoted;
    } else if (c===',' && !quoted) {out.push(value);value='';}
    else value+=c;
  }
  if (quoted) throw new Error('CSV_UNCLOSED_QUOTE');
  out.push(value); return out;
}
function dateValid(day) {
  return DATE.test(day) && !Number.isNaN(Date.parse(day+'T00:00:00Z'))
    && new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
}
export function calculateDxyProxy(r) {
  if (!r || REQUIRED_CURRENCIES.some(k=>typeof r[k]!=='number'||!Number.isFinite(r[k])||r[k]<=0)) throw new Error('FX_INPUT_INVALID');
  // ECB quotes C EUR=1. USDJPY = EURJPY/EURUSD, GBPUSD=EURUSD/EURGBP.
  const [u,j,g,c,s,h]=REQUIRED_CURRENCIES.map(k=>r[k]);
  const value=50.14348112 * Math.pow(u,-0.576) * Math.pow(j/u,0.136)
    * Math.pow(u/g,-0.119) * Math.pow(c/u,0.091)
    * Math.pow(s/u,0.042) * Math.pow(h/u,0.036);
  if (!Number.isFinite(value)||value<=0) throw new Error('INDEX_CALCULATION_INVALID');
  return value;
}
export function parseEcbDailyCsv(csv, {sourceSha256}={}) {
  if (typeof csv!=='string'||!csv.trim()) throw new Error('ECB_CSV_EMPTY');
  if (!/^[a-f0-9]{64}$/.test(sourceSha256||'')) throw new Error('SOURCE_SHA256_REQUIRED');
  const lines=csv.replace(/^\\uFEFF/,'').split(/\\r?\\n/).filter(x=>x.trim() && !x.startsWith('#'));
  const head=splitCsvLine(lines.shift()||'').map(x=>x.trim().replace(/^\\uFEFF/,''));
  const at=key=>head.indexOf(key);
  for (const k of ['TIME_PERIOD','OBS_VALUE','CURRENCY']) if(at(k)<0) throw new Error('ECB_COLUMN_MISSING:'+k);
  if(at('CURRENCY_DENOM')<0) throw new Error('ECB_DENOMINATOR_NOT_DECLARED');
  const rows=new Map();
  for (const line of lines) {
    const cells=splitCsvLine(line);
    if(cells.length!==head.length) throw new Error('ECB_CSV_COLUMN_COUNT');
    const day=cells[at('TIME_PERIOD')], currency=cells[at('CURRENCY')];
    if (!dateValid(day)) throw new Error('ECB_DATE_INVALID');
    if (!REQUIRED_CURRENCIES.includes(currency)) continue;
    if (cells[at('CURRENCY_DENOM')]!=='EUR') throw new Error('ECB_DENOMINATOR_INVALID');
    const rate=Number(cells[at('OBS_VALUE')]);
    if (!cells[at('OBS_VALUE')].trim()||!Number.isFinite(rate)||rate<=0) throw new Error('ECB_RATE_INVALID');
    if(!rows.has(day))rows.set(day,{});
    if(Object.hasOwn(rows.get(day),currency))throw new Error('ECB_DUPLICATE_RATE');
    rows.get(day)[currency]=rate;
  }
  if(!rows.size)throw new Error('ECB_NO_TARGET_RATES');
  return [...rows.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,rates])=>{
    const missing=REQUIRED_CURRENCIES.filter(k=>!Object.hasOwn(rates,k));
    return Object.freeze({
      kind:PROXY_KIND, date, status:missing.length?'UNAVAILABLE':'CALCULATED',
      value:missing.length?null:calculateDxyProxy(rates),
      reason:missing.length?'MISSING_CURRENCY:'+missing.join(','):null,
      source:'ECB_EXR_EUR_REFERENCE_RATES', sourceSha256,
      officialIceDxy:false, intraday:false, publicationTimestampVerified:false,
      // ECB fixes a rate for a reference date; this does not prove when it became available.
      lookaheadSafeForReplay:false,
    });
  });
}
