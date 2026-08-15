-- =====================================================================
--  ALPHA-XAU — database/migrations/0005_committee_events.sql
--
--  Correctif P0-EVENT-DRIVEN (partie base).
--
--  OBJET : idempotence et traçabilité des déclenchements event-driven
--  du comité IA.
--
--  RÉUTILISATION AVANT CRÉATION — justification de la nouvelle table.
--  Les structures existantes ont été examinées :
--    - news_events.notified_at / notify_attempts tracent l'ÉMISSION d'une
--      notification par le news_engine, pas sa CONSOMMATION par le comité.
--      Un événement peut être émis puis perdu ; la colonne ne le dirait pas.
--    - ingestion_runs trace une EXÉCUTION de moteur, pas un ÉVÉNEMENT. Sa
--      clé primaire est un UUID généré, sans contrainte sur un identifiant
--      externe : elle ne peut porter aucune garantie d'idempotence.
--  Aucune ne peut donc garantir « le même event_id ne déclenche qu'un seul
--  recalcul ». La table ci-dessous est le support minimal de cette
--  propriété, et rien de plus.
--
--  PRÉREQUIS : schema.sql (ai_analyses, news_events), migration 0004.
--  IDEMPOTENTE : réexécutable sans effet de bord.
-- =====================================================================

BEGIN;

-- Types d'événements reconnus par le comité. Tout autre type est rejeté
-- par le contrat TypeScript AVANT d'atteindre la base ; le CHECK est la
-- seconde barrière, celle qui ne peut pas être contournée.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'committee_event_t') THEN
    CREATE TYPE committee_event_t AS ENUM ('RECALC_H1_H2', 'REEVALUATE_H3');
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'committee_event_status_t') THEN
    CREATE TYPE committee_event_status_t AS ENUM (
      'RUNNING',            -- verrou pris, traitement en cours
      'PROCESSED',          -- analyse produite et persistée
      'SKIPPED_NO_CHANGE',  -- traité sans production (ex. NO_VALID_SETUP)
      'DATA_UNAVAILABLE',   -- contexte marché insuffisant
      'FAILED'              -- échec technique
    );
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS ai_events (
  -- Identifiant fourni par l'ÉMETTEUR (news_engine). C'est lui, et non un
  -- UUID généré ici, qui porte l'idempotence : deux livraisons du même
  -- événement partagent cet identifiant.
  event_id        TEXT PRIMARY KEY
                    CHECK (length(btrim(event_id)) BETWEEN 1 AND 200),

  event_type      committee_event_t        NOT NULL,
  status          committee_event_status_t NOT NULL DEFAULT 'RUNNING',
  source          TEXT                     NOT NULL,

  -- Horodatage porté par l'événement lui-même (émission).
  triggered_at    TIMESTAMPTZ NOT NULL,
  -- Horodatages du traitement.
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),

  news_event_id   UUID,
  news_score      NUMERIC(6,2) CHECK (news_score IS NULL OR news_score BETWEEN 0 AND 100),
  analysis_id     UUID,

  error           TEXT,

  CONSTRAINT chk_ai_events_finish
    CHECK (finished_at IS NULL OR finished_at >= started_at),

  -- Un événement terminé doit porter une issue explicite : jamais RUNNING.
  CONSTRAINT chk_ai_events_terminal
    CHECK (finished_at IS NULL OR status <> 'RUNNING'),

  -- Une issue PROCESSED doit référencer l'analyse produite. Sans cela, la
  -- traçabilité serait déclarative et invérifiable.
  CONSTRAINT chk_ai_events_processed_has_analysis
    CHECK (status <> 'PROCESSED' OR analysis_id IS NOT NULL),

  CONSTRAINT fk_ai_events_news
    FOREIGN KEY (news_event_id) REFERENCES news_events (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_ai_events_analysis
    FOREIGN KEY (analysis_id) REFERENCES ai_analyses (id)
    ON UPDATE CASCADE ON DELETE SET NULL
);

COMMENT ON TABLE ai_events IS
  'Journal des déclenchements event-driven du comité. La PK event_id '
  'garantit qu''un même événement ne provoque jamais deux recalculs.';
COMMENT ON COLUMN ai_events.event_id IS
  'Identifiant émis par le news_engine. Support de l''idempotence : une '
  'seconde livraison lève 23505, interprétée comme ALREADY_PROCESSED.';

CREATE INDEX IF NOT EXISTS idx_ai_events_received
  ON ai_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_events_failed
  ON ai_events (received_at DESC)
  WHERE status IN ('FAILED', 'DATA_UNAVAILABLE');
CREATE INDEX IF NOT EXISTS idx_ai_events_news
  ON ai_events (news_event_id)
  WHERE news_event_id IS NOT NULL;

-- Écriture réservée aux moteurs backend. Lecture d'exploitation seulement :
-- le journal des déclenchements n'a pas à être public.
ALTER TABLE ai_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ai_events' AND policyname = 'p_ai_events_read'
  ) THEN
    CREATE POLICY p_ai_events_read ON ai_events
      FOR SELECT TO authenticated USING (true);
  END IF;
END;
$$;

GRANT SELECT ON ai_events TO authenticated;
GRANT ALL    ON ai_events TO service_role;

COMMIT;

-- =====================================================================
-- VÉRIFICATION POST-MIGRATION
--   INSERT INTO ai_events (event_id, event_type, source, triggered_at)
--     VALUES ('NEWS-123', 'RECALC_H1_H2', 'news_engine', now());
--   -- La même insertion doit lever 23505.
-- =====================================================================
