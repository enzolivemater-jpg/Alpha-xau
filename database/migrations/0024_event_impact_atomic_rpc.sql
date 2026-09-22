-- =====================================================================
--  ALPHA-XAU — database/migrations/0024_event_impact_atomic_rpc.sql
--
--  OBJET : PR-EI-2 — primitif transactionnel de persistance ATOMIQUE
--  d'une évaluation Event Impact, sur les tables déjà gelées et
--  live-proven (0023) :
--
--    EVENT VERSION (public.event_versions, INCHANGÉE)
--      -> EVENT IMPACT ASSESSMENT      (event_impact_assessments)
--      -> EVENT IMPACT INTERPRETATION  (event_impact_interpretations)
--
--  CETTE MIGRATION N'INTRODUIT AUCUNE :
--    - logique domaine Event Impact — direction/magnitude/confiance/
--      horizon/pricing_state sont des FAITS DÉJÀ DÉCIDÉS par l'appelant,
--      jamais calculés ici ; aucune règle news_score/expected_move_usd/
--      gold_direction_impact/classification/probabilité Comité/cible
--      Comité/market_regime, aucune inférence Gold Transmission ;
--    - route Worker / runtime HTTP authentifié, aucun endpoint ;
--    - déclenchement planifié récurrent / cron ;
--    - découverte (discovery) ou backfill automatique ;
--    - intégration Committee, Portfolio Manager, Risk Committee ;
--    - dépendance à un fournisseur LLM externe d'aucune sorte ;
--    - ligne de donnée Event Impact réelle (aucun INSERT exécuté par
--      cette tâche — DDL de dépôt uniquement) ;
--    - application live contre Supabase (voir §"AUCUNE ACTION LIVE" en
--      pied de fichier).
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - la migration 0023 (fichier immuable, déjà appliqué en
--      production — NON modifiée, aucune table/contrainte/trigger/
--      policy/grant de table existant n'est touché) ;
--    - database/schema.sql (dette de parité préexistante et
--      indépendante, hors périmètre — voir 0023) ;
--    - le pipeline legacy news_events, ni les scénarios Committee.
--
--  UNE SEULE RPC : public.fn_event_impact_create_assessment(...).
--  AUCUNE seconde RPC de mutation. Aucun UPDATE, aucun DELETE, aucune
--  RPC de runtime/discovery.
--
--  RESPONSABILITÉ : persister ATOMIQUEMENT, dans UNE SEULE transaction,
--  EXACTEMENT une ligne event_impact_assessments PUIS (jamais avant)
--  zéro ou plusieurs lignes event_impact_interpretations. Le parent est
--  TOUJOURS inséré avant les enfants — cette RPC ne tente JAMAIS une
--  persistance enfant-d'abord. Pour assessment_status=ASSESSED, au
--  moins une interprétation est exigée ; pour INSUFFICIENT_EVIDENCE/
--  UNAVAILABLE, le tableau d'interprétations doit être vide. La
--  migration 0023 reste l'AUTORITÉ FINALE de ces invariants (BEFORE
--  INSERT + CONSTRAINT TRIGGER DEFERRABLE) — cette RPC les valide en
--  amont uniquement pour produire une erreur claire tôt, jamais pour
--  dupliquer/concurrencer le vocabulaire figé de 0023 (assessment
--  statuses, producer types, horizons, directions, magnitude/confidence
--  states, pricing states — TOUS possédés par 0023 exclusivement).
--
--  CONTRAT JSON ENFANT (p_interpretations) : tableau JSON obligatoire
--  (racine non-tableau rejetée), chaque élément un objet JSON
--  obligatoire (membre non-objet rejeté), clés EXACTEMENT autorisées :
--  horizon, interpretation_key, interpretation_role, direction,
--  magnitude_state, magnitude_value, magnitude_unit, magnitude_basis,
--  confidence_state, confidence_value, pricing_state, rationale. Toute
--  clé inconnue/fautive est rejetée explicitement, jamais absorbée
--  silencieusement. Les champs nullable manquants et une valeur JSON
--  `null` explicite normalisent de façon équivalente (extraction via
--  l'opérateur ->>, qui retourne NULL dans les deux cas).
--
--  NORMALISATION CANONIQUE : chaque interprétation candidate est
--  normalisée en un objet JSONB portant les DOUZE champs Event Impact,
--  puis le tableau canonique est trié de façon déterministe par
--  (horizon, interpretation_key, interpretation_role — cette troisième
--  clé en simple garde-fou de déterminisme, l'identité logique
--  (assessment_id, horizon, interpretation_key) étant déjà exclusive
--  par contrainte 0023). L'ordre du tableau d'entrée p_interpretations
--  N'AFFECTE JAMAIS le résultat de comparaison de rejeu — seule la
--  forme canonique triée est comparée.
--
--  AUTORITÉ D'IDEMPOTENCE : l'index UNIQUE existant
--  uq_event_impact_assessments_idempotency (0023) reste l'AUTORITÉ DE
--  BASE DE DONNÉES. INSERT ... ON CONFLICT (idempotency_fingerprint) DO
--  NOTHING — jamais un pré-check suivi d'un INSERT non protégé par
--  cette contrainte. Sous appels concurrents strictement identiques,
--  l'index UNIQUE sérialise/résout la collision : l'un des deux devient
--  créateur (INSERT réussit), l'autre bloque puis, une fois le premier
--  committé, échoue le conflit et est récupéré comme REPLAYED=true —
--  aucun mutex applicatif, aucun nouveau verrou global introduit ici.
--  Si la première transaction ROLLBACK, l'index UNIQUE libère la
--  contrainte et le second appel reste capable de devenir le créateur.
--
--  ORDRE : validation de forme (tableau/objet/clés) -> cohérence
--  statut/enfants -> normalisation canonique -> pré-check
--  d'idempotence (chemin rapide, avant tentative d'INSERT) -> INSERT
--  parent protégé par ON CONFLICT DO NOTHING -> SI créé : INSERT des
--  enfants normalisés (même transaction, échec enfant = ROLLBACK
--  complet de l'appel) -> SI conflit (course concurrente manquée par le
--  pré-check) : récupération post-conflit, même comparaison stricte.
--  Toute divergence de champ parent OU d'enfants canoniques entre la
--  ligne déjà committée et cette requête lève EVENT_IMPACT_IDEMPOTENCY_
--  CONFLICT — jamais un rejeu silencieux, jamais un écrasement, jamais
--  une seconde ligne.
--
--  RÉPONSE PERDUE (lost response) : transaction committée -> client
--  perd la réponse -> requête EXACTEMENT rejouée -> même assessment_id,
--  replayed=true, ZÉRO nouvelle ligne assessment, ZÉRO nouvelle ligne
--  interprétation. Condition d'acceptation PRIMAIRE de cette PR.
--
--  SUPERSESSION : p_supersedes_assessment_id est transmis TEL QUEL à la
--  nouvelle ligne immuable — cette RPC ne fait JAMAIS d'UPDATE d'une
--  évaluation antérieure. 0023 reste seule autorité de la lignée (même
--  event_version_id, knowledge_cutoff non régressif, au plus un
--  successeur direct). Un changement d'algorithme/modèle est TOUJOURS
--  une NOUVELLE évaluation, jamais une modification.
--
--  SÉCURITÉ : SECURITY INVOKER (jamais DEFINER), SET search_path = ''
--  dès la création, qualification complète de schéma sur chaque
--  référence de relation — même discipline que 0012/0013/0020/0023.
--  EXECUTE explicitement réinitialisé/révoqué de PUBLIC/anon/
--  authenticated/service_role puis réaccordé à service_role UNIQUEMENT
--  — même discipline à trois couches que 0023 §8. Aucun grant/policy
--  RLS des tables 0023 n'est touché ici.
--
--  TRANSACTIONNELLE : BEGIN ... COMMIT (DDL de dépôt). IDEMPOTENTE
--  (fichier) : CREATE OR REPLACE FUNCTION — rejouable sans effet si
--  déjà appliquée.
--
--  VÉRIFICATION TRANSACTIONNELLE RÉELLE : les tests déterministes de ce
--  dépôt (analyse statique du texte SQL, sans PostgreSQL) NE PROUVENT
--  PAS le comportement transactionnel réel (conflit d'index UNIQUE
--  concurrent réel, sémantique de rollback réelle, égalité JSONB
--  numérique réelle). Une vérification live contre Supabase sera
--  effectuée indépendamment, APRÈS fusion — hors périmètre de cette
--  migration.
--
--  PRÉREQUIS : migration 0023 (déjà appliquée en production,
--  20260922091501 event_impact_schema — NON réappliquée ici).
--
--  AUCUNE ACTION LIVE : cette migration n'est PAS appliquée à Supabase
--  par cette tâche. DDL de dépôt uniquement — l'application live
--  n'intervient qu'après revue indépendante et fusion, dans une tâche
--  contrôlée séparée.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- public.fn_event_impact_create_assessment(...) RETURNS TABLE(...)
--
--    Paramètres SCALAIRES obligatoires, un tableau JSONB d'enfants
--    (p_interpretations), puis p_supersedes_assessment_id (DEFAULT
--    NULL) déclaré EN DERNIER — PostgreSQL l'exige après tout paramètre
--    obligatoire. L'appelant ne fournit JAMAIS d'UUID d'évaluation : la
--    base de données le génère (gen_random_uuid(), défaut de colonne
--    0023).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_impact_create_assessment(
  p_event_version_id           UUID,
  p_assessment_status          TEXT,
  p_knowledge_cutoff           TIMESTAMPTZ,
  p_producer_type              TEXT,
  p_producer_actor             TEXT,
  p_algorithm_version          TEXT,
  p_input_fingerprint          TEXT,
  p_semantic_fingerprint       TEXT,
  p_idempotency_fingerprint    TEXT,
  p_interpretations            JSONB,
  p_supersedes_assessment_id   UUID DEFAULT NULL
)
RETURNS TABLE (
  assessment_id           UUID,
  replayed                 BOOLEAN,
  interpretation_count      INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_item                                   JSONB;
  v_unknown_keys                           TEXT[];
  v_canonical_interpretations               JSONB;
  v_existing                                 RECORD;
  v_existing_canonical_interpretations        JSONB;
  v_existing_interpretation_count              INTEGER;
  v_assessment_id                               UUID;
  v_inserted_interpretation_count                INTEGER;
BEGIN
  -- ---------------------------------------------------------------
  -- ÉTAPE 1 — validation scalaire de base (aucune lecture DB). Le
  -- vocabulaire figé (assessment_status, producer_type, ...) reste
  -- l'autorité EXCLUSIVE de 0023 — aucune valeur IN (...) dupliquée
  -- ici au-delà du strict nécessaire à la cohérence statut/enfants
  -- (ÉTAPE 3).
  -- ---------------------------------------------------------------
  IF p_event_version_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_impact_create_assessment : p_event_version_id ne peut pas être NULL.';
  END IF;
  IF p_assessment_status IS NULL THEN
    RAISE EXCEPTION 'fn_event_impact_create_assessment : p_assessment_status ne peut pas être NULL.';
  END IF;
  IF p_knowledge_cutoff IS NULL THEN
    RAISE EXCEPTION 'fn_event_impact_create_assessment : p_knowledge_cutoff ne peut pas être NULL.';
  END IF;
  IF p_producer_type IS NULL THEN
    RAISE EXCEPTION 'fn_event_impact_create_assessment : p_producer_type ne peut pas être NULL.';
  END IF;
  IF p_producer_actor IS NULL OR length(btrim(p_producer_actor)) = 0 THEN
    RAISE EXCEPTION 'fn_event_impact_create_assessment : p_producer_actor est obligatoire et non vide.';
  END IF;
  IF p_algorithm_version IS NULL OR length(btrim(p_algorithm_version)) = 0 THEN
    RAISE EXCEPTION 'fn_event_impact_create_assessment : p_algorithm_version est obligatoire et non vide.';
  END IF;
  IF p_input_fingerprint IS NULL OR length(btrim(p_input_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fn_event_impact_create_assessment : p_input_fingerprint est obligatoire et non vide.';
  END IF;
  IF p_semantic_fingerprint IS NULL OR length(btrim(p_semantic_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fn_event_impact_create_assessment : p_semantic_fingerprint est obligatoire et non vide.';
  END IF;
  IF p_idempotency_fingerprint IS NULL OR length(btrim(p_idempotency_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fn_event_impact_create_assessment : p_idempotency_fingerprint est obligatoire et non vide.';
  END IF;
  IF p_interpretations IS NULL THEN
    RAISE EXCEPTION 'EVENT_IMPACT_INVALID_INTERPRETATIONS: p_interpretations ne peut pas être NULL — un tableau JSON (vide ou non) est obligatoire.';
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 2 — contrat de forme JSON : racine tableau obligatoire,
  -- chaque membre un objet JSON, clés EXACTEMENT autorisées (rejet
  -- explicite de toute clé inconnue/fautive, jamais une absorption
  -- silencieuse).
  -- ---------------------------------------------------------------
  IF jsonb_typeof(p_interpretations) <> 'array' THEN
    RAISE EXCEPTION 'EVENT_IMPACT_INVALID_INTERPRETATIONS: p_interpretations doit être un tableau JSON (reçu %).', jsonb_typeof(p_interpretations);
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_interpretations) AS elems(value) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'EVENT_IMPACT_INVALID_INTERPRETATIONS: chaque interprétation doit être un objet JSON (reçu %).', jsonb_typeof(v_item);
    END IF;

    SELECT array_agg(key) INTO v_unknown_keys
      FROM jsonb_object_keys(v_item) AS key
      WHERE key NOT IN (
        'horizon', 'interpretation_key', 'interpretation_role', 'direction',
        'magnitude_state', 'magnitude_value', 'magnitude_unit', 'magnitude_basis',
        'confidence_state', 'confidence_value', 'pricing_state', 'rationale'
      );

    IF v_unknown_keys IS NOT NULL THEN
      RAISE EXCEPTION 'EVENT_IMPACT_INVALID_INTERPRETATIONS: clé(s) inconnue(s) dans une interprétation : %.', v_unknown_keys;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------
  -- ÉTAPE 3 — cohérence statut/enfants, défense en profondeur (0023
  -- reste l'autorité finale via ses triggers BEFORE INSERT/DEFERRED).
  -- Un p_assessment_status invalide (hors ASSESSED/INSUFFICIENT_
  -- EVIDENCE/UNAVAILABLE) n'est PAS revalidé ici — laissé au CHECK de
  -- table 0023, jamais un second vocabulaire divergent.
  -- ---------------------------------------------------------------
  IF p_assessment_status = 'ASSESSED' THEN
    IF jsonb_array_length(p_interpretations) = 0 THEN
      RAISE EXCEPTION 'EVENT_IMPACT_STATUS_CHILD_CONFLICT: assessment_status=ASSESSED exige au moins une interprétation.';
    END IF;
  ELSIF p_assessment_status IN ('INSUFFICIENT_EVIDENCE', 'UNAVAILABLE') THEN
    IF jsonb_array_length(p_interpretations) <> 0 THEN
      RAISE EXCEPTION 'EVENT_IMPACT_STATUS_CHILD_CONFLICT: assessment_status=% ne doit porter aucune interprétation.', p_assessment_status;
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 4 — normalisation canonique. L'opérateur ->> retourne NULL
  -- aussi bien pour une clé absente que pour une valeur JSON `null`
  -- explicite — équivalence automatique. Tri déterministe par
  -- (horizon, interpretation_key, interpretation_role) : l'ordre du
  -- tableau d'entrée n'affecte jamais la forme canonique.
  -- La confiance est normalisée à NUMERIC(5,4), comme la colonne
  -- 0023 : sinon un premier INSERT arrondit 0.123456 à 0.1235 et
  -- son rejeu strictement identique serait refusé à tort.
  -- ---------------------------------------------------------------
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'horizon', norm.horizon,
      'interpretation_key', norm.interpretation_key,
      'interpretation_role', norm.interpretation_role,
      'direction', norm.direction,
      'magnitude_state', norm.magnitude_state,
      'magnitude_value', norm.magnitude_value,
      'magnitude_unit', norm.magnitude_unit,
      'magnitude_basis', norm.magnitude_basis,
      'confidence_state', norm.confidence_state,
      'confidence_value', norm.confidence_value,
      'pricing_state', norm.pricing_state,
      'rationale', norm.rationale
    ) ORDER BY norm.horizon, norm.interpretation_key, norm.interpretation_role
  ), '[]'::jsonb)
    INTO v_canonical_interpretations
    FROM (
      SELECT
        item ->> 'horizon'                       AS horizon,
        item ->> 'interpretation_key'             AS interpretation_key,
        item ->> 'interpretation_role'             AS interpretation_role,
        item ->> 'direction'                        AS direction,
        item ->> 'magnitude_state'                   AS magnitude_state,
        (item ->> 'magnitude_value')::NUMERIC          AS magnitude_value,
        item ->> 'magnitude_unit'                        AS magnitude_unit,
        item ->> 'magnitude_basis'                        AS magnitude_basis,
        item ->> 'confidence_state'                        AS confidence_state,
        (item ->> 'confidence_value')::NUMERIC(5,4)          AS confidence_value,
        item ->> 'pricing_state'                               AS pricing_state,
        item ->> 'rationale'                                    AS rationale
      FROM jsonb_array_elements(p_interpretations) AS item
    ) AS norm;

  -- ---------------------------------------------------------------
  -- ÉTAPE 5 — pré-check d'idempotence (chemin rapide, AVANT toute
  -- tentative d'INSERT). N'est JAMAIS l'autorité de protection contre
  -- la concurrence — voir ÉTAPE 6 (ON CONFLICT DO NOTHING).
  -- ---------------------------------------------------------------
  SELECT eia.id, eia.event_version_id, eia.assessment_status, eia.knowledge_cutoff,
         eia.producer_type, eia.producer_actor, eia.algorithm_version,
         eia.input_fingerprint, eia.semantic_fingerprint, eia.idempotency_fingerprint,
         eia.supersedes_assessment_id
    INTO v_existing
    FROM public.event_impact_assessments eia
    WHERE eia.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'horizon', eii.horizon, 'interpretation_key', eii.interpretation_key,
        'interpretation_role', eii.interpretation_role, 'direction', eii.direction,
        'magnitude_state', eii.magnitude_state, 'magnitude_value', eii.magnitude_value,
        'magnitude_unit', eii.magnitude_unit, 'magnitude_basis', eii.magnitude_basis,
        'confidence_state', eii.confidence_state, 'confidence_value', eii.confidence_value,
        'pricing_state', eii.pricing_state, 'rationale', eii.rationale
      ) ORDER BY eii.horizon, eii.interpretation_key, eii.interpretation_role
    ), '[]'::jsonb)
      INTO v_existing_canonical_interpretations
      FROM public.event_impact_interpretations eii
      WHERE eii.assessment_id = v_existing.id;

    IF v_existing.event_version_id IS DISTINCT FROM p_event_version_id
       OR v_existing.assessment_status IS DISTINCT FROM p_assessment_status
       OR v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff
       OR v_existing.producer_type IS DISTINCT FROM p_producer_type
       OR v_existing.producer_actor IS DISTINCT FROM p_producer_actor
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.input_fingerprint IS DISTINCT FROM p_input_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM p_semantic_fingerprint
       OR v_existing.supersedes_assessment_id IS DISTINCT FROM p_supersedes_assessment_id
       OR v_existing_canonical_interpretations IS DISTINCT FROM v_canonical_interpretations
    THEN
      RAISE EXCEPTION
        'EVENT_IMPACT_IDEMPOTENCY_CONFLICT: idempotency_fingerprint % est déjà lié à une requête committée différente (assessment_id=%).',
        p_idempotency_fingerprint, v_existing.id;
    END IF;

    SELECT count(*) INTO v_existing_interpretation_count
      FROM public.event_impact_interpretations eii
      WHERE eii.assessment_id = v_existing.id;

    RETURN QUERY SELECT v_existing.id, true, v_existing_interpretation_count;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 6 — INSERT du parent protégé par l'index UNIQUE existant
  -- (0023) via ON CONFLICT DO NOTHING — AUCUN pré-check non protégé,
  -- l'unicité de idempotency_fingerprint est TOUJOURS appliquée par
  -- la base de données, jamais par la seule logique applicative.
  -- Le parent est TOUJOURS inséré avant toute tentative d'enfant.
  -- ---------------------------------------------------------------
  INSERT INTO public.event_impact_assessments AS eia (
    event_version_id, assessment_status, knowledge_cutoff,
    producer_type, producer_actor, algorithm_version,
    input_fingerprint, semantic_fingerprint, idempotency_fingerprint,
    supersedes_assessment_id
  ) VALUES (
    p_event_version_id, p_assessment_status, p_knowledge_cutoff,
    p_producer_type, p_producer_actor, p_algorithm_version,
    p_input_fingerprint, p_semantic_fingerprint, p_idempotency_fingerprint,
    p_supersedes_assessment_id
  )
  ON CONFLICT (idempotency_fingerprint) DO NOTHING
  RETURNING eia.id INTO v_assessment_id;

  IF v_assessment_id IS NOT NULL THEN
    -- -------------------------------------------------------------
    -- ÉTAPE 7 — chemin CRÉÉ-MAINTENANT : enfants insérés APRÈS le
    -- parent, dans la MÊME transaction. Tout échec d'insertion enfant
    -- (contrainte 0023) fait échouer l'appel entier — PostgreSQL
    -- annule alors la transaction implicite de l'instruction
    -- appelante tout entière (parent inclus), jamais un état
    -- parent-seul committé.
    -- -------------------------------------------------------------
    INSERT INTO public.event_impact_interpretations (
      assessment_id, horizon, interpretation_key, interpretation_role,
      direction, magnitude_state, magnitude_value, magnitude_unit, magnitude_basis,
      confidence_state, confidence_value, pricing_state, rationale
    )
    SELECT
      v_assessment_id, norm.horizon, norm.interpretation_key, norm.interpretation_role,
      norm.direction, norm.magnitude_state, norm.magnitude_value, norm.magnitude_unit, norm.magnitude_basis,
      norm.confidence_state, norm.confidence_value, norm.pricing_state, norm.rationale
    FROM jsonb_to_recordset(v_canonical_interpretations) AS norm(
      horizon TEXT, interpretation_key TEXT, interpretation_role TEXT,
      direction TEXT, magnitude_state TEXT, magnitude_value NUMERIC, magnitude_unit TEXT, magnitude_basis TEXT,
      confidence_state TEXT, confidence_value NUMERIC, pricing_state TEXT, rationale TEXT
    );

    GET DIAGNOSTICS v_inserted_interpretation_count = ROW_COUNT;

    IF v_inserted_interpretation_count <> jsonb_array_length(v_canonical_interpretations) THEN
      RAISE EXCEPTION
        'fn_event_impact_create_assessment : invariant violé — % interprétation(s) insérée(s) ne correspond(ent) pas aux % interprétation(s) canoniques pour l''évaluation %.',
        v_inserted_interpretation_count, jsonb_array_length(v_canonical_interpretations), v_assessment_id;
    END IF;

    RETURN QUERY SELECT v_assessment_id, false, v_inserted_interpretation_count;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 8 — récupération post-conflit : une transaction concurrente
  -- a committé le MÊME idempotency_fingerprint entre le pré-check
  -- (ÉTAPE 5) et cet INSERT (ON CONFLICT DO NOTHING a donc bloqué puis
  -- vu 0 ligne retournée). Même comparaison stricte qu'à l'ÉTAPE 5 —
  -- jamais un rejeu silencieux en cas de divergence réelle.
  -- ---------------------------------------------------------------
  SELECT eia.id, eia.event_version_id, eia.assessment_status, eia.knowledge_cutoff,
         eia.producer_type, eia.producer_actor, eia.algorithm_version,
         eia.input_fingerprint, eia.semantic_fingerprint, eia.idempotency_fingerprint,
         eia.supersedes_assessment_id
    INTO v_existing
    FROM public.event_impact_assessments eia
    WHERE eia.idempotency_fingerprint = p_idempotency_fingerprint;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'fn_event_impact_create_assessment : ON CONFLICT DO NOTHING déclenché pour idempotency_fingerprint % mais aucune ligne committée retrouvée — corruption réelle, pas un rejeu.',
      p_idempotency_fingerprint;
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'horizon', eii.horizon, 'interpretation_key', eii.interpretation_key,
      'interpretation_role', eii.interpretation_role, 'direction', eii.direction,
      'magnitude_state', eii.magnitude_state, 'magnitude_value', eii.magnitude_value,
      'magnitude_unit', eii.magnitude_unit, 'magnitude_basis', eii.magnitude_basis,
      'confidence_state', eii.confidence_state, 'confidence_value', eii.confidence_value,
      'pricing_state', eii.pricing_state, 'rationale', eii.rationale
    ) ORDER BY eii.horizon, eii.interpretation_key, eii.interpretation_role
  ), '[]'::jsonb)
    INTO v_existing_canonical_interpretations
    FROM public.event_impact_interpretations eii
    WHERE eii.assessment_id = v_existing.id;

  IF v_existing.event_version_id IS DISTINCT FROM p_event_version_id
     OR v_existing.assessment_status IS DISTINCT FROM p_assessment_status
     OR v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff
     OR v_existing.producer_type IS DISTINCT FROM p_producer_type
     OR v_existing.producer_actor IS DISTINCT FROM p_producer_actor
     OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
     OR v_existing.input_fingerprint IS DISTINCT FROM p_input_fingerprint
     OR v_existing.semantic_fingerprint IS DISTINCT FROM p_semantic_fingerprint
     OR v_existing.supersedes_assessment_id IS DISTINCT FROM p_supersedes_assessment_id
     OR v_existing_canonical_interpretations IS DISTINCT FROM v_canonical_interpretations
  THEN
    RAISE EXCEPTION
      'EVENT_IMPACT_IDEMPOTENCY_CONFLICT: idempotency_fingerprint % est déjà lié à une requête committée différente (assessment_id=%).',
      p_idempotency_fingerprint, v_existing.id;
  END IF;

  SELECT count(*) INTO v_existing_interpretation_count
    FROM public.event_impact_interpretations eii
    WHERE eii.assessment_id = v_existing.id;

  RETURN QUERY SELECT v_existing.id, true, v_existing_interpretation_count;
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.fn_event_impact_create_assessment IS
  'PR-EI-2 — RPC atomique de persistance Event Impact : UNE ligne event_impact_assessments PUIS (jamais avant) zéro ou plusieurs event_impact_interpretations, MÊME transaction. Aucune décision domaine (direction/magnitude/confiance/horizon/pricing) : faits déjà décidés par l''appelant, validés/persistés uniquement. Vocabulaire figé (statuts/producer_type/horizons/directions/états) possédé exclusivement par 0023. Idempotence protégée par la base de données (ON CONFLICT (idempotency_fingerprint) DO NOTHING sur l''index UNIQUE 0023, jamais un pré-check non protégé) ; rejeu exact -> replayed=true, ZÉRO nouvelle ligne ; requête différente sur la même clé -> EVENT_IMPACT_IDEMPOTENCY_CONFLICT, jamais un écrasement. Comparaison de rejeu sur la forme CANONIQUE triée des interprétations (horizon, interpretation_key, interpretation_role) — insensible à l''ordre du tableau d''entrée. p_supersedes_assessment_id transmis tel quel, jamais d''UPDATE. SECURITY INVOKER, SET search_path = vide, EXECUTE réservé à service_role uniquement.';

-- ---------------------------------------------------------------------
-- Sécurité — EXECUTE explicitement réinitialisé/révoqué de PUBLIC/anon/
-- authenticated/service_role puis réaccordé à service_role UNIQUEMENT
-- (même discipline à trois couches que 0023 §8). Aucun grant/policy RLS
-- des tables 0023 n'est touché ici.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_event_impact_create_assessment(
  UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_event_impact_create_assessment(
  UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID
) TO service_role;

COMMIT;

-- =====================================================================
-- VÉRIFICATION (lecture seule, à exécuter après application — hors
-- périmètre de cette tâche, effectuée indépendamment après fusion)
--
--   SELECT p.proname, p.prosecdef,
--          (SELECT setting FROM unnest(p.proconfig) AS setting
--             WHERE setting LIKE 'search_path=%') AS search_path_setting
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname = 'fn_event_impact_create_assessment';
--   -- attendu : search_path_setting = 'search_path=', prosecdef = false.
--
--   -- Probe de non-pollution (à exécuter en transaction, ROLLBACK
--   -- systématique). Suppose un Event Version <ev1> existant :
--   BEGIN;
--     SELECT * FROM fn_event_impact_create_assessment(
--       p_event_version_id := '<ev1>',
--       p_assessment_status := 'ASSESSED',
--       p_knowledge_cutoff := now(),
--       p_producer_type := 'DETERMINISTIC',
--       p_producer_actor := 'probe',
--       p_algorithm_version := 'probe-v1',
--       p_input_fingerprint := repeat('a', 64),
--       p_semantic_fingerprint := repeat('b', 64),
--       p_idempotency_fingerprint := repeat('c', 64),
--       p_interpretations := '[{"horizon":"H1","interpretation_key":"k1","interpretation_role":"PRIMARY","direction":"NEUTRAL","magnitude_state":"UNASSESSED","confidence_state":"UNASSESSED","pricing_state":"UNASSESSED"}]'::jsonb
--     );
--     -- attendu : replayed=false, interpretation_count=1. Rejouer le
--     -- MÊME appel : attendu replayed=true, interpretation_count=1,
--     -- ZÉRO nouvelle ligne. Rejouer avec la MÊME
--     -- p_idempotency_fingerprint mais un p_producer_actor différent :
--     -- attendu EVENT_IMPACT_IDEMPOTENCY_CONFLICT.
--   ROLLBACK;
-- =====================================================================
