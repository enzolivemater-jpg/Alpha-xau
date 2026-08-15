-- =====================================================================
--  ALPHA-XAU — database/migrations/0004_job_concurrency_guard.sql
--
--  Correctif P0-2 (partie base).
--
--  OBJET : empêcher deux exécutions simultanées d'un même moteur.
--
--  Les Cron Triggers Cloudflare n'offrent aucune garantie d'exécution
--  unique : un run lent peut chevaucher le suivant, et un redéploiement
--  peut déclencher deux instances. Sans verrou, deux runs market_engine
--  concurrents produiraient des écritures redondantes et fausseraient
--  les compteurs d'observabilité.
--
--  MÉCANISME : index partiel UNIQUE sur ingestion_runs. Une seule ligne
--  status='running' par engine peut exister. C'est PostgreSQL qui
--  arbitre, pas un booléen applicatif : deux Workers concurrents ne
--  peuvent pas gagner tous les deux.
--
--  PRÉREQUIS : migration 0002 (création de ingestion_runs).
--  IDEMPOTENTE : réexécutable sans effet de bord.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Le moteur marché doit pouvoir écrire dans ingestion_runs.
--    La colonne `engine` est libre (TEXT sans CHECK) : aucune
--    modification de contrainte n'est nécessaire. On documente
--    seulement les valeurs attendues.
-- ---------------------------------------------------------------------
COMMENT ON COLUMN ingestion_runs.engine IS
  'Moteur émetteur : news_engine | market_engine | ai_committee.';

-- ---------------------------------------------------------------------
-- 2. VERROU D'EXÉCUTION
--    Un seul run actif par moteur. Toute tentative concurrente lève
--    23505, que le moteur interprète comme SKIPPED.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_ingestion_runs_active
  ON ingestion_runs (engine)
  WHERE status = 'running';

COMMENT ON INDEX uq_ingestion_runs_active IS
  'Verrou anti-concurrence : un seul run actif par moteur. '
  'Une violation 23505 signifie "run déjà en cours", pas une erreur.';

-- ---------------------------------------------------------------------
-- 3. RÉCUPÉRATION DES VERROUS ABANDONNÉS
--    Un Worker tué (timeout plateforme, OOM, redéploiement) laisse une
--    ligne 'running' orpheline qui bloquerait le moteur indéfiniment.
--    Cette fonction la marque 'failed' au-delà d'un seuil.
--
--    Appelée par le moteur avant chaque acquisition de verrou.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_reclaim_stale_runs(
  p_engine              TEXT,
  p_older_than_minutes  INTEGER DEFAULT 15
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reclaimed INTEGER;
BEGIN
  IF p_older_than_minutes IS NULL OR p_older_than_minutes <= 0 THEN
    RAISE EXCEPTION 'p_older_than_minutes doit être strictement positif';
  END IF;

  UPDATE ingestion_runs
     SET status      = 'failed',
         finished_at = now(),
         duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at))::INTEGER * 1000),
         errors      = errors || jsonb_build_array(
                         format('Verrou abandonné récupéré après %s minutes.',
                                p_older_than_minutes))
   WHERE engine = p_engine
     AND status = 'running'
     AND started_at < now() - make_interval(mins => p_older_than_minutes);

  GET DIAGNOSTICS v_reclaimed = ROW_COUNT;
  RETURN v_reclaimed;
END;
$$;

COMMENT ON FUNCTION fn_reclaim_stale_runs IS
  'Libère un verrou laissé par un Worker interrompu. Idempotente.';

-- Seul le service_role (moteurs backend) peut manipuler les verrous.
REVOKE ALL ON FUNCTION fn_reclaim_stale_runs(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_reclaim_stale_runs(TEXT, INTEGER) TO service_role;

-- ---------------------------------------------------------------------
-- 4. Observabilité : dernier run par moteur.
--    Réservée au service_role et aux utilisateurs authentifiés :
--    l'état d'exploitation interne n'a pas à être public.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_engine_last_run AS
SELECT DISTINCT ON (engine)
  engine, id AS run_id, trigger_type, status,
  started_at, finished_at, duration_ms,
  fetched_count, rejected_count, persisted_count, duplicate_count,
  providers, errors
FROM ingestion_runs
ORDER BY engine, started_at DESC;

GRANT SELECT ON v_engine_last_run TO authenticated, service_role;

COMMIT;

-- =====================================================================
-- VÉRIFICATION POST-MIGRATION
--   SELECT indexname FROM pg_indexes WHERE indexname = 'uq_ingestion_runs_active';
--   SELECT fn_reclaim_stale_runs('market_engine', 15);
--   SELECT * FROM v_engine_last_run;
-- =====================================================================
