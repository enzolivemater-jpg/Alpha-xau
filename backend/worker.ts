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
 *                                  recalcul hors cron par appel direct
 *                                  in-process (handleCommitteeEvent,
 *                                  XAU-V2-OPS-010) — aucun aller-retour
 *                                  réseau ni URL propre au Worker.
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
  createNotifyBudget,
  handleRequest as handleNewsRequest,
  NewsEngineBusyError,
  type Env as NewsEnv,
} from './ingest.js';
import {
  runCommittee,
  handleRequest as handleCommitteeRequest,
  CommitteeBusyError,
  type Env as CommitteeEnv,
  type RecalcScope,
} from './ai_engine/committee_orchestrator.js';
import { handleEventShadowRequest, handleEventShadowDiscoverRequest } from './event_engine/shadow_runtime.js';

/**
 * Environnement consolidé du Worker. Toutes les valeurs proviennent des
 * secrets Cloudflare (`wrangler secret put`) ou des vars de wrangler.toml.
 * Aucune n'est committée.
 *
 * `ANTHROPIC_API_KEY` est optionnelle côté NewsEnv (le transport
 * event-driven interne dégrade proprement en son absence, cf.
 * postNotification dans ingest.ts) mais requise côté CommitteeEnv (le
 * cron horaire du comité ne peut pas fonctionner sans elle). Sur le
 * Worker RÉELLEMENT déployé, la clé est toujours présente : `Omit`
 * tranche ce conflit d'optionalité au niveau du type fusionné sans
 * affaiblir le contrat propre à chacun des deux modules.
 */
export interface WorkerEnv extends MarketEnv, Omit<NewsEnv, 'ANTHROPIC_API_KEY'>, CommitteeEnv {}

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
      // Un SEUL budget de notification (NotifyBudget) pour tout le cycle :
      // le dispatch direct et la réconciliation qui le suit immédiatement
      // ne doivent jamais, à eux deux, déclencher plus d'UN comité complet
      // (correctif XAU-V2-OPS-010, complément). Simple compteur local créé
      // ici et jeté après ce cycle — PostgreSQL/run_lock reste le seul
      // arbitre de concurrence pour l'exécution effective du comité.
      const budget = createNotifyBudget();
      await runNewsIngestion(env, 'cron', budget);
      await reconcileNotifications(env, budget);
      log('info', job, 'SUCCESS');
      return;
    }
    const hourUTC = new Date().getUTCHours();
    const scope: RecalcScope = hourUTC === 0 ? 'FULL' : 'H1_H2';
    const analysis = await runCommittee(env, { scope, triggerType: 'cron' });
    log('info', job, 'SUCCESS', { execution_status: analysis.meta.execution_status });
  } catch (err) {
    // ALREADY_RUNNING (verrou shared/run_lock.ts déjà tenu) est un état
    // NOMINAL — un run qui déborde sur le suivant — pas un échec du moteur.
    const busy = err instanceof NewsEngineBusyError || err instanceof CommitteeBusyError;
    // Le message est déjà expurgé de tout secret par les moteurs.
    const reason = err instanceof Error ? err.message : String(err);
    if (busy) {
      log('warn', job, 'SKIPPED', { reason });
    } else {
      log('error', job, 'FAILED', { reason });
    }
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
    // Exact match only — deliberately NOT startsWith('/event-shadow'), and
    // deliberately NOT wired into scheduled()/resolveJob()/JobName below.
    // OPS-023 PR9 adds a SECOND controlled MANUAL endpoint that composes
    // the merged PR8 discovery with the merged PR6 batch runner — checked
    // BEFORE the explicit-ID route below so the longer exact path is never
    // shadowed, though both are strict === comparisons against mutually
    // exclusive literal strings, so match order does not itself change
    // behavior. Still purely manual: an operator must issue this request;
    // automatic background draining of the discovered backlog remains out
    // of scope for a later, independently reviewed PR.
    if (path === '/event-shadow/discover') return handleEventShadowDiscoverRequest(request, env);
    // OPS-023 PR7 explicit-ID endpoint — unchanged, fully backward
    // compatible. Automatic candidate discovery is PR8 (above); cron
    // wiring remains explicitly out of scope for both endpoints.
    if (path === '/event-shadow') return handleEventShadowRequest(request, env);

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
