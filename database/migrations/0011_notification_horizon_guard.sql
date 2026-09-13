-- =====================================================================
--  ALPHA-XAU — database/migrations/0011_notification_horizon_guard.sql
--
--  CORRECTIF P0-A (XAU-V2-OPS-014/015) : horizon de notification.
--
--  MOTIF : v_news_pending_notification (migration 0003) ordonne les
--  candidats par news_score DESC, ts ASC, sans aucune notion d'horizon.
--  L'ingestion accepte des articles jusqu'à 48h d'âge (CONFIG.MAX_ARTICLE_
--  AGE_MS, backend/ingest.ts), mais la validité d'une notification est
--  bien plus courte : au-delà de son horizon, l'action déclenchée
--  (RECALC_H1_H2 / REEVALUATE_H3) recalculerait des scénarios sur un
--  contexte de marché qui n'a plus de rapport avec la situation actuelle.
--  Preuve en production (audit XAU-V2-OPS-013) : une ligne vieille de
--  plus de 24h surclassait une ligne plus fraîche de même action, au seul
--  motif d'un score légèrement supérieur — la vue n'avait aucun moyen de
--  l'exclure.
--
--  CONTRAT D'HORIZON (fixé, ne pas modifier silencieusement) :
--    RECALC_H1_H2   valide au maximum 4h  (borne incluse)
--    REEVALUATE_H3  valide au maximum 24h (borne incluse)
--    ARCHIVE_ONLY   jamais notifié (déjà exclu par le prédicat existant)
--
--  Un événement expiré par cet horizon :
--    - ne consomme jamais le budget de notification (NotifyBudget) ;
--    - ne fait jamais incrémenter notify_attempts ;
--    - n'est jamais marqué notified_at ;
--    - reste une ligne historique ordinaire dans news_events, inchangée.
--  Aucun état terminal EXPIRED n'est introduit ici : l'exclusion de la
--  vue suffit à garantir les trois propriétés ci-dessus. Un état
--  d'accounting dédié, s'il devient nécessaire, sera une migration
--  séparée (cf. audit XAU-V2-OPS-014).
--
--  DÉFENSE EN PROFONDEUR : backend/ingest.ts (notifyAiEngine) applique
--  INDÉPENDAMMENT la même règle d'horizon, avec les mêmes constantes,
--  pour protéger le chemin de dispatch direct — qui ne lit jamais cette
--  vue, puisqu'il travaille sur les news tout juste persistées du cycle
--  en cours — au cas où celles-ci seraient déjà, par construction
--  improbable mais non exclue en théorie (horloge, retard d'ingestion),
--  hors horizon dès leur premier tick. La vue reste néanmoins la seule
--  source AUTORITATIVE pour la sweep de réconciliation.
--
--  Prédicats et colonnes de sortie PRÉSERVÉS à l'identique par rapport à
--  la migration 0003 : seul le nouveau prédicat d'horizon est ajouté.
--  IDEMPOTENTE (CREATE OR REPLACE VIEW). Aucune autre table, aucun
--  nouvel enum, aucune UPDATE historique.
-- =====================================================================

BEGIN;

CREATE OR REPLACE VIEW v_news_pending_notification AS
SELECT id, title, action, news_score, classification, ts, notify_attempts
FROM news_events
WHERE action <> 'ARCHIVE_ONLY'
  AND notified_at IS NULL
  AND ts < now() - INTERVAL '90 seconds'
  -- Au-delà de 10 tentatives, l'incident relève du monitoring (alerte
  -- 'system' dédiée), pas d'un nouveau rejeu automatique.
  AND notify_attempts < 10
  -- Horizon de notification (P0-A) : un événement plus vieux que la
  -- validité de son action n'est plus un candidat, quel que soit son
  -- score ou son nombre de tentatives restantes.
  AND (
    (action = 'RECALC_H1_H2'
      AND ts >= now() - INTERVAL '4 hours')
    OR
    (action = 'REEVALUATE_H3'
      AND ts >= now() - INTERVAL '24 hours')
  )
ORDER BY news_score DESC, ts ASC;

-- Réaffirmation explicite des grants existants (migration 0003) : un
-- CREATE OR REPLACE VIEW ne les retire pas en pratique, mais les
-- redéclarer ici documente le contrat attendu sans dépendre d'un
-- comportement implicite de PostgreSQL.
GRANT SELECT ON v_news_pending_notification TO service_role, authenticated;

COMMIT;

-- =====================================================================
-- VÉRIFICATION POST-MIGRATION
--   -- Doit rester inchangé (prédicats 0003 seuls) :
--   SELECT count(*) FROM v_news_pending_notification;
--   -- Aucune ligne d'âge > horizon de son action ne doit apparaître :
--   SELECT count(*) FROM v_news_pending_notification
--    WHERE (action = 'RECALC_H1_H2'  AND ts < now() - INTERVAL '4 hours')
--       OR (action = 'REEVALUATE_H3' AND ts < now() - INTERVAL '24 hours');
--   -- attendu : 0
-- =====================================================================
