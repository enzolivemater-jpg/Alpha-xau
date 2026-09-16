-- =====================================================================
--  ALPHA-XAU — database/migrations/0022_event_shadow_candidate_discovery.sql
--
--  OPS-023 PR8 — Deterministic, READ-ONLY, STATE-DERIVED candidate
--  discovery for the Event Shadow pipeline.
--
--  OBJET : répondre à UNE seule question — "quelles observations RAW
--  sont sûres et nécessaires à envoyer dans le chemin déjà prouvé
--  PR7/PR6/PR5 ?" — sans jamais exécuter cette décision. Cette migration
--  n'introduit AUCUNE mutation d'Event, AUCUN cron, AUCUN wiring
--  runtime. Le SEUL objet ajouté est une fonction PostgreSQL en
--  LECTURE SEULE.
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - les migrations 0001-0021 (fichiers immuables — NON modifiées) ;
--    - aucune table existante, aucune contrainte, aucun trigger, aucune
--      policy RLS, aucun grant de table (seuls des GRANT/REVOKE de
--      fonction sont introduits ici) ;
--    - fn_event_assign_observation / fn_event_create_event_version /
--      toute autre RPC de mutation Event (jamais appelées ici) ;
--    - le pipeline legacy, worker.ts, wrangler.toml, le frontend, ou
--      toute configuration Cloudflare.
--
--  POURQUOI "STATE-DERIVED", JAMAIS UN CURSEUR/WATERMARK :
--  la récupération live PR7 (membership fondatrice committée, Event
--  Version manquante, 4 observations, 4x HTTP 400) a prouvé qu'une
--  observation RAW peut avoir une membership committée alors que son
--  Event Version reste manquante. Un curseur temporel (last_processed_at,
--  fenêtre observed_at/ingested_at, "N plus récents") peut dépasser cet
--  état incomplet DE FAÇON PERMANENTE — l'observation ne serait plus
--  jamais redécouverte. C'est exactement l'incident qui a motivé PR7 et
--  sa migration de precision (voir PR #25). Cette fonction ne persiste
--  donc AUCUNE position de scan : l'état Event lui-même (existence de
--  membership, existence de preuve d'Event Version) détermine si une
--  observation reste découvrable. Les candidats complétés disparaissent
--  naturellement de la découverte parce que l'état Event est append-only ;
--  les échecs partiels (membership seule) restent naturellement visibles
--  en RECOVERY.
--
--  DEUX VOIES EXACTES (V1) :
--
--    FRESH — observation éligible PR4 V1 ET AUCUNE ligne
--    event_observation_memberships pour cette observation_id (pas
--    seulement "pas de membership courante" — ZÉRO historique, garantit
--    la compatibilité avec CREATE_NEW_CLUSTER V1 de PR5).
--
--    RECOVERY — observation éligible PR4 V1, EXACTEMENT une décision de
--    membership au total, cette décision est une ASSIGN fondatrice
--    encore courante (supersedes_decision_id IS NULL, aucune décision
--    successrice), produite par EXACTEMENT le chemin PR5 V1
--    (membership_method/algorithm_version/decision_actor et topologie
--    de cluster attendus), et AUCUNE ligne event_version_evidence ne
--    référence cette decision_id. C'est exactement la forme prouvée de
--    récupération PR5 "réponse HTTP perdue / commit partiel".
--
--  AUTORITÉ DE COMPLÉTION : event_version_evidence.decision_id est la
--  SEULE preuve qu'une décision de membership a été matérialisée par une
--  Event Version — jamais l'existence du cluster, jamais le nombre
--  d'event_versions du cluster, jamais le statut d'ingestion_runs,
--  jamais un âge de timestamp.
--
--  PROTECTION D'ABSTENTION PERMANENTE : le prédicat d'éligibilité ici
--  reflète EXACTEMENT l'univers traitable actuel de PR4 V1
--  (backend/event_engine/deterministic_processor.ts) — tuples de source
--  officielle vérifiée, mapping de catégorie exact par autorité, et
--  sémantique EXACTE de la porte qualité (VALID sans raison, ou DEGRADED
--  avec au moins une raison, toutes dans l'allowlist figée). Une
--  observation que PR4 V1 abstiendrait pour toujours (mauvaise source,
--  catégorie non supportée, qualité insuffisante) n'occupe jamais un
--  emplacement de candidat automatique.
--
--  SÉCURITÉ : SECURITY INVOKER (jamais DEFINER), SET search_path = ''
--  dès la création, EXECUTE explicitement révoqué de PUBLIC/anon/
--  authenticated puis accordé à service_role uniquement — même
--  discipline que 0014/0016/0017/0018/0019/0020. STABLE : aucune
--  écriture, aucun SQL dynamique, aucune horloge, aucune valeur
--  aléatoire — même liste d'arguments -> même résultat dans une même
--  transaction.
--
--  AUCUN CURSEUR : pas de table de position de scan. Voir ci-dessus.
--
--  TRANSACTIONNELLE : BEGIN ... COMMIT. IDEMPOTENTE (fichier) :
--  CREATE OR REPLACE FUNCTION — rejouable sans effet si déjà appliquée.
--
--  PRÉREQUIS : migrations 0009 (news_articles), 0012 (event_clusters /
--  event_observation_memberships / event_version_evidence).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- fn_event_shadow_discover_candidates(p_lane, p_limit)
--
--   RETURNS TABLE (
--     observation_id                 UUID,
--     lane                           TEXT,
--     ingested_at                    TIMESTAMPTZ,
--     cluster_id                     UUID,   -- NULL pour FRESH
--     decision_id                    UUID,   -- NULL pour FRESH
--     assigned_at                    TIMESTAMPTZ,  -- NULL pour FRESH
--     expected_processor_version     TEXT,
--     expected_orchestrator_version  TEXT
--   )
--
--   p_lane doit être EXACTEMENT 'FRESH' ou 'RECOVERY' — toute autre
--   valeur échoue fermé (RAISE EXCEPTION). p_limit doit être compris
--   entre 1 et 25 inclus — toute autre valeur échoue fermé.
--
--   expected_processor_version / expected_orchestrator_version sont des
--   CONSTANTES retournées intentionnellement : elles gèlent la version
--   du processeur/orchestrateur PR4/PR5 sous laquelle CETTE découverte a
--   été conçue. Un futur changement de version processeur/orchestrateur
--   doit faire échouer fermé la consommation de ces candidats côté
--   application (comparaison stricte contre OPS023_EVENT_PROCESSOR_VERSION
--   / OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION) jusqu'à réexamen explicite
--   de cette découverte — jamais une resynchronisation silencieuse.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_shadow_discover_candidates(
  p_lane   TEXT,
  p_limit  INTEGER DEFAULT 25
)
RETURNS TABLE (
  observation_id                 UUID,
  lane                           TEXT,
  ingested_at                    TIMESTAMPTZ,
  cluster_id                     UUID,
  decision_id                    UUID,
  assigned_at                    TIMESTAMPTZ,
  expected_processor_version     TEXT,
  expected_orchestrator_version  TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  -- Ensemble de caractères EXACTEMENT équivalent à ECMAScript
  -- String.prototype.trim() (WhiteSpace + LineTerminator), jamais la
  -- locale du serveur PostgreSQL ni le simple espace ASCII de btrim()
  -- à un argument. btrim(text, v_js_trim_chars) doit produire EXACTEMENT
  -- le même résultat que `providerCategory.trim()` côté PR4
  -- (backend/event_engine/deterministic_processor.ts). Voir §4/§5 de la
  -- revue indépendante : \0009 \000B \000C \FEFF (WhiteSpace hors espace),
  -- \0020 \00A0 \1680 \2000-\200A \202F \205F \3000 (Space_Separator
  -- Unicode), \000A \000D \2028 \2029 (LineTerminator).
  v_js_trim_chars CONSTANT TEXT :=
    U&'\0009\000B\000C\FEFF\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000\000A\000D\2028\2029';
BEGIN
  IF p_lane IS NULL OR p_lane NOT IN ('FRESH', 'RECOVERY') THEN
    RAISE EXCEPTION
      'fn_event_shadow_discover_candidates : p_lane doit être exactement ''FRESH'' ou ''RECOVERY'', reçu %',
      p_lane;
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 25 THEN
    RAISE EXCEPTION
      'fn_event_shadow_discover_candidates : p_limit doit être compris entre 1 et 25 inclus, reçu %',
      p_limit;
  END IF;

  IF p_lane = 'FRESH' THEN
    RETURN QUERY
    SELECT
      n.id                                        AS observation_id,
      'FRESH'::TEXT                                AS lane,
      n.ingested_at                                AS ingested_at,
      NULL::UUID                                   AS cluster_id,
      NULL::UUID                                   AS decision_id,
      NULL::TIMESTAMPTZ                            AS assigned_at,
      'ops023-deterministic-event-processor-v1'::TEXT   AS expected_processor_version,
      'ops023-event-shadow-orchestrator-v1'::TEXT       AS expected_orchestrator_version
    FROM public.news_articles n
    WHERE
      -- Tuples de source officielle vérifiée EXACTS (0012/deterministic_processor.ts).
      (
        (n.provider = 'federal_reserve' AND n.source_code = 'federalreserve' AND n.source_domain = 'federalreserve.gov')
        OR (n.provider = 'ecb' AND n.source_code = 'ecb' AND n.source_domain = 'ecb.europa.eu')
        OR (n.provider = 'us_treasury' AND n.source_code = 'us_treasury' AND n.source_domain = 'home.treasury.gov')
        OR (n.provider = 'ofac' AND n.source_code = 'ofac' AND n.source_domain = 'ofac.treasury.gov')
      )
      -- Mapping de catégorie EXACT par autorité (resolveEventType()) :
      -- btrim() à DEUX arguments avec v_js_trim_chars, jamais btrim() à un
      -- seul argument (espace ASCII uniquement) — équivalence stricte avec
      -- `providerCategory.trim()` côté PR4 (voir DECLARE ci-dessus).
      AND (
        (n.source_code = 'federalreserve' AND btrim(n.provider_category, v_js_trim_chars) IN ('monetary_policy_press_release', 'speech'))
        OR (n.source_code = 'ecb' AND btrim(n.provider_category, v_js_trim_chars) IN ('press_communication', 'statistical_press_release'))
        OR (n.source_code = 'us_treasury' AND btrim(n.provider_category, v_js_trim_chars) = 'press_release')
        OR (n.source_code = 'ofac' AND n.provider_category IS NOT NULL AND length(btrim(n.provider_category, v_js_trim_chars)) > 0)
      )
      -- Porte qualité PR4 V1 EXACTE (passesQualityGate()) : VALID sans
      -- raison, OU DEGRADED avec au moins une raison, toutes dans
      -- l'allowlist figée. UNVERIFIED n'est jamais traitable. DEGRADED
      -- exige aussi array_ndims(...) = 1 : un tableau multidimensionnel
      -- (jamais produit par PR4, qui itère reasons.every(...) sur un
      -- tableau JS plat de chaînes) ne doit jamais être flatté par
      -- unnest() puis accepté à tort — PostgREST représenterait un
      -- élément multidimensionnel comme un Array JS imbriqué, que
      -- Set.has() côté PR4 rejette toujours.
      AND (
        (n.ingest_quality_state = 'VALID' AND cardinality(n.ingest_quality_reasons) = 0)
        OR (
          n.ingest_quality_state = 'DEGRADED'
          AND cardinality(n.ingest_quality_reasons) > 0
          AND array_ndims(n.ingest_quality_reasons) = 1
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(n.ingest_quality_reasons) AS quality_reason(reason)
            WHERE
              quality_reason.reason IS NULL
              OR quality_reason.reason NOT IN (
                'publication_timestamp_parse_failed',
                'publication_date_parse_failed',
                'publication_precision_unknown'
              )
          )
        )
      )
      -- FRESH : ZÉRO ligne de membership au total pour cette observation
      -- (pas seulement "pas de membership courante").
      AND NOT EXISTS (
        SELECT 1
        FROM public.event_observation_memberships m
        WHERE m.observation_id = n.id
      )
    ORDER BY n.ingested_at ASC, n.id ASC
    LIMIT p_limit;

  ELSIF p_lane = 'RECOVERY' THEN
    RETURN QUERY
    SELECT
      n.id                                        AS observation_id,
      'RECOVERY'::TEXT                             AS lane,
      n.ingested_at                                AS ingested_at,
      m.cluster_id                                 AS cluster_id,
      m.decision_id                                AS decision_id,
      m.assigned_at                                AS assigned_at,
      'ops023-deterministic-event-processor-v1'::TEXT   AS expected_processor_version,
      'ops023-event-shadow-orchestrator-v1'::TEXT       AS expected_orchestrator_version
    FROM public.news_articles n
    JOIN public.event_observation_memberships m ON m.observation_id = n.id
    JOIN public.event_clusters c ON c.id = m.cluster_id
    WHERE
      (
        (n.provider = 'federal_reserve' AND n.source_code = 'federalreserve' AND n.source_domain = 'federalreserve.gov')
        OR (n.provider = 'ecb' AND n.source_code = 'ecb' AND n.source_domain = 'ecb.europa.eu')
        OR (n.provider = 'us_treasury' AND n.source_code = 'us_treasury' AND n.source_domain = 'home.treasury.gov')
        OR (n.provider = 'ofac' AND n.source_code = 'ofac' AND n.source_domain = 'ofac.treasury.gov')
      )
      AND (
        (n.source_code = 'federalreserve' AND btrim(n.provider_category, v_js_trim_chars) IN ('monetary_policy_press_release', 'speech'))
        OR (n.source_code = 'ecb' AND btrim(n.provider_category, v_js_trim_chars) IN ('press_communication', 'statistical_press_release'))
        OR (n.source_code = 'us_treasury' AND btrim(n.provider_category, v_js_trim_chars) = 'press_release')
        OR (n.source_code = 'ofac' AND n.provider_category IS NOT NULL AND length(btrim(n.provider_category, v_js_trim_chars)) > 0)
      )
      AND (
        (n.ingest_quality_state = 'VALID' AND cardinality(n.ingest_quality_reasons) = 0)
        OR (
          n.ingest_quality_state = 'DEGRADED'
          AND cardinality(n.ingest_quality_reasons) > 0
          AND array_ndims(n.ingest_quality_reasons) = 1
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(n.ingest_quality_reasons) AS quality_reason(reason)
            WHERE
              quality_reason.reason IS NULL
              OR quality_reason.reason NOT IN (
                'publication_timestamp_parse_failed',
                'publication_date_parse_failed',
                'publication_precision_unknown'
              )
          )
        )
      )
      -- RECOVERY doit être STRICTEMENT plus étroit que "membership
      -- existe et Event Version manquante" : EXACTEMENT une décision de
      -- membership au total pour cette observation.
      AND (
        SELECT count(*)
        FROM public.event_observation_memberships m2
        WHERE m2.observation_id = n.id
      ) = 1
      -- Cette décision unique est une ASSIGN fondatrice encore courante.
      AND m.decision_type = 'ASSIGN'
      AND m.supersedes_decision_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.event_observation_memberships succ
        WHERE succ.supersedes_decision_id = m.decision_id
      )
      -- Produite par EXACTEMENT le chemin PR5 V1 (jamais une autre
      -- méthode/version/acteur de décision).
      AND m.membership_method = 'DETERMINISTIC_OFFICIAL_FOUNDING_V1'
      AND m.algorithm_version = 'ops023-event-shadow-orchestrator-v1'
      AND m.decision_actor = 'xau_v2:event_shadow:v1'
      -- Topologie de cluster fondateur EXACTE de PR5 V1
      -- (CREATE_NEW_CLUSTER, clé provisoire déterministe).
      AND c.first_observation_id = n.id
      AND c.algorithm_version = 'ops023-deterministic-event-processor-v1'
      AND c.cluster_key = 'provisional:' || n.id::text
      -- Décision fondatrice PAS ENCORE matérialisée par une Event
      -- Version — event_version_evidence.decision_id est la SEULE
      -- autorité de complétion.
      AND NOT EXISTS (
        SELECT 1
        FROM public.event_version_evidence ev
        WHERE ev.decision_id = m.decision_id
      )
    ORDER BY n.ingested_at ASC, n.id ASC
    LIMIT p_limit;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_event_shadow_discover_candidates(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_event_shadow_discover_candidates(TEXT, INTEGER) TO service_role;

COMMENT ON FUNCTION public.fn_event_shadow_discover_candidates IS
  'OPS-023 PR8 — découverte de candidats Event Shadow en LECTURE SEULE, state-derived (aucun curseur/watermark persisté). p_lane ∈ {FRESH, RECOVERY} uniquement, p_limit ∈ [1,25]. FRESH = observation éligible PR4 V1 sans AUCUNE ligne event_observation_memberships. RECOVERY = observation éligible PR4 V1 avec EXACTEMENT une décision de membership, une ASSIGN fondatrice encore courante produite par le chemin PR5 V1 exact, dont la decision_id n''est référencée par AUCUNE ligne event_version_evidence. Jamais de mutation, jamais de SQL dynamique, jamais d''horloge ni de valeur aléatoire. SECURITY INVOKER, EXECUTE réservé à service_role.';

COMMIT;
