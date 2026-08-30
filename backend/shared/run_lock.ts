/**
 * =============================================================================
 *  ALPHA-XAU — backend/shared/run_lock.ts
 *
 *  VERROU D'EXÉCUTION PARTAGÉ — correctif P0-CONCURRENCY.
 *
 *  Implémentation UNIQUE du mécanisme d'anti-concurrence, extraite de
 *  market_engine/ingest_market.ts pour être réutilisée par le comité IA.
 *  Le re-audit exigeait « le même mécanisme robuste » : c'est littéralement
 *  le même code, pas un équivalent.
 *
 *  ---------------------------------------------------------------------------
 *  POURQUOI POSTGRESQL ET NON UN VERROU MÉMOIRE
 *  ---------------------------------------------------------------------------
 *  Cloudflare exécute le Worker dans N isolats, potentiellement dans N
 *  datacentres. Une variable globale JavaScript n'est partagée par aucun
 *  d'eux : deux instances la verraient toutes les deux à `false` et
 *  lanceraient toutes les deux un comité. Seul un arbitre partagé peut
 *  trancher, et le seul état partagé du système est PostgreSQL.
 *
 *  L'arbitrage repose sur l'index partiel UNIQUE `uq_ingestion_runs_active`
 *  (migration 0004) : une seule ligne `status='running'` par `engine`.
 *  L'atomicité est celle de l'INSERT — indivisible par construction. Deux
 *  INSERT concurrents ne peuvent pas réussir tous les deux, quel que soit le
 *  nombre d'isolats, de régions ou de requêtes simultanées.
 * =============================================================================
 */

/** Contrat minimal attendu d'un client PostgREST. Évite de coupler ce
 *  module à une implémentation de client particulière. */
export interface LockCapableDb {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

/** Moteurs susceptibles de prendre un verrou. */
export type EngineName = 'market_engine' | 'news_engine' | 'ai_committee';

export type LockOutcome =
  | { readonly acquired: true; readonly runRowId: string }
  | { readonly acquired: false; readonly reason: 'ALREADY_RUNNING' };

/** Durée au-delà de laquelle un verrou est considéré abandonné. */
export const DEFAULT_STALE_LOCK_MINUTES = 15;

/**
 * Détecte une violation d'unicité PostgreSQL dans un message d'erreur
 * PostgREST. PostgREST répond 409 avec un corps contenant `"code":"23505"`
 * et le libellé « duplicate key ». Les deux sont recherchés : le libellé
 * peut être localisé sur certaines instances, le code ne l'est jamais.
 */
export function isUniqueViolation(message: string): boolean {
  return /23505|duplicate key|already exists/i.test(message);
}

/**
 * Tente de prendre le verrou du moteur.
 *
 * Récupère d'abord tout verrou abandonné (Worker tué avant d'écrire
 * `finished_at`), puis insère la ligne `running`. Une violation d'unicité
 * signifie « un run est déjà actif » : c'est le cas NOMINAL, pas une erreur.
 */
export async function acquireLock(
  db: LockCapableDb,
  engine: EngineName,
  triggerType: string,
  staleMinutes: number = DEFAULT_STALE_LOCK_MINUTES,
): Promise<LockOutcome> {
  await db.request('POST', 'rpc/fn_reclaim_stale_runs', {
    p_engine: engine,
    p_older_than_minutes: staleMinutes,
  }).catch(() => undefined);

  try {
    const rows = await db.request<Array<{ id: string }>>(
      'POST', 'ingestion_runs?select=id',
      [{ engine, trigger_type: triggerType, status: 'running' }],
      { prefer: 'return=representation' },
    );
    const runRowId = rows[0]?.id;
    if (!runRowId) return { acquired: false, reason: 'ALREADY_RUNNING' };
    return { acquired: true, runRowId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isUniqueViolation(message)) return { acquired: false, reason: 'ALREADY_RUNNING' };
    throw err;
  }
}

export interface LockRelease {
  readonly status: 'success' | 'partial' | 'failed';
  readonly durationMs: number;
  readonly fetched?: number;
  readonly rejected?: number;
  readonly persisted?: number;
  readonly duplicates?: number;
  /** Propres à news_engine (classification §24). Omis par market_engine et
   *  ai_committee : les colonnes ingestion_runs.critical_count/major_count
   *  restent alors intouchées par ce PATCH, comme avant leur introduction. */
  readonly critical?: number;
  readonly major?: number;
  readonly providers?: Record<string, unknown>;
  readonly errors?: readonly string[];
}

/**
 * Libère le verrou. Doit être appelée dans un `finally` : un verrou non
 * libéré bloque le moteur jusqu'à la récupération stale, soit 15 minutes
 * d'analyses perdues.
 */
export async function releaseLock(
  db: LockCapableDb,
  runRowId: string,
  release: LockRelease,
): Promise<void> {
  const body: Record<string, unknown> = {
    finished_at: new Date().toISOString(),
    duration_ms: release.durationMs,
    status: release.status,
    fetched_count: release.fetched ?? 0,
    rejected_count: release.rejected ?? 0,
    persisted_count: release.persisted ?? 0,
    duplicate_count: release.duplicates ?? 0,
    providers: release.providers ?? {},
    errors: release.errors ?? [],
  };
  // Champs optionnels : n'apparaissent dans le corps PATCH que si le moteur
  // appelant les fournit, pour ne rien changer au comportement des moteurs
  // qui ne les utilisent pas (PostgREST ne touche que les clés présentes).
  if (release.critical !== undefined) body.critical_count = release.critical;
  if (release.major !== undefined) body.major_count = release.major;

  await db.request('PATCH', `ingestion_runs?id=eq.${encodeURIComponent(runRowId)}`, body, {
    prefer: 'return=minimal',
  });
}
