// Import direct du module TS via le "type stripping" natif de Node 22.6+
// (--experimental-strip-types) : aucune dépendance de build ajoutée, aucun
// fichier .mjs compilé tiers. raw_news.ts n'utilise que de la syntaxe TS
// "erasable" (interfaces/types/génériques) — compatible avec ce mode.
import {
  normalizeRawNewsObservation,
  writeRawNewsObservation,
  writeRawNewsObservations,
} from '../backend/shared/raw_news.ts';
import { readFileSync } from 'node:fs';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const baseInput = () => ({
  ingestRunId: '11111111-1111-4111-8111-111111111111',
  provider: 'fed',
  providerItemId: 'guid-1',
  sourceCode: 'federalreserve',
  sourceDomain: 'federalreserve.gov',
  canonicalUrl: 'https://www.federalreserve.gov/item',
  title: 'Title',
  summary: 'Summary',
  content: 'Content',
  providerCategory: 'Monetary Policy',
  providerPublishedRaw: 'Tue, 25 Aug 2026 18:00:00 GMT',
  publicationPrecision: 'timestamp',
  observedAt: '2026-08-25T18:05:00Z',
});

console.log('--- NORMALIZATION ---');
{
  const r = normalizeRawNewsObservation({ ...baseInput(), provider: ' Fed ' });
  t("provider ' Fed ' -> 'fed'", r.ok && r.row.provider === 'fed', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), provider: '   ' });
  t('provider vide -> rejected', !r.ok && r.reason === 'provider_blank', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), sourceCode: 'FederalReserve' });
  t('sourceCode uppercase -> rejected', !r.ok && r.reason === 'source_code_not_canonical', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), sourceCode: ' federalreserve' });
  t('sourceCode space -> rejected', !r.ok && r.reason === 'source_code_not_canonical', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), providerItemId: '   ', canonicalUrl: null });
  t('providerItemId vide + URL null -> rejected', !r.ok && r.reason === 'identity_missing', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), providerItemId: null, canonicalUrl: 'ftp://example.com/x' });
  t('URL ftp -> rejected', !r.ok && r.reason === 'canonical_url_invalid_scheme', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), providerItemId: null, canonicalUrl: 'https://example.com/x' });
  t('URL https -> valide', r.ok && r.row.canonical_url === 'https://example.com/x', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), providerItemId: null, canonicalUrl: 'http://example.com/x' });
  t('URL http -> valide', r.ok && r.row.canonical_url === 'http://example.com/x', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), providerItemId: null, canonicalUrl: 'https://' });
  t('URL https:// (sans host) -> rejected', !r.ok && r.reason === 'canonical_url_invalid_scheme', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), providerItemId: null, canonicalUrl: 'http://' });
  t('URL http:// (sans host) -> rejected', !r.ok && r.reason === 'canonical_url_invalid_scheme', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), providerItemId: null, canonicalUrl: 'not-a-url' });
  t('URL malformed -> rejected', !r.ok && r.reason === 'canonical_url_invalid_scheme', JSON.stringify(r));
}
{
  const withQuery = 'https://example.com/path/to/item?foo=1&bar=2#frag';
  const r = normalizeRawNewsObservation({ ...baseInput(), providerItemId: null, canonicalUrl: withQuery });
  t('URL avec query/path/fragment conservée EXACTEMENT (pas de canonicalisation agressive)',
    r.ok && r.row.canonical_url === withQuery, JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), title: '   ' });
  t('title blank -> rejected', !r.ok && r.reason === 'title_blank', JSON.stringify(r));
}
{
  const messy = '<b>Title</b>   with entities &amp; spacing '.repeat(20);
  const r = normalizeRawNewsObservation({ ...baseInput(), title: messy, content: messy });
  t('title/content non tronqués (préservés tels quels)', r.ok && r.row.title === messy && r.row.content === messy);
}

console.log('--- PUBLICATION (TIMESTAMP) ---');
{
  const raw = 'Tue, 25 Aug 2026 18:00:00 GMT';
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'timestamp', providerPublishedRaw: raw });
  t('timestamp RFC GMT avec heure -> published_at',
    r.ok && r.row.published_at === new Date(raw).toISOString() && r.row.published_date === null, JSON.stringify(r));
}
{
  const raw = '2026-08-25T18:00:00Z';
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'timestamp', providerPublishedRaw: raw });
  t('ISO Z valide -> published_at', r.ok && r.row.published_at === '2026-08-25T18:00:00.000Z', JSON.stringify(r));
}
{
  const raw = '2026-08-25T18:00:00+02:00';
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'timestamp', providerPublishedRaw: raw });
  t('ISO +02:00 valide -> published_at UTC', r.ok && r.row.published_at === '2026-08-25T16:00:00.000Z', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'timestamp', providerPublishedRaw: 'not-a-timestamp' });
  t('invalid timestamp -> DEGRADED + reason',
    r.ok && r.row.published_at === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_timestamp_parse_failed'), JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'timestamp', providerPublishedRaw: '2026-08-25T18:00:00' });
  t('timestamp sans fuseau explicite -> DEGRADED',
    r.ok && r.row.published_at === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_timestamp_parse_failed'), JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'timestamp', providerPublishedRaw: 'August 25, 2026' });
  t('date-only avec precision=timestamp -> DEGRADED',
    r.ok && r.row.published_at === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_timestamp_parse_failed'), JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'timestamp', providerPublishedRaw: '2026-02-30T18:00:00Z' });
  t('2026-02-30T18:00:00Z (date civile inexistante) -> DEGRADED, jamais glissé au 2 mars',
    r.ok && r.row.published_at === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_timestamp_parse_failed'), JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'timestamp', providerPublishedRaw: 'Tue, 30 Feb 2026 18:00:00 GMT' });
  t('"30 Feb ... GMT" (RFC, date civile inexistante) -> DEGRADED',
    r.ok && r.row.published_at === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_timestamp_parse_failed'), JSON.stringify(r));
}
for (const tz of ['EST', 'EDT', 'CET']) {
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'timestamp', providerPublishedRaw: `Tue, 25 Aug 2026 18:00:00 ${tz}` });
  t(`fuseau ambigu ${tz} -> DEGRADED (jamais accepté)`,
    r.ok && r.row.published_at === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_timestamp_parse_failed'), JSON.stringify(r));
}

console.log('--- PUBLICATION (DATE) ---');
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'date', providerPublishedRaw: 'August 25, 2026' });
  t('date-only "August 25, 2026" -> published_date=2026-08-25',
    r.ok && r.row.published_date === '2026-08-25' && r.row.published_at === null, JSON.stringify(r));
  t('date-only ne produit JAMAIS minuit', r.ok && r.row.published_at !== '2026-08-25T00:00:00.000Z');
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'date', providerPublishedRaw: 'not-a-date' });
  t('invalid date -> DEGRADED + reason',
    r.ok && r.row.published_date === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_date_parse_failed'), JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'date', providerPublishedRaw: '2026-02-29' });
  t('2026-02-29 (non bissextile) -> DEGRADED/invalid',
    r.ok && r.row.published_date === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_date_parse_failed'), JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'date', providerPublishedRaw: '2028-02-29' });
  t('2028-02-29 (bissextile) -> valide', r.ok && r.row.published_date === '2028-02-29', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'date', providerPublishedRaw: 'February 31, 2026' });
  t('"February 31, 2026" -> DEGRADED/invalid',
    r.ok && r.row.published_date === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_date_parse_failed'), JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'date', providerPublishedRaw: '2026-04-31' });
  t('2026-04-31 (avril = 30 jours) -> DEGRADED/invalid',
    r.ok && r.row.published_date === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_date_parse_failed'), JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'date', providerPublishedRaw: '2026-00-10' });
  t('2026-00-10 (mois 0) -> DEGRADED/invalid',
    r.ok && r.row.published_date === null && r.row.ingest_quality_state === 'DEGRADED', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'date', providerPublishedRaw: '2026-13-10' });
  t('2026-13-10 (mois 13) -> DEGRADED/invalid',
    r.ok && r.row.published_date === null && r.row.ingest_quality_state === 'DEGRADED', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'date', providerPublishedRaw: '2026-02-28' });
  t('2026-02-28 -> valide', r.ok && r.row.published_date === '2026-02-28', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'unknown', providerPublishedRaw: 'ambiguous 2026 string' });
  t('unknown -> both null + DEGRADED',
    r.ok && r.row.published_at === null && r.row.published_date === null && r.row.ingest_quality_state === 'DEGRADED'
      && r.row.ingest_quality_reasons.includes('publication_precision_unknown'), JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'none', providerPublishedRaw: 'should not be here' });
  t('none + raw nonnull -> rejected', !r.ok && r.reason === 'publication_raw_present_for_none_precision', JSON.stringify(r));
}
{
  const r1 = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'timestamp', providerPublishedRaw: null });
  const r2 = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'date', providerPublishedRaw: null });
  t('timestamp + raw null -> rejected', !r1.ok && r1.reason === 'publication_raw_required_for_timestamp_precision', JSON.stringify(r1));
  t('date + raw null -> rejected', !r2.ok && r2.reason === 'publication_raw_required_for_date_precision', JSON.stringify(r2));
}

console.log('--- QUALITY ---');
{
  const r = normalizeRawNewsObservation({ ...baseInput(), ingestQualityState: 'VALID', publicationPrecision: 'unknown', providerPublishedRaw: 'x' });
  t('VALID + parse failure -> DEGRADED', r.ok && r.row.ingest_quality_state === 'DEGRADED');
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), ingestQualityState: 'DEGRADED', publicationPrecision: 'unknown', providerPublishedRaw: 'x' });
  t('DEGRADED reste DEGRADED', r.ok && r.row.ingest_quality_state === 'DEGRADED');
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), ingestQualityState: 'UNVERIFIED', publicationPrecision: 'unknown', providerPublishedRaw: 'x' });
  t('UNVERIFIED reste UNVERIFIED', r.ok && r.row.ingest_quality_state === 'UNVERIFIED');
}
{
  const r = normalizeRawNewsObservation({
    ...baseInput(),
    ingestQualityReasons: ['manual_reason', 'manual_reason', '   '],
    publicationPrecision: 'unknown', providerPublishedRaw: 'x',
  });
  t('reasons dédupliquées et déterministes',
    r.ok && JSON.stringify(r.row.ingest_quality_reasons) === JSON.stringify(['manual_reason', 'publication_precision_unknown']),
    JSON.stringify(r));
}

console.log('--- OBSERVED_AT ---');
{
  const r = normalizeRawNewsObservation({ ...baseInput(), observedAt: '2026-08-25T18:05:00Z' });
  t('ISO Z valide', r.ok && r.row.observed_at === '2026-08-25T18:05:00.000Z', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), observedAt: '2026-08-25T20:05:00+02:00' });
  t('offset +02:00 valide -> converti en UTC', r.ok && r.row.observed_at === '2026-08-25T18:05:00.000Z', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), observedAt: '2026-08-25' });
  t('date-only -> rejected', !r.ok && r.reason === 'observed_at_invalid', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), observedAt: '2026-08-25T18:05:00' });
  t('timestamp sans fuseau -> rejected', !r.ok && r.reason === 'observed_at_invalid', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), observedAt: '2026-02-30T18:05:00Z' });
  t('date civile impossible -> rejected', !r.ok && r.reason === 'observed_at_invalid', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), observedAt: 'not-a-date' });
  t("'not-a-date' -> rejected", !r.ok && r.reason === 'observed_at_invalid', JSON.stringify(r));
}

console.log('--- ENUM (validation runtime) ---');
{
  const r = normalizeRawNewsObservation({ ...baseInput(), publicationPrecision: 'garbage' });
  t("publicationPrecision='garbage' -> rejected", !r.ok && r.reason === 'publication_precision_invalid', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), ingestQualityState: 'garbage' });
  t("ingestQualityState='garbage' -> rejected", !r.ok && r.reason === 'ingest_quality_state_invalid', JSON.stringify(r));
}

console.log('--- INGEST_RUN_ID ---');
{
  const r = normalizeRawNewsObservation({ ...baseInput(), ingestRunId: 'not-a-uuid' });
  t('UUID invalide -> rejected', !r.ok && r.reason === 'ingest_run_id_invalid', JSON.stringify(r));
}
{
  const r = normalizeRawNewsObservation({ ...baseInput(), ingestRunId: '11111111-1111-4111-8111-111111111111' });
  t('UUID canonique valide -> accepted', r.ok, JSON.stringify(r));
}

console.log('--- DB ---');
function makeFakeDb(responseRows) {
  const calls = [];
  return { calls, async request(method, path, body, extraHeaders) { calls.push({ method, path, body, extraHeaders }); return responseRows; } };
}
{
  const db = makeFakeDb([{ id: 'abc-123' }]);
  const result = await writeRawNewsObservation(db, baseInput());
  const call = db.calls[0];
  t('path exact on_conflict=observation_hash&select=id', call.path === 'news_articles?on_conflict=observation_hash&select=id', call.path);
  t('Prefer exact', call.extraHeaders?.prefer === 'return=representation,resolution=ignore-duplicates', JSON.stringify(call.extraHeaders));
  t('body = array de longueur 1', Array.isArray(call.body) && call.body.length === 1);
  t('observation_hash absent du payload', !('observation_hash' in call.body[0]));
  t('ingested_at absent du payload', !('ingested_at' in call.body[0]));
  t('id absent du payload envoyé', !('id' in call.body[0]));
  t('[{id}] => inserted', result.outcome === 'inserted' && result.id === 'abc-123', JSON.stringify(result));
}
{
  const db = makeFakeDb([]);
  const result = await writeRawNewsObservation(db, baseInput());
  t('[] => duplicate', result.outcome === 'duplicate', JSON.stringify(result));
}
{
  const db = makeFakeDb([{ id: 'x' }, { id: 'y' }]);
  const result = await writeRawNewsObservation(db, baseInput());
  t('>1 row => database_error (invariant)', result.outcome === 'database_error', JSON.stringify(result));
}
{
  const db = makeFakeDb([{}]);
  const result = await writeRawNewsObservation(db, baseInput());
  t('[{}] (id absent) => database_error', result.outcome === 'database_error', JSON.stringify(result));
}
{
  const db = makeFakeDb([{ id: '' }]);
  const result = await writeRawNewsObservation(db, baseInput());
  t("[{id:''}] (id blank) => database_error", result.outcome === 'database_error', JSON.stringify(result));
}
{
  const db = makeFakeDb([{ id: 'valid' }]);
  const result = await writeRawNewsObservation(db, baseInput());
  t("[{id:'valid'}] => inserted", result.outcome === 'inserted' && result.id === 'valid', JSON.stringify(result));
}
{
  const db = makeFakeDb([{ id: 'a' }]);
  const result = await writeRawNewsObservation(db, { ...baseInput(), provider: '' });
  t('invalid input => request jamais appelée', db.calls.length === 0 && result.outcome === 'rejected', JSON.stringify(result));
}
{
  const db = { async request() { throw new Error('network down'); } };
  const result = await writeRawNewsObservation(db, baseInput());
  t('thrown DB error => database_error', result.outcome === 'database_error' && result.error === 'network down', JSON.stringify(result));
}
{
  const db = makeFakeDb([{ id: 'x' }]);
  const results = await writeRawNewsObservations(db, [baseInput(), baseInput()]);
  t('batch V1 : appels séquentiels, un POST par input (pas de batch SQL)',
    db.calls.length === 2 && results.length === 2 && results.every((r) => r.outcome === 'inserted'));
}

console.log('--- REGRESSION STATIC ---');
{
  const source = readFileSync(new URL('../backend/shared/raw_news.ts', import.meta.url), 'utf8');

  // On interdit l'USAGE réel (appel de fonction / littéral de table cible),
  // pas la simple mention en prose dans un commentaire expliquant les
  // non-buts du module (ex. "aucune écriture news_events" est légitime).
  t('raw_news.ts n\'appelle pas scoreArticle(', !/\bscoreArticle\s*\(/.test(source));
  t('raw_news.ts n\'appelle pas dispatchActions(', !/\bdispatchActions\s*\(/.test(source));
  t('raw_news.ts n\'appelle pas buildNotification(', !/\bbuildNotification\s*\(/.test(source));
  t('raw_news.ts ne cible pas news_events comme table (littéral quoté)', !/['"`]news_events\b/.test(source));

  // Interdit un CALCUL applicatif du hash (appel de fonction), PAS le nom
  // de colonne "observation_hash" dans le paramètre PostgREST on_conflict.
  const hashComputationCall = /\b(crypto|digest|sha256)\s*\(/i;
  t('aucun calcul applicatif de hash (digest/crypto/sha256 appelés)', !hashComputationCall.test(source));
  t('on_conflict=observation_hash présent (nom de colonne autorisé)', source.includes('on_conflict=observation_hash'));
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
