// Retry-After : delta-seconds strict (RFC 9110) ou date HTTP, jamais autre chose.
// Un en-tête illisible doit donner null (backoff normal), pas 0 ms (réessai
// immédiat contre un fournisseur qui limite déjà le débit).
import { readFileSync } from 'node:fs';
import { transpileModule } from 'typescript';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

for (const file of ['backend/ingest.ts', 'backend/ai_engine/committee_orchestrator.ts']) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const m = /function parseRetryAfter\(header: string \| null\): number \| null \{[\s\S]*?\n\}\n/.exec(src);
  if (!m) throw new Error(`parseRetryAfter introuvable dans ${file}`);
  const js = transpileModule(m[0], { compilerOptions: { target: 99 } }).outputText;
  const parseRetryAfter = new Function(`${js}; return parseRetryAfter;`)();
  const cases = [
    ['null', null, null], ['vide', '', null], ['espaces', '   ', null], ['hex', '0x10', null],
    ['exposant', '1e3', null], ['négatif', '-5', null], ['décimal', '1.5', null],
    ['texte', 'soon', null], ['année seule', '2026', 2026 * 1000], ['0', '0', 0], ['120', '120', 120000],
    [' 7 ', ' 7 ', 7000], ['géant', '99999999999999999999', null],
  ];
  for (const [n, h, exp] of cases) t(`${file} ${n}`, parseRetryAfter(h) === exp, String(parseRetryAfter(h)));
  const future = new Date(Date.now() + 30_000).toUTCString();
  const ms = parseRetryAfter(future);
  t(`${file} date HTTP future`, ms !== null && ms > 20_000 && ms <= 30_000, String(ms));
  t(`${file} date HTTP passée`, parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT') === 0);
}
console.log(`\n${p} OK, ${f} FAIL`);
process.exit(f ? 1 : 0);
