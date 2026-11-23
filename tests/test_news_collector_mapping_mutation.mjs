// P3 — backend/ingest.ts : collecteurs GDELT / NewsAPI face à un fournisseur
// qui renvoie UN élément d'article malformé dans une réponse par ailleurs
// valide (titre non textuel, élément null, url non textuelle, champ
// `articles` qui n'est pas un tableau).
//
// Contrat : un élément illisible est écarté, les éléments valides du même lot
// sont conservés, le rapport reste ok:true ; jamais de valeur inventée.
// Un champ `articles` qui n’est pas un tableau = zéro article (échec honnête
// rapporté, ok:false), jamais une exception non rattrapée.
//
// Méthode : fonctions extraites verbatim de backend/ingest.ts, exécutées dans
// un sous-processus Node (type stripping), fetch stubbé, horloge gelée.
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const src = readFileSync(new URL('../backend/ingest.ts', import.meta.url), 'utf8');
const tsSrc = readFileSync(new URL('../backend/shared/strict_timestamp.ts', import.meta.url), 'utf8');

function extractBlock(s, startRegex) {
  const m = startRegex.exec(s);
  if (!m) throw new Error(`extraction introuvable pour ${startRegex}`);
  const start = m.index;
  const parenIdx = s.indexOf('(', start);
  const braceCandidateIdx = s.indexOf('{', start);
  let searchFrom = start;
  if (parenIdx !== -1 && parenIdx < braceCandidateIdx) {
    let pd = 0, j = parenIdx;
    for (; j < s.length; j++) {
      if (s[j] === '(') pd++;
      else if (s[j] === ')') { pd--; if (pd === 0) break; }
    }
    searchFrom = j + 1;
  }
  let nest = 0, braceStart = -1;
  for (let k = searchFrom; k < s.length; k++) {
    const c = s[k];
    if (c === '<' || c === '(' || c === '[') nest++;
    else if (c === '>' || c === ')' || c === ']') nest = Math.max(0, nest - 1);
    else if (c === '{' && nest === 0) { braceStart = k; break; }
  }
  let depth = 0, i = braceStart;
  for (; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) break; }
  }
  let end = i + 1;
  while (s[end] === ';') end++;
  return s.slice(start, end);
}
const extractConst = (s, name) => {
  const m = new RegExp(`const ${name} =[\\s\\S]*?;`).exec(s);
  if (!m) throw new Error(`extraction introuvable pour ${name}`);
  return m[0];
};

const parts = {
  config: extractBlock(src, /^const CONFIG = \{/m),
  errorMessage: extractBlock(src, /function errorMessage\(err: unknown\)/),
  redactString: extractBlock(src, /function redactString\(value: string\)/),
  redact: extractBlock(src, /function redact\(input: unknown, depth = 0\)/),
  secret: /const SECRET_KEY_PATTERN = .*;/.exec(src)[0],
  isPlain: extractBlock(src, /function isPlainRecord\(/),
  extractDomain: extractBlock(src, /function extractDomain\(/),
  cleanText: extractBlock(src, /function cleanText\(/),
  strip: extractBlock(src, /function stripPublisherSuffix\(/),
  dedup: extractBlock(src, /function dedupKeyOf\(/),
  parseTs: extractBlock(src, /function parseTimestamp\(/),
  shape: /const SHAPE = .*;/.exec(tsSrc)[0],
  dim: extractBlock(tsSrc, /function daysInMonth\(/),
  strict: extractBlock(tsSrc, /function parseStrictTimestamp\(/),
  gq: extractConst(src, 'GDELT_QUERY'),
  nq: extractConst(src, 'NEWSAPI_QUERY'),
  gdelt: extractBlock(src, /async function collectGdelt\(/),
  news: extractBlock(src, /async function collectNewsApi\(/),
};

const dir = mkdtempSync(join(tmpdir(), 'xau-collect-map-'));
const harnessPath = join(dir, 'harness.ts');
writeFileSync(harnessPath, `
export {};
${parts.config}
const FIXED_NOW_MS = Date.parse('2026-09-13T13:00:00.000Z');
Date.now = () => FIXED_NOW_MS;
${parts.secret}
${parts.redactString}
${parts.redact}
${parts.errorMessage}
${parts.isPlain}
${parts.extractDomain}
${parts.cleanText}
${parts.strip}
${parts.dedup}
${parts.shape}
${parts.dim}
${parts.strict}
${parts.parseTs}
class HttpError extends Error {}
class Logger { debug() {} info() {} warn() {} error() {} }
${parts.gq}
${parts.nq}
let __next;
async function fetchJsonWithRetry() { return { data: __next, retries: 0 }; }
${parts.gdelt}
${parts.news}

const GOOD_G = { url: 'https://www.reuters.com/a', title: 'Gold climbs on Fed bets', seendate: '20260913T120000Z', domain: 'reuters.com' };
const GOOD_N = { source: { name: 'x' }, title: 'Gold climbs on yields', description: 'd', content: 'c', url: 'https://www.ft.com/b', publishedAt: '2026-09-13T12:00:00Z' };
const hostile = [null, undefined, 0, 1, true, 'str', [], [1], { title: 42 }, { title: {} }, { title: ['x'] },
  { title: 'T', seendate: 20260913 }, { url: 5, title: 'T2', seendate: '20260913T120000Z' }];
const out = [];
for (const h of hostile) {
  const rec = { h: JSON.stringify(h) ?? 'undefined' };
  try { __next = { articles: [h, GOOD_G] }; const r = await collectGdelt({}, new Logger()); rec.g = { ok: r.report.ok, kept: r.articles.length, good: r.articles.some((a) => a.url === GOOD_G.url) }; }
  catch (e) { rec.g = { threw: String(e) }; }
  try { __next = { status: 'ok', articles: [h, GOOD_N] }; const r = await collectNewsApi({ NEWSAPI_KEY: 'k' }, new Logger()); rec.n = { ok: r.report.ok, kept: r.articles.length, good: r.articles.some((a) => a.url === GOOD_N.url) }; }
  catch (e) { rec.n = { threw: String(e) }; }
  out.push(rec);
}
const shapes = [];
for (const a of [null, 5, 'x', {}, true, { length: 3 }]) {
  const rec = { a: JSON.stringify(a) };
  try { __next = { articles: a }; const r = await collectGdelt({}, new Logger()); rec.g = { ok: r.report.ok, kept: r.articles.length }; } catch (e) { rec.g = { threw: String(e) }; }
  try { __next = { status: 'ok', articles: a }; const r = await collectNewsApi({ NEWSAPI_KEY: 'k' }, new Logger()); rec.n = { ok: r.report.ok, kept: r.articles.length }; } catch (e) { rec.n = { threw: String(e) }; }
  shapes.push(rec);
}
// null au premier niveau de la réponse
for (const d of [null, 'x', 7]) {
  const rec = { a: 'data=' + JSON.stringify(d) };
  try { __next = d; const r = await collectGdelt({}, new Logger()); rec.g = { ok: r.report.ok, kept: r.articles.length }; } catch (e) { rec.g = { threw: String(e) }; }
  try { __next = d; const r = await collectNewsApi({ NEWSAPI_KEY: 'k' }, new Logger()); rec.n = { ok: r.report.ok, kept: r.articles.length }; } catch (e) { rec.n = { threw: String(e) }; }
  shapes.push(rec);
}
console.log(JSON.stringify({ out, shapes }));
`);
let res;
try {
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', harnessPath], { encoding: 'utf8', timeout: 60000 });
  res = JSON.parse(stdout.trim().split('\n').pop());
} finally { rmSync(dir, { recursive: true, force: true }); }

for (const r of res.out) {
  for (const k of ['g', 'n']) {
    const name = `${k === 'g' ? 'GDELT' : 'NewsAPI'} : élément ${r.h} écarté, article valide conservé, ok`;
    t(name, !r[k].threw && r[k].ok === true && r[k].good === true, JSON.stringify(r[k]));
  }
}
for (const r of res.shapes) {
  for (const k of ['g', 'n']) {
    t(`${k === 'g' ? 'GDELT' : 'NewsAPI'} : articles=${r.a} -> aucun article, aucune exception`,
      !r[k].threw && r[k].kept === 0, JSON.stringify(r[k]));
  }
}
console.log(`\n${p} OK, ${f} FAIL`);
process.exit(f ? 1 : 0);
