-- =====================================================================
--  ALPHA-XAU INSTITUTIONAL TERMINAL
--  database/migrations/0003_news_notification_tracking.sql
--
--  MOTIF : dispatchActions() notifie AI_ENGINE_URL en best-effort HTTP.
--  Un échec réseau ne fait perdre aucune donnée (news_events/alerts sont
--  déjà persistées), mais laissait la notification sans filet : rien ne
--  rejouait un événement CATALYST CRITICAL / MAJOR IMPACT non acquitté.
--
--  DÉCISION D'ARCHITECTURE : pas de Cloudflare Queues. Le stack autorise
--  Cloudflare Workers OU Vercel Functions ; les Queues n'existent que sur
--  Cloudflare et casseraient silencieusement la portabilité Vercel pour
--  un simple ping de réveil. La base reste la file durable unique,
--  cohérente sur les deux runtimes, sans dépendance supplémentaire.
--
--  Idempotente, transactionnelle.
-- =====================================================================

BEGIN;

ALTER TABLE news_events
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notify_attempts SMALLINT NOT NULL DEFAULT 0
    CHECK (notify_attempts >= 0);

COMMENT ON COLUMN news_events.notified_at IS
  'Horodatage de la notification réussie au moteur IA. NULL = jamais acquittée, candidate à la sweep de réconciliation.';
COMMENT ON COLUMN news_events.notify_attempts IS
  'Compteur de tentatives de notification. Plafonné côté application pour éviter un événement bloqué en boucle infinie.';

-- File de la sweep : actions exigeant un recalcul, jamais notifiées.
-- L'index ne porte que sur ce sous-ensemble : il reste minuscule quel
-- que soit le volume total de news_events.
CREATE INDEX IF NOT EXISTS idx_news_events_unnotified
  ON news_events (ts DESC)
  WHERE action <> 'ARCHIVE_ONLY' AND notified_at IS NULL;

-- Vue consommée par la sweep de réconciliation. Fenêtre de grâce de 90s :
-- laisse le temps au chemin HTTP direct d'aboutir avant de le considérer
-- en échec (évite une notification en double sur simple latence réseau).
CREATE OR REPLACE VIEW v_news_pending_notification AS
SELECT id, title, action, news_score, classification, ts, notify_attempts
FROM news_events
WHERE action <> 'ARCHIVE_ONLY'
  AND notified_at IS NULL
  AND ts < now() - INTERVAL '90 seconds'
  -- Au-delà de 10 tentatives, l'incident relève du monitoring (alerte
  -- 'system' dédiée), pas d'un nouveau rejeu automatique.
  AND notify_attempts < 10
ORDER BY news_score DESC, ts ASC;

GRANT SELECT ON v_news_pending_notification TO service_role, authenticated;

COMMIT;
