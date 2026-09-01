/**
 * =============================================================================
 *  ALPHA-XAU — backend/shared/raw_news.ts
 *
 *  Writer/normalizer RAW News V1 — cible exclusive : public.news_articles.
 *
 *  Autonome par construction : ce module n'importe RIEN de backend/ingest.ts
 *  (ni NormalizedArticle, ni ScoredEvent, ni SourceRegistry, ni scoreArticle,
 *  ni dispatchActions, ni cleanText, ni shared/run_lock.ts). Il définit son
 *  propre port DB structural (RawNewsDb) plutôt que de réutiliser
 *  LockCapableDb, pour rester complètement indépendant de la couche verrou.
 *
 *  NON-BUTS explicites (voir NEWS-RAW-CONTRACT-001 / NEWS-RAW-007-AUDIT) :
 *    - aucun scoring, aucune classification, aucune notification comité ;
 *    - aucune écriture news_events ;
 *    - aucune résolution floue de source (pas de SourceRegistry, pas de
 *      fallback unknown_source) — source_code est fourni explicitement par
 *      l'appelant et validé, jamais deviné ;
 *    - observation_hash n'est JAMAIS calculé ici : colonne GENERATED côté
 *      PostgreSQL (migration 0009). Ce module ne fait que poser les valeurs
 *      qui alimentent ce calcul.
 * =============================================================================
 */

export type PublicationPrecision = 'timestamp' | 'date' | 'unknown' | 'none';

export type IngestQualityState = 'VALID' | 'DEGRADED' | 'UNVERIFIED';

/** Port structural minimal. Même shape que le client PostgREST existant
 *  (backend/ingest.ts), mais déclaré localement : ce module ne dépend
 *  d'aucun type exporté par ingest.ts ou shared/run_lock.ts. */
export interface RawNewsDb {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

/** Payload fourni par un collecteur. published_at/published_date ne sont
 *  PAS exposés ici : ce sont des valeurs DÉRIVÉES par le normalizer à
 *  partir de providerPublishedRaw + publicationPrecision, jamais des
 *  entrées directes — un collecteur ne doit pas pouvoir choisir la
 *  représentation normalisée, seulement l'observation brute. */
export interface RawNewsObservationInput {
  readonly ingestRunId: string;

  readonly provider: string;
  readonly providerItemId?: string | null;

  readonly sourceCode: string;
  readonly sourceDomain?: string | null;
  readonly canonicalUrl?: string | null;

  readonly title: string;
  readonly summary?: string | null;
  readonly content?: string | null;
  readonly providerCategory?: string | null;

  readonly providerPublishedRaw?: string | null;
  readonly publicationPrecision: PublicationPrecision;

  readonly observedAt: string;

  readonly ingestQualityState?: IngestQualityState;
  readonly ingestQualityReasons?: readonly string[];
}

/** Forme exacte de la ligne PostgREST (snake_case, colonnes DB). Ne
 *  contient jamais id / observation_hash / ingested_at : générés par
 *  PostgreSQL, jamais par l'application. */
export interface RawNewsArticleRow {
  readonly ingest_run_id: string;
  readonly provider: string;
  readonly provider_item_id: string | null;
  readonly source_code: string;
  readonly source_domain: string | null;
  readonly canonical_url: string | null;
  readonly title: string;
  readonly summary: string | null;
  readonly content: string | null;
  readonly provider_category: string | null;
  readonly provider_published_raw: string | null;
  readonly published_at: string | null;
  readonly published_date: string | null;
  readonly observed_at: string;
  readonly ingest_quality_state: IngestQualityState;
  readonly ingest_quality_reasons: readonly string[];
}

export type NormalizeResult =
  | { readonly ok: true; readonly row: RawNewsArticleRow }
  | { readonly ok: false; readonly reason: string };

export type RawNewsWriteResult =
  | { readonly outcome: 'inserted'; readonly id: string }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'rejected'; readonly reason: string }
  | { readonly outcome: 'database_error'; readonly error: string };

const MONTH_NAMES: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const MONTH_ABBR: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1];
}

/** Existence RÉELLE de la date civile — pas seulement un format reconnu.
 *  Rejette 2026-04-31, 2026-02-29 (non bissextile), etc. */
function isValidCivilDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

function isValidTimeOfDay(hour: number, minute: number, second: number): boolean {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

/** ±HHMM ou ±HH:MM, bornes horaires/minutes réelles. */
function isValidNumericOffset(offset: string): boolean {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!m) return false;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/** Extraction STRING-LEVEL d'une date civile — jamais via Date/TZ, pour ne
 *  jamais risquer de glisser d'un jour selon le fuseau d'exécution. Valide
 *  aussi que la date EXISTE réellement (pas seulement le format).
 *  Accepte "August 25, 2026" (OFAC) et "YYYY-MM-DD" déjà normalisé. */
function parseCivilDate(raw: string): string | null {
  const trimmed = raw.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const [, y, m, d] = iso;
    const year = Number(y), month = Number(m), day = Number(d);
    if (!isValidCivilDate(year, month, day)) return null;
    return `${y}-${m}-${d}`;
  }

  const monthDayYear = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(trimmed);
  if (monthDayYear) {
    const [, monthName, dayStr, year] = monthDayYear;
    const month = MONTH_NAMES[monthName.toLowerCase()];
    const day = Number(dayStr);
    if (month && isValidCivilDate(Number(year), month, day)) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

/**
 * Cœur commun ISO 8601, réutilisé par le parseur de publication ET par
 * parseObservedAt : DATE réelle + HEURE réelle + FUSEAU EXPLICITE
 * (Z ou offset numérique) sont tous trois obligatoires. La validation
 * calendaire est faite AVANT tout appel à Date.parse : Date.parse ne sert
 * ensuite qu'à la conversion en UTC, jamais à décider si l'entrée est
 * valide — il ne pourra donc jamais "corriger" silencieusement un
 * 30 février en 2 mars.
 */
function parseIsoTimestampWithTimezone(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(s);

  if (!isValidCivilDate(year, month, day)) return null;
  if (!isValidTimeOfDay(hour, minute, second)) return null;
  if (tz !== 'Z' && !isValidNumericOffset(tz)) return null;

  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Timestamp de PUBLICATION (fourni par un provider externe) : ISO 8601
 * strict, ou la forme RFC-like des flux RSS/Atom ("Tue, 25 Aug 2026
 * 18:00:00 GMT"). Fuseaux acceptés uniquement : Z, GMT, UTC, offset
 * numérique ±HHMM/±HH:MM. Les abréviations ambiguës (EST/EDT/CET, ...) ne
 * correspondent à aucun de ces motifs et sont donc rejetées par
 * construction, pas par une liste noire.
 */
function parseTimestampWithExplicitTimezone(raw: string): string | null {
  const trimmed = raw.trim();

  const iso = parseIsoTimestampWithTimezone(trimmed);
  if (iso !== null) return iso;

  const rfc = /^(?:[A-Za-z]{3},\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+(GMT|UTC|Z|[+-]\d{2}:?\d{2})$/
    .exec(trimmed);
  if (rfc) {
    const [, dayStr, monAbbr, year, h, mi, s, tz] = rfc;
    const month = MONTH_ABBR[monAbbr.toLowerCase()];
    if (!month) return null;
    const day = Number(dayStr);
    const hour = Number(h), minute = Number(mi), second = Number(s);

    if (!isValidCivilDate(Number(year), month, day)) return null;
    if (!isValidTimeOfDay(hour, minute, second)) return null;
    if (tz !== 'GMT' && tz !== 'UTC' && tz !== 'Z' && !isValidNumericOffset(tz)) return null;

    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }

  return null;
}

/**
 * observedAt est généré par NOTRE système, pas par un provider : contrat
 * plus strict que la publication — ISO 8601 uniquement (pas de forme
 * RFC-like), fuseau explicite obligatoire. Jamais de fallback now(),
 * jamais de minuit inventé, jamais de fuseau local runtime.
 */
function parseObservedAt(value: string): string | null {
  return parseIsoTimestampWithTimezone(value.trim());
}

function degrade(state: IngestQualityState): IngestQualityState {
  // Ne rétrograde jamais VERS VALID : seul VALID -> DEGRADED est autorisé.
  return state === 'VALID' ? 'DEGRADED' : state;
}

function dedupeReasons(reasons: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const reason of reasons) {
    const trimmed = reason.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

interface PublicationResolutionOk {
  readonly ok: true;
  readonly providerPublishedRaw: string | null;
  readonly publishedAt: string | null;
  readonly publishedDate: string | null;
  readonly qualityState: IngestQualityState;
  readonly reasons: readonly string[];
}
type PublicationResolution = PublicationResolutionOk | { readonly ok: false; readonly reason: string };

/**
 * Règle absolue : ne jamais inventer une heure. "August 25, 2026" en
 * precision=date produit published_date=2026-08-25 / published_at=NULL —
 * jamais 2026-08-25T00:00:00Z. precision=unknown n'appelle JAMAIS
 * Date.parse : deviner un format inconnu reviendrait à inventer une donnée.
 */
function resolvePublication(
  precision: PublicationPrecision,
  rawInput: string | null | undefined,
  qualityState: IngestQualityState,
  reasons: readonly string[],
): PublicationResolution {
  let providerPublishedRaw: string | null;
  if (rawInput == null) {
    providerPublishedRaw = null;
  } else if (rawInput.trim().length === 0) {
    return { ok: false, reason: 'provider_published_raw_blank' };
  } else {
    // Conservée EXACTEMENT telle que fournie : pas de trim sur la valeur
    // persistée, seulement pour la vérification de blancheur ci-dessus.
    providerPublishedRaw = rawInput;
  }

  if (precision === 'none') {
    if (providerPublishedRaw !== null) {
      return { ok: false, reason: 'publication_raw_present_for_none_precision' };
    }
    return { ok: true, providerPublishedRaw, publishedAt: null, publishedDate: null, qualityState, reasons };
  }

  if (providerPublishedRaw === null) {
    return { ok: false, reason: `publication_raw_required_for_${precision}_precision` };
  }

  if (precision === 'timestamp') {
    const publishedAt = parseTimestampWithExplicitTimezone(providerPublishedRaw);
    if (publishedAt !== null) {
      return { ok: true, providerPublishedRaw, publishedAt, publishedDate: null, qualityState, reasons };
    }
    return {
      ok: true, providerPublishedRaw,
      publishedAt: null, publishedDate: null,
      qualityState: degrade(qualityState),
      reasons: [...reasons, 'publication_timestamp_parse_failed'],
    };
  }

  if (precision === 'date') {
    const parsed = parseCivilDate(providerPublishedRaw);
    if (parsed !== null) {
      return { ok: true, providerPublishedRaw, publishedAt: null, publishedDate: parsed, qualityState, reasons };
    }
    return {
      ok: true, providerPublishedRaw,
      publishedAt: null, publishedDate: null,
      qualityState: degrade(qualityState),
      reasons: [...reasons, 'publication_date_parse_failed'],
    };
  }

  // precision === 'unknown' : jamais de tentative de parsing.
  return {
    ok: true, providerPublishedRaw,
    publishedAt: null, publishedDate: null,
    qualityState: degrade(qualityState),
    reasons: [...reasons, 'publication_precision_unknown'],
  };
}

/**
 * Normalise un RawNewsObservationInput en RawNewsArticleRow, ou rejette
 * avec une raison explicite. Fonction pure : aucun I/O.
 */
const VALID_PUBLICATION_PRECISIONS: ReadonlySet<string> = new Set(['timestamp', 'date', 'unknown', 'none']);
const VALID_QUALITY_STATES: ReadonlySet<string> = new Set(['VALID', 'DEGRADED', 'UNVERIFIED']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeRawNewsObservation(input: RawNewsObservationInput): NormalizeResult {
  // TypeScript n'est pas une validation runtime : un appelant dynamique
  // (ou mal typé) peut fournir une valeur hors union. Vérifié AVANT tout
  // usage, notamment avant resolvePublication().
  if (!VALID_PUBLICATION_PRECISIONS.has(input.publicationPrecision)) {
    return { ok: false, reason: 'publication_precision_invalid' };
  }
  if (input.ingestQualityState !== undefined && !VALID_QUALITY_STATES.has(input.ingestQualityState)) {
    return { ok: false, reason: 'ingest_quality_state_invalid' };
  }

  if (!UUID_PATTERN.test(input.ingestRunId)) {
    return { ok: false, reason: 'ingest_run_id_invalid' };
  }

  const provider = input.provider.trim().toLowerCase();
  if (provider.length === 0) return { ok: false, reason: 'provider_blank' };

  let providerItemId = input.providerItemId == null ? null : input.providerItemId.trim();
  if (providerItemId === '') providerItemId = null;

  // source_code n'est JAMAIS mutée silencieusement : le collecteur doit la
  // fournir déjà canonique, sinon rejet explicite (voir NEWS-RAW-007-AUDIT
  // §5 — aucune résolution floue de provenance dans ce module).
  const sourceCode = input.sourceCode;
  if (sourceCode.trim().length === 0) return { ok: false, reason: 'source_code_blank' };
  if (sourceCode !== sourceCode.trim() || sourceCode !== sourceCode.toLowerCase()) {
    return { ok: false, reason: 'source_code_not_canonical' };
  }

  let sourceDomain = input.sourceDomain == null ? null : input.sourceDomain.trim().toLowerCase();
  if (sourceDomain === '') sourceDomain = null;

  // trim uniquement — la valeur persistée est la version trimmed, jamais
  // reformatée : new URL() sert ICI à la validation (protocole/hostname),
  // jamais à produire la valeur stockée (pas de canonicalisation agressive
  // — query string, path et slashes restent exactement ceux observés).
  let canonicalUrl = input.canonicalUrl == null ? null : input.canonicalUrl.trim();
  if (canonicalUrl === '') canonicalUrl = null;
  if (canonicalUrl !== null) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(canonicalUrl);
    } catch {
      return { ok: false, reason: 'canonical_url_invalid_scheme' };
    }
    if ((parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') || parsedUrl.hostname.length === 0) {
      return { ok: false, reason: 'canonical_url_invalid_scheme' };
    }
  }

  if (providerItemId === null && canonicalUrl === null) {
    return { ok: false, reason: 'identity_missing' };
  }

  // title : le trim() ne sert qu'à la validation de blancheur — la valeur
  // stockée reste EXACTEMENT celle observée (pas de troncature, pas de
  // suppression HTML, pas de "nettoyage" cosmétique).
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    return { ok: false, reason: 'title_blank' };
  }
  const title = input.title;

  const summary = input.summary ?? null;
  const content = input.content ?? null;
  const providerCategory = input.providerCategory ?? null;

  const observedAt = parseObservedAt(input.observedAt);
  if (observedAt === null) return { ok: false, reason: 'observed_at_invalid' };

  const initialQualityState: IngestQualityState = input.ingestQualityState ?? 'VALID';
  const initialReasons = input.ingestQualityReasons ?? [];

  const publication = resolvePublication(
    input.publicationPrecision,
    input.providerPublishedRaw,
    initialQualityState,
    initialReasons,
  );
  if (!publication.ok) return { ok: false, reason: publication.reason };

  return {
    ok: true,
    row: {
      ingest_run_id: input.ingestRunId,
      provider,
      provider_item_id: providerItemId,
      source_code: sourceCode,
      source_domain: sourceDomain,
      canonical_url: canonicalUrl,
      title,
      summary,
      content,
      provider_category: providerCategory,
      provider_published_raw: publication.providerPublishedRaw,
      published_at: publication.publishedAt,
      published_date: publication.publishedDate,
      observed_at: observedAt,
      ingest_quality_state: publication.qualityState,
      ingest_quality_reasons: dedupeReasons(publication.reasons),
    },
  };
}

/**
 * Écrit UNE observation. Exactitude avant performance (V1) : un seul POST
 * mono-ligne, jamais de batch SQL multi-row. observation_hash n'est JAMAIS
 * CALCULÉ côté application ; son nom est seulement utilisé comme cible
 * PostgREST on_conflict. PostgreSQL seul décide de l'idempotence via son
 * index UNIQUE sur cette colonne générée.
 */
export async function writeRawNewsObservation(
  db: RawNewsDb,
  input: RawNewsObservationInput,
): Promise<RawNewsWriteResult> {
  const normalized = normalizeRawNewsObservation(input);
  if (!normalized.ok) {
    return { outcome: 'rejected', reason: normalized.reason };
  }

  try {
    const rows = await db.request<Array<{ id?: unknown }>>(
      'POST',
      'news_articles?on_conflict=observation_hash&select=id',
      [normalized.row],
      { prefer: 'return=representation,resolution=ignore-duplicates' },
    );

    if (rows.length === 0) return { outcome: 'duplicate' };

    if (rows.length === 1) {
      const id = rows[0]?.id;
      if (typeof id !== 'string' || id.trim().length === 0) {
        return {
          outcome: 'database_error',
          error: `invariant violation : réponse PostgREST sans id exploitable (${JSON.stringify(rows[0])})`,
        };
      }
      return { outcome: 'inserted', id };
    }

    return {
      outcome: 'database_error',
      error: `invariant violation : ${rows.length} lignes renvoyées pour une insertion mono-ligne`,
    };
  } catch (err) {
    return {
      outcome: 'database_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Convenience batch V1 : appelle writeRawNewsObservation SÉQUENTIELLEMENT,
 * AUCUN batch SQL multi-row. Un futur RPC/batch optimisé sera une tâche
 * séparée, uniquement si les volumes le justifient (voir NEWS-RAW-007-AUDIT).
 */
export async function writeRawNewsObservations(
  db: RawNewsDb,
  inputs: readonly RawNewsObservationInput[],
): Promise<readonly RawNewsWriteResult[]> {
  const results: RawNewsWriteResult[] = [];
  for (const input of inputs) {
    results.push(await writeRawNewsObservation(db, input));
  }
  return results;
}
