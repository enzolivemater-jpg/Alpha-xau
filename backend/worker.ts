/**
 * =============================================================================
 *  ALPHA-XAU — backend/worker.ts
 *
 *  POINT D'ENTRÉE UNIQUE — correctif P0-2.
 *
 *  Cloudflare exécute UN script par Worker, mais accepte plusieurs
 *  expressions cron sur ce script. Ce dispatcher route chaque expression
 *  vers son moteur. Un seul déploiement, un seul jeu de secrets, trois
 *  cadences distinctes.
 *
 *  CADENCES ET JUSTIFICATION
 *
 *    every 5 min    market_engine   Cadence fixée quand XAUUSD et DXY
 *                                  partageaient encore TWELVE_DATA_KEY
 *                                  (quota gratuit 800 req/jour) ; DXY a
 *                                  depuis été retiré (symbole absent chez
 *                                  Twelve Data — voir providers.ts). La
 *                                  contrainte de quota d'origine ne
 *                                  s'applique donc plus à ce niveau,
 *                                  mais la cadence n'a pas été resserrée
 *                                  sans nécessité démontrée (voir
 *                                  discipline établie sur ce projet).
 *                                  Le seuil LIVE de XAUUSD reste à 360 s
 *                                  (validate.ts) pour garder une marge sur
 *                                  l'intervalle de cron, plutot que de
 *                                  coller au bord.
 *
 *    every 15 min   news_engine     La fenêtre GDELT par défaut est de
 *                                  60 min : à 15 min, chaque dépêche est
 *                                  vue par quatre runs successifs, ce qui
 *                                  absorbe une panne isolée sans trou.
 *
 *    hourly         ai_committee    Une analyse par heure. Le comité coûte
 *                                  cinq appels LLM : le déclencher au
 *                                  rythme du marché serait ruineux et
 *                                  produirait un bruit d'analyse sans
 *                                  information nouvelle. Les événements
 *                                  CATALYST CRITICAL déclenchent déjà un
 *                                  recalcul hors cron via AI_ENGINE_URL.
 *
 *  ANTI-CONCURRENCE : chaque moteur prend un verrou en base
 *  (uq_ingestion_runs_active, migration 0004) avant de travailler. Un run
 *  qui déborde sur le suivant provoque un SKIPPED, pas un doublon.
 * =============================================================================
 */

import { runMarketIngestion, type MarketEnv } from './market_engine/ingest_market.js';
import {
  runIngestion as runNewsIngestion,
  reconcileNotifications,
  handleRequest as handleNewsRequest,
  type Env as NewsEnv,
} from './ingest.js';
import {
  runCommittee,
  handleRequest as handleCommitteeRequest,
  type Env as CommitteeEnv,
  type RecalcScope,
} from './ai_engine/committee_orchestrator.js';

/**
 * Environnement consolidé du Worker. Toutes les valeurs proviennent des
 * secrets Cloudflare (`wrangler secret put`) ou des vars de wrangler.toml.
 * Aucune n'est committée.
 */
export interface WorkerEnv extends MarketEnv, NewsEnv, CommitteeEnv {}

/** Expressions cron déclarées dans wrangler.toml. */
const CRON_MARKET = '*/5 * * * *';
const CRON_NEWS = '7-59/15 * * * *';
const CRON_COMMITTEE = '0 * * * *';

export type JobName = 'market_engine' | 'news_engine' | 'ai_committee';

interface ScheduledEventLike { readonly cron?: string }
interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void }

/**
 * Traduit une expression cron en job.
 * Retourne null si l'expression est inconnue : mieux vaut ne rien exécuter
 * que deviner quel moteur lancer.
 */
export function resolveJob(cron: string | undefined): JobName | null {
  switch (cron) {
    case CRON_MARKET: return 'market_engine';
    case CRON_NEWS: return 'news_engine';
    case CRON_COMMITTEE: return 'ai_committee';
    default: return null;
  }
}

function log(level: string, job: string, message: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), level, worker: 'alpha-xau', job, message, ...extra,
  }));
}

/** Exécute le job demandé. Toute erreur est journalisée, jamais propagée
 *  au runtime : un moteur en échec ne doit pas empêcher les suivants. */
export async function runJob(job: JobName, env: WorkerEnv): Promise<void> {
  log('info', job, 'STARTED');
  try {
    if (job === 'market_engine') {
      const report = await runMarketIngestion(env, 'cron');
      log('info', job, report.status, { persisted: report.persisted, rejected: report.rejected });
      return;
    }
    if (job === 'news_engine') {
      await runNewsIngestion(env, 'cron');
      await reconcileNotifications(env);
      log('info', job, 'SUCCESS');
      return;
    }
    const hourUTC = new Date().getUTCHours();
    const scope: RecalcScope = hourUTC === 0 ? 'FULL' : 'H1_H2';
    const analysis = await runCommittee(env, { scope, triggerType: 'cron' });
    log('info', job, 'SUCCESS', { execution_status: analysis.meta.execution_status });
  } catch (err) {
    // Le message est déjà expurgé de tout secret par les moteurs.
    log('error', job, 'FAILED', { reason: err instanceof Error ? err.message : String(err) });
  }
}

export default {
  /**
   * Déclenchement manuel. Les routes restent celles des moteurs, chacun
   * validant son propre jeton (INGEST_TOKEN / COMMITTEE_TOKEN).
   */
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path.startsWith('/committee')) return handleCommitteeRequest(request, env);
    if (path.startsWith('/news')) return handleNewsRequest(request, env);

    if (path.startsWith('/health')) {
      return new Response(
        JSON.stringify({ status: 'ok', jobs: [CRON_MARKET, CRON_NEWS, CRON_COMMITTEE] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ error: 'Route inconnue' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
  },

  async scheduled(event: ScheduledEventLike, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
    const job = resolveJob(event.cron);
    if (job === null) {
      log('warn', 'dispatcher', 'SKIPPED : expression cron non reconnue', { cron: event.cron });
      return;
    }
    // waitUntil : le run se termine même après le retour du handler.
    ctx.waitUntil(runJob(job, env));
  },
};
