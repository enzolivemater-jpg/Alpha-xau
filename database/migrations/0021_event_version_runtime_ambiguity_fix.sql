-- =====================================================================
--  ALPHA-XAU — database/migrations/0021_event_version_runtime_ambiguity_fix.sql
--
--  OBJET : correctif RUNTIME (PL/pgSQL ambiguïté de colonne, ERROR
--  42702) sur public.fn_event_create_event_version, découvert par
--  vérification live indépendante contre Supabase après application de
--  la migration 0020. AUCUNE probe n'a persisté de donnée.
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - la migration 0020 (déjà appliquée à Supabase comme
--      20260915104349 event_version_atomic_rpc — IMMUABLE désormais,
--      NON modifiée ici, jamais) ;
--    - les migrations 0012-0019 (fichiers immuables, déjà appliqués —
--      NON modifiées) ;
--    - aucune table, contrainte, trigger, policy RLS existants, aucun
--      grant de table ;
--    - fn_event_lock_cluster (réutilisée telle quelle, non redéfinie).
--
--  DÉFAUT VÉRIFIÉ EN LIVE : RETURNS TABLE (event_version_id,
--  version_number, transition_type, state_fingerprint,
--  source_independence_state, ...) introduit des noms de variable de
--  sortie PL/pgSQL identiques à de vraies colonnes de
--  public.event_versions/public.event_version_evidence. Toute référence
--  NON QUALIFIÉE à ces colonnes dans une requête SQL exécutée à
--  l'intérieur de la fonction devient AMBIGUË (ERROR 42702) — même
--  classe générale de défaut que celle déjà rencontrée et corrigée en
--  0014/0015 (RETURNING non qualifié). Premier appel réel constaté en
--  échec sur :
--
--    SELECT count(*), COALESCE(max(version_number), 0)
--      FROM public.event_versions
--     WHERE cluster_id = p_cluster_id;
--
--  AUDIT COMPLET (indépendant, exhaustif — pas seulement la ligne en
--  échec) : TOUTE référence non qualifiée à version_number/
--  transition_type/state_fingerprint/source_independence_state/
--  event_version_id dans un SELECT/WHERE exécuté sur
--  event_versions/event_version_evidence est désormais qualifiée par un
--  alias de table explicite, dans TOUS les sites :
--    A) l'agrégat de chaîne de version (ÉTAPE 8) : alias ev_chain ;
--    B) le chargement du tip (ÉTAPE 8, branche VERSION ULTÉRIEURE) :
--       alias ev_tip, CHAQUE colonne sélectionnée/filtrée qualifiée ;
--    C) la détection de successeur de prédécesseur (supersedes_
--       version_id) : alias ev_successor (qualification par préférence
--       forte, cette colonne ne collisionne pas avec RETURNS TABLE mais
--       la qualification systématique est appliquée à TOUTE référence
--       de colonne sur ces deux tables, pas seulement celles qui
--       échouent aujourd'hui) ;
--    D) les CINQ formes de comptage de preuves
--       (event_version_evidence.event_version_id) : précheck rapide,
--       recheck post-verrous, NO_MATERIAL_CHANGE, vérification du
--       nombre de preuves nouvellement insérées, récupération de rejeu
--       sur violation d'unicité — alias ve_count partout.
--
--  Les sites DÉJÀ qualifiés (alias ev./vev. dans les blocs d'idempotence
--  précheck/recheck/récupération, alias v sur l'INSERT d'en-tête avec
--  RETURNING v.id qualifié depuis la création de 0020) restaient
--  corrects et sont conservés à l'identique.
--
--  AUCUN CHANGEMENT DE COMPORTEMENT : signature publique identique,
--  contrat RETURNS TABLE identique, sémantique Event Version identique
--  (validation scalaire, empreinte d'état, instantané de preuves AS-OF,
--  vivacité de cluster, chaîne de version, garde-fou CONFIRMATION,
--  matérialité, idempotence, récupération scopée) — durcissement PUR de
--  la qualification SQL. N'utilise PAS #variable_conflict
--  use_column/use_variable : qualification explicite, lisible,
--  déterministe préférée.
--
--  SÉCURITÉ : SECURITY INVOKER (explicite), SET search_path = '' (durci
--  dès 0020, inchangé), toutes les références qualifiées public./
--  pg_catalog./extensions.. EXECUTE révoqué de PUBLIC/anon/authenticated
--  puis accordé à service_role uniquement — identique à 0020. Aucun
--  SECURITY DEFINER. Aucun changement de grant de TABLE, aucun
--  changement RLS, aucune nouvelle table, aucun nouvel index, aucune
--  fonction utilitaire supplémentaire.
--
--  TRANSACTIONNELLE : BEGIN ... COMMIT. IDEMPOTENTE (fichier) :
--  CREATE OR REPLACE FUNCTION — rejouable sans effet si déjà appliquée.
--
--  VÉRIFICATION TRANSACTIONNELLE RÉELLE : les tests déterministes de ce
--  dépôt (analyse statique du texte SQL, sans PostgreSQL) NE PROUVENT
--  PAS le comportement transactionnel réel. Une vérification live contre
--  Supabase (probe de non-pollution, ROLLBACK systématique) sera
--  effectuée indépendamment, APRÈS fusion — hors périmètre de cette
--  migration.
--
--  PRÉREQUIS : migrations 0001-0020.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- public.fn_event_create_event_version(...) RETURNS TABLE(...)
--
--    Signature, RETURNS TABLE, sécurité, et TOUTE la sémantique
--    inchangées par rapport à 0020. Seule la qualification des
--    références de colonne SQL est durcie (voir en-tête ci-dessus).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_create_event_version(
  -- --- Obligatoires (sans défaut ; NULL reste une valeur autorisée pour
  --     p_effective_time/p_effective_time_precision) ---
  p_cluster_id                              UUID,
  p_transition_type                         TEXT,
  p_knowledge_cutoff                        TIMESTAMPTZ,
  p_effective_time                          TIMESTAMPTZ,
  p_effective_time_precision                TEXT,
  p_canonical_event_state_schema_version    SMALLINT,
  p_canonical_event_state                   JSONB,
  p_official_confirmation_state             TEXT,
  p_source_independence_state               TEXT,
  p_algorithm_version                       TEXT,
  p_decision_actor                          TEXT,
  p_idempotency_fingerprint                 TEXT,
  -- --- Optionnel (chaîne de version) ---
  p_supersedes_version_id                   UUID DEFAULT NULL
)
RETURNS TABLE (
  event_version_id            UUID,
  version_number               INTEGER,
  transition_type               TEXT,
  state_fingerprint              TEXT,
  source_independence_state       TEXT,
  evidence_count                   INTEGER,
  outcome                           TEXT,
  replayed                          BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_candidate_state_fingerprint       TEXT;
  v_state_fingerprint_payload         JSONB;
  v_evidence_decision_ids             UUID[];
  v_temporal_violation_decision_id    UUID;
  v_existing                          RECORD;
  v_existing_evidence_ids             UUID[];
  v_existing_evidence_role_violation  BOOLEAN;
  v_version_count                     INTEGER;
  v_max_version_number                INTEGER;
  v_tip                               RECORD;
  v_new_version_number                INTEGER;
  v_is_material                       BOOLEAN;
  v_cluster_retired                   BOOLEAN;
  v_event_version_id                  UUID;
  v_inserted_evidence_count           INTEGER;
  v_constraint_name                   TEXT;
BEGIN
  -- ---------------------------------------------------------------
  -- ÉTAPE 1 — validation scalaire/JSON de base (aucune lecture DB),
  -- intégrité temporelle, cohérence effective_time/precision.
  -- ---------------------------------------------------------------
  IF p_cluster_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_cluster_id ne peut pas être NULL.';
  END IF;
  IF p_transition_type IS NULL OR p_transition_type NOT IN ('NOVELTY', 'CONFIRMATION', 'CORRECTION', 'REVERSAL') THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_transition_type doit être NOVELTY, CONFIRMATION, CORRECTION ou REVERSAL (reçu %).', p_transition_type;
  END IF;
  IF p_knowledge_cutoff IS NULL THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_knowledge_cutoff ne peut pas être NULL.';
  END IF;
  IF p_knowledge_cutoff > pg_catalog.transaction_timestamp() THEN
    RAISE EXCEPTION
      'fn_event_create_event_version : p_knowledge_cutoff (%) ne peut pas être postérieur à transaction_timestamp() (%) — connaissance future interdite.',
      p_knowledge_cutoff, pg_catalog.transaction_timestamp();
  END IF;
  IF p_effective_time IS NULL AND p_effective_time_precision IS NOT NULL THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_effective_time_precision doit être NULL quand p_effective_time est NULL.';
  END IF;
  IF p_effective_time IS NOT NULL AND (p_effective_time_precision IS NULL OR length(btrim(p_effective_time_precision)) = 0) THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_effective_time_precision est obligatoire et non vide quand p_effective_time est renseigné.';
  END IF;
  IF p_canonical_event_state_schema_version IS NULL THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_canonical_event_state_schema_version ne peut pas être NULL.';
  END IF;
  IF p_canonical_event_state_schema_version <= 0 THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_canonical_event_state_schema_version doit être > 0 (reçu %).', p_canonical_event_state_schema_version;
  END IF;
  IF p_canonical_event_state IS NULL THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_canonical_event_state ne peut pas être NULL.';
  END IF;
  IF jsonb_typeof(p_canonical_event_state) <> 'object' THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_canonical_event_state doit être un objet JSON (reçu %).', jsonb_typeof(p_canonical_event_state);
  END IF;
  IF p_canonical_event_state = '{}'::jsonb THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_canonical_event_state ne peut pas être un objet JSON vide.';
  END IF;
  IF p_official_confirmation_state IS NULL
     OR p_official_confirmation_state NOT IN ('UNCONFIRMED', 'SECONDARY_CONFIRMED', 'OFFICIALLY_CONFIRMED', 'OFFICIALLY_CORRECTED', 'OFFICIALLY_REVERSED')
  THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_official_confirmation_state invalide (reçu %).', p_official_confirmation_state;
  END IF;
  IF p_source_independence_state IS NULL
     OR p_source_independence_state NOT IN ('UNKNOWN', 'SINGLE_EDITORIAL_ORIGIN', 'SYNDICATED_ONLY', 'INDEPENDENTLY_CORROBORATED')
  THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_source_independence_state invalide (reçu %).', p_source_independence_state;
  END IF;
  IF p_algorithm_version IS NULL OR length(btrim(p_algorithm_version)) = 0 THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_algorithm_version est obligatoire et non vide.';
  END IF;
  IF p_decision_actor IS NULL OR length(btrim(p_decision_actor)) = 0 THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_decision_actor est obligatoire et non vide.';
  END IF;
  IF p_idempotency_fingerprint IS NULL OR length(btrim(p_idempotency_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fn_event_create_event_version : p_idempotency_fingerprint est obligatoire et non vide.';
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 2 — empreinte d'état CANDIDATE, calculée DANS la RPC (jamais
  -- acceptée de l'appelant). Contenu SEUL, jamais transition_type/
  -- supersedes_version_id/version_number/knowledge_cutoff/algorithm_
  -- version/decision_actor/preuves/created_at/schema_version/
  -- effective_time_precision. effective_time en microsecondes-epoch UTC
  -- (indépendant du fuseau de session, jamais un texte de timestamp
  -- dépendant de la session). Représentation JSONB déterministe.
  -- ---------------------------------------------------------------
  v_state_fingerprint_payload := jsonb_build_object(
    'canonical_event_state', p_canonical_event_state,
    'effective_time_epoch_us',
      CASE WHEN p_effective_time IS NULL THEN NULL
           ELSE ROUND(EXTRACT(EPOCH FROM p_effective_time) * 1000000)::BIGINT
      END,
    'official_confirmation_state', p_official_confirmation_state,
    'source_independence_state', p_source_independence_state
  );
  v_candidate_state_fingerprint := encode(
    extensions.digest(v_state_fingerprint_payload::text, 'sha256'),
    'hex'
  );

  -- ---------------------------------------------------------------
  -- ÉTAPE 3 — pré-vérification d'idempotence (chemin rapide, AVANT tout
  -- verrou). Instantané de preuves dérivé NON VERROUILLÉ uniquement pour
  -- comparaison (sera recalculé SOUS VERROU à l'étape 5 pour toute
  -- mutation réelle). Intention canonique COMPLÈTE.
  -- ---------------------------------------------------------------
  SELECT ev.id, ev.cluster_id, ev.version_number, ev.transition_type, ev.knowledge_cutoff,
         ev.effective_time, ev.effective_time_precision,
         ev.canonical_event_state_schema_version, ev.canonical_event_state,
         ev.official_confirmation_state, ev.source_independence_state,
         ev.supersedes_version_id, ev.state_fingerprint,
         ev.algorithm_version, ev.decision_actor
    INTO v_existing
    FROM public.event_versions ev
    WHERE ev.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    SELECT array_agg(m.decision_id ORDER BY m.decision_id)
      INTO v_evidence_decision_ids
      FROM public.event_observation_memberships m
      WHERE m.cluster_id = p_cluster_id
        AND m.decision_type IN ('ASSIGN', 'AMEND')
        AND m.assigned_at <= p_knowledge_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM public.event_observation_memberships successor
          WHERE successor.supersedes_decision_id = m.decision_id
            AND successor.assigned_at <= p_knowledge_cutoff
        );

    SELECT array_agg(vev.decision_id ORDER BY vev.decision_id)
      INTO v_existing_evidence_ids
      FROM public.event_version_evidence vev
      WHERE vev.event_version_id = v_existing.id;

    SELECT EXISTS (
      SELECT 1 FROM public.event_version_evidence vev
      WHERE vev.event_version_id = v_existing.id
        AND vev.evidence_role IS NOT NULL
    ) INTO v_existing_evidence_role_violation;

    IF v_existing.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_existing.transition_type IS DISTINCT FROM p_transition_type
       OR v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff
       OR v_existing.effective_time IS DISTINCT FROM p_effective_time
       OR v_existing.effective_time_precision IS DISTINCT FROM p_effective_time_precision
       OR v_existing.canonical_event_state_schema_version IS DISTINCT FROM p_canonical_event_state_schema_version
       OR v_existing.canonical_event_state IS DISTINCT FROM p_canonical_event_state
       OR v_existing.official_confirmation_state IS DISTINCT FROM p_official_confirmation_state
       OR v_existing.source_independence_state IS DISTINCT FROM p_source_independence_state
       OR v_existing.supersedes_version_id IS DISTINCT FROM p_supersedes_version_id
       OR v_existing.state_fingerprint IS DISTINCT FROM v_candidate_state_fingerprint
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing_evidence_ids IS DISTINCT FROM v_evidence_decision_ids
       OR v_existing_evidence_role_violation
    THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : idempotency_fingerprint % est déjà lié à une intention canonique différente (event_version_id=%) — collision, pas un rejeu.',
        p_idempotency_fingerprint, v_existing.id;
    END IF;

    SELECT count(*) INTO v_inserted_evidence_count
      FROM public.event_version_evidence AS ve_count
      WHERE ve_count.event_version_id = v_existing.id;

    RETURN QUERY SELECT v_existing.id, v_existing.version_number, v_existing.transition_type, v_existing.state_fingerprint, v_existing.source_independence_state, v_inserted_evidence_count, 'REPLAYED'::TEXT, true;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 4 — verrou de cluster (primitif partagé, inchangé), puis
  -- existence du cluster.
  -- ---------------------------------------------------------------
  PERFORM public.fn_event_lock_cluster(p_cluster_id);

  IF NOT EXISTS (SELECT 1 FROM public.event_clusters WHERE id = p_cluster_id) THEN
    RAISE EXCEPTION 'fn_event_create_event_version : cluster % introuvable.', p_cluster_id;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 5 — RECALCUL de l'instantané de preuves SOUS VERROU (jamais la
  -- réutilisation d'un instantané non verrouillé pour une décision de
  -- mutation). Intégrité temporelle (GREATEST(observed_at, ingested_at,
  -- assigned_at) <= cutoff, jamais published_at/published_date) et
  -- non-vide (au moins une preuve active exigée).
  -- ---------------------------------------------------------------
  SELECT array_agg(m.decision_id ORDER BY m.decision_id)
    INTO v_evidence_decision_ids
    FROM public.event_observation_memberships m
    WHERE m.cluster_id = p_cluster_id
      AND m.decision_type IN ('ASSIGN', 'AMEND')
      AND m.assigned_at <= p_knowledge_cutoff
      AND NOT EXISTS (
        SELECT 1 FROM public.event_observation_memberships successor
        WHERE successor.supersedes_decision_id = m.decision_id
          AND successor.assigned_at <= p_knowledge_cutoff
      );

  IF v_evidence_decision_ids IS NULL OR cardinality(v_evidence_decision_ids) = 0 THEN
    RAISE EXCEPTION
      'fn_event_create_event_version : aucune preuve de membership active en date de p_knowledge_cutoff (%) pour le cluster % — au moins une preuve active est requise.',
      p_knowledge_cutoff, p_cluster_id;
  END IF;

  SELECT m.decision_id
    INTO v_temporal_violation_decision_id
    FROM public.event_observation_memberships m
    JOIN public.news_articles a ON a.id = m.observation_id
    WHERE m.decision_id = ANY(v_evidence_decision_ids)
      AND GREATEST(a.observed_at, a.ingested_at, m.assigned_at) > p_knowledge_cutoff
    LIMIT 1;

  IF v_temporal_violation_decision_id IS NOT NULL THEN
    RAISE EXCEPTION
      'fn_event_create_event_version : intégrité temporelle violée — la décision % (preuve as-of) a GREATEST(observed_at, ingested_at, assigned_at) postérieur à p_knowledge_cutoff (%).',
      v_temporal_violation_decision_id, p_knowledge_cutoff;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 6 — RE-vérification d'idempotence COMPLÈTE, APRÈS le verrou de
  -- cluster ET le recalcul verrouillé de l'instantané de preuves. CETTE
  -- RE-VÉRIFICATION DOIT SURVENIR AVANT le rejet de prédécesseur périmé,
  -- la vivacité de cluster, et la décision de matérialité — sinon un
  -- rejeu concurrent identique ayant perdu la course au verrou échouerait
  -- à tort. Réutilise v_evidence_decision_ids déjà recalculé (étape 5).
  -- ---------------------------------------------------------------
  SELECT ev.id, ev.cluster_id, ev.version_number, ev.transition_type, ev.knowledge_cutoff,
         ev.effective_time, ev.effective_time_precision,
         ev.canonical_event_state_schema_version, ev.canonical_event_state,
         ev.official_confirmation_state, ev.source_independence_state,
         ev.supersedes_version_id, ev.state_fingerprint,
         ev.algorithm_version, ev.decision_actor
    INTO v_existing
    FROM public.event_versions ev
    WHERE ev.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    SELECT array_agg(vev.decision_id ORDER BY vev.decision_id)
      INTO v_existing_evidence_ids
      FROM public.event_version_evidence vev
      WHERE vev.event_version_id = v_existing.id;

    SELECT EXISTS (
      SELECT 1 FROM public.event_version_evidence vev
      WHERE vev.event_version_id = v_existing.id
        AND vev.evidence_role IS NOT NULL
    ) INTO v_existing_evidence_role_violation;

    IF v_existing.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_existing.transition_type IS DISTINCT FROM p_transition_type
       OR v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff
       OR v_existing.effective_time IS DISTINCT FROM p_effective_time
       OR v_existing.effective_time_precision IS DISTINCT FROM p_effective_time_precision
       OR v_existing.canonical_event_state_schema_version IS DISTINCT FROM p_canonical_event_state_schema_version
       OR v_existing.canonical_event_state IS DISTINCT FROM p_canonical_event_state
       OR v_existing.official_confirmation_state IS DISTINCT FROM p_official_confirmation_state
       OR v_existing.source_independence_state IS DISTINCT FROM p_source_independence_state
       OR v_existing.supersedes_version_id IS DISTINCT FROM p_supersedes_version_id
       OR v_existing.state_fingerprint IS DISTINCT FROM v_candidate_state_fingerprint
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing_evidence_ids IS DISTINCT FROM v_evidence_decision_ids
       OR v_existing_evidence_role_violation
    THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : idempotency_fingerprint % est déjà lié à une intention canonique différente (event_version_id=%) — collision, pas un rejeu.',
        p_idempotency_fingerprint, v_existing.id;
    END IF;

    SELECT count(*) INTO v_inserted_evidence_count
      FROM public.event_version_evidence AS ve_count
      WHERE ve_count.event_version_id = v_existing.id;

    RETURN QUERY SELECT v_existing.id, v_existing.version_number, v_existing.transition_type, v_existing.state_fingerprint, v_existing.source_independence_state, v_inserted_evidence_count, 'REPLAYED'::TEXT, true;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 7 — SEULEMENT MAINTENANT que le rejeu a été explicitement
  -- écarté : vivacité du cluster EN DATE DE p_knowledge_cutoff (jamais
  -- l'état actuel du graphe). Un cluster est retiré en date du cutoff
  -- s'il est le côté FROM d'une opération de relation ACTIVE à cette
  -- date (decided_at <= cutoff, aucun successeur avec decided_at <=
  -- cutoff). Un rejeu/backfill historique avec un cutoff ANTÉRIEUR à un
  -- MERGE/SPLIT ultérieur reste représentable.
  -- ---------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1
      FROM public.event_cluster_relation_edges e
      JOIN public.event_cluster_relation_operations o ON o.operation_id = e.operation_id
     WHERE e.from_cluster_id = p_cluster_id
       AND o.decided_at <= p_knowledge_cutoff
       AND NOT EXISTS (
             SELECT 1 FROM public.event_cluster_relation_operations successor
              WHERE successor.supersedes_operation_id = o.operation_id
                AND successor.decided_at <= p_knowledge_cutoff
           )
  ) INTO v_cluster_retired;

  IF v_cluster_retired THEN
    RAISE EXCEPTION
      'fn_event_create_event_version : le cluster % n''était pas vivant en date de p_knowledge_cutoff (%) — il est le côté FROM d''une opération de relation active à cette date.',
      p_cluster_id, p_knowledge_cutoff;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 8 — chaîne de version : détection explicite de corruption
  -- structurelle, puis validation PREMIÈRE/ULTÉRIEURE version.
  --
  -- CORRECTIF RUNTIME (0021) : alias explicites ev_chain/ev_tip/
  -- ev_successor et qualification COMPLÈTE de chaque colonne lue/filtrée
  -- sur public.event_versions — version_number/transition_type/
  -- state_fingerprint/source_independence_state collisionnent avec les
  -- variables de sortie RETURNS TABLE, rendant toute référence non
  -- qualifiée AMBIGUË (ERROR 42702) à l'exécution.
  -- ---------------------------------------------------------------
  SELECT count(*), COALESCE(max(ev_chain.version_number), 0)
    INTO v_version_count, v_max_version_number
    FROM public.event_versions AS ev_chain
    WHERE ev_chain.cluster_id = p_cluster_id;

  IF v_version_count <> v_max_version_number THEN
    RAISE EXCEPTION
      'fn_event_create_event_version : chaîne de versions incohérente pour le cluster % (% ligne(s), max version_number %) — corruption structurelle.',
      p_cluster_id, v_version_count, v_max_version_number;
  END IF;

  IF v_version_count = 0 THEN
    -- PREMIÈRE VERSION.
    IF p_supersedes_version_id IS NOT NULL THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : p_supersedes_version_id doit être NULL pour la première version du cluster % (aucune version existante).',
        p_cluster_id;
    END IF;
    IF p_transition_type <> 'NOVELTY' THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : p_transition_type doit être NOVELTY pour la première version du cluster % (reçu %).',
        p_cluster_id, p_transition_type;
    END IF;
    v_new_version_number := 1;
  ELSE
    -- VERSION ULTÉRIEURE.
    IF p_supersedes_version_id IS NULL THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : p_supersedes_version_id est obligatoire pour une version ultérieure du cluster % (% version(s) déjà existante(s)).',
        p_cluster_id, v_version_count;
    END IF;
    IF p_transition_type = 'NOVELTY' THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : p_transition_type ne peut pas être NOVELTY pour une version ultérieure du cluster % (% version(s) déjà existante(s)).',
        p_cluster_id, v_version_count;
    END IF;

    SELECT ev_tip.id, ev_tip.version_number, ev_tip.transition_type, ev_tip.knowledge_cutoff, ev_tip.state_fingerprint,
           ev_tip.source_independence_state, ev_tip.canonical_event_state, ev_tip.effective_time, ev_tip.effective_time_precision
      INTO v_tip
      FROM public.event_versions AS ev_tip
      WHERE ev_tip.cluster_id = p_cluster_id AND ev_tip.version_number = v_max_version_number;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : tip introuvable pour le cluster % (version_number %) — corruption structurelle.',
        p_cluster_id, v_max_version_number;
    END IF;
    IF p_supersedes_version_id IS DISTINCT FROM v_tip.id THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : prédécesseur % (p_supersedes_version_id) n''est pas le tip courant du cluster % (tip=%) — prédécesseur périmé.',
        p_supersedes_version_id, p_cluster_id, v_tip.id;
    END IF;

    -- event_versions n'a PAS de contrainte UNIQUE sur
    -- supersedes_version_id : détection explicite d'un successeur déjà
    -- existant, jamais une dépendance à une contrainte absente.
    IF EXISTS (SELECT 1 FROM public.event_versions AS ev_successor WHERE ev_successor.supersedes_version_id = p_supersedes_version_id) THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : prédécesseur % périmé — un successeur existe déjà.',
        p_supersedes_version_id;
    END IF;

    IF p_knowledge_cutoff < v_tip.knowledge_cutoff THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : p_knowledge_cutoff (%) est antérieur à celui du prédécesseur % (%) — doit être monotone.',
        p_knowledge_cutoff, p_supersedes_version_id, v_tip.knowledge_cutoff;
    END IF;

    v_new_version_number := v_max_version_number + 1;

    -- -------------------------------------------------------------
    -- ÉTAPE 9 — garde-fou CONFIRMATION : aucun changement factuel
    -- objectif autorisé. REVERSAL n'est jamais inféré ici (PR4).
    -- -------------------------------------------------------------
    IF p_transition_type = 'CONFIRMATION' THEN
      IF v_tip.canonical_event_state IS DISTINCT FROM p_canonical_event_state
         OR v_tip.effective_time IS DISTINCT FROM p_effective_time
         OR v_tip.effective_time_precision IS DISTINCT FROM p_effective_time_precision
      THEN
        RAISE EXCEPTION
          'fn_event_create_event_version : CONFIRMATION ne peut pas modifier canonical_event_state/effective_time/effective_time_precision par rapport au prédécesseur % — utiliser CORRECTION (ou REVERSAL, hors périmètre de cette RPC).',
          p_supersedes_version_id;
      END IF;
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 10 — matérialité. Empreinte candidate identique à celle du
  -- prédécesseur (tip) -> AUCUNE insertion (ni en-tête ni preuve),
  -- retour du prédécesseur avec outcome=NO_MATERIAL_CHANGE.
  -- ---------------------------------------------------------------
  IF v_version_count > 0 THEN
    v_is_material := (v_candidate_state_fingerprint IS DISTINCT FROM v_tip.state_fingerprint);
  ELSE
    v_is_material := true;
  END IF;

  IF NOT v_is_material THEN
    SELECT count(*) INTO v_inserted_evidence_count
      FROM public.event_version_evidence AS ve_count
      WHERE ve_count.event_version_id = v_tip.id;

    RETURN QUERY SELECT v_tip.id, v_tip.version_number, v_tip.transition_type, v_tip.state_fingerprint, v_tip.source_independence_state, v_inserted_evidence_count, 'NO_MATERIAL_CHANGE'::TEXT, false;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 11 — insertion atomique : UN en-tête + l'instantané COMPLET de
  -- preuves, dans le MÊME bloc BEGIN/EXCEPTION. Alias qualifié + RETURNING
  -- qualifié (leçon 0015). Vérification que le nombre de preuves
  -- insérées égale l'instantané dérivé.
  -- ---------------------------------------------------------------
  BEGIN
    INSERT INTO public.event_versions AS v (
      cluster_id, version_number, transition_type, knowledge_cutoff,
      effective_time, effective_time_precision,
      canonical_event_state_schema_version, canonical_event_state,
      official_confirmation_state, source_independence_state,
      supersedes_version_id, state_fingerprint, idempotency_fingerprint,
      algorithm_version, decision_actor
    ) VALUES (
      p_cluster_id, v_new_version_number, p_transition_type, p_knowledge_cutoff,
      p_effective_time, p_effective_time_precision,
      p_canonical_event_state_schema_version, p_canonical_event_state,
      p_official_confirmation_state, p_source_independence_state,
      p_supersedes_version_id, v_candidate_state_fingerprint, p_idempotency_fingerprint,
      p_algorithm_version, p_decision_actor
    )
    RETURNING v.id INTO v_event_version_id;

    INSERT INTO public.event_version_evidence (event_version_id, decision_id, evidence_role)
    SELECT v_event_version_id, d, NULL
      FROM unnest(v_evidence_decision_ids) d
     ORDER BY d;

    SELECT count(*) INTO v_inserted_evidence_count
      FROM public.event_version_evidence AS ve_count
      WHERE ve_count.event_version_id = v_event_version_id;

    IF v_inserted_evidence_count <> cardinality(v_evidence_decision_ids) THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : invariant violé — % preuve(s) insérée(s) ne correspond(ent) pas aux % preuve(s) de l''instantané dérivé pour event_version %.',
        v_inserted_evidence_count, cardinality(v_evidence_decision_ids), v_event_version_id;
    END IF;

    RETURN QUERY SELECT v_event_version_id, v_new_version_number, p_transition_type, v_candidate_state_fingerprint, p_source_independence_state, v_inserted_evidence_count, 'CREATED'::TEXT, false;
    RETURN;

  EXCEPTION WHEN unique_violation THEN
    -- Filet de sécurité : collision GLOBALE d'idempotency_fingerprint.
    -- On ne récupère QUE cette violation précise : uq_event_versions_
    -- cluster_number, event_version_evidence_pkey (ou toute autre) est
    -- relevée telle quelle (re-RAISE) — jamais une corruption
    -- structurelle silencieusement absorbée.
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IS DISTINCT FROM 'uq_event_versions_idempotency_fingerprint' THEN
      RAISE;
    END IF;

    SELECT ev.id, ev.cluster_id, ev.version_number, ev.transition_type, ev.knowledge_cutoff,
           ev.effective_time, ev.effective_time_precision,
           ev.canonical_event_state_schema_version, ev.canonical_event_state,
           ev.official_confirmation_state, ev.source_independence_state,
           ev.supersedes_version_id, ev.state_fingerprint,
           ev.algorithm_version, ev.decision_actor
      INTO v_existing
      FROM public.event_versions ev
      WHERE ev.idempotency_fingerprint = p_idempotency_fingerprint;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : violation d''unicité sur idempotency_fingerprint % mais aucune version committée retrouvée — corruption réelle, pas un rejeu.',
        p_idempotency_fingerprint;
    END IF;

    SELECT array_agg(vev.decision_id ORDER BY vev.decision_id)
      INTO v_existing_evidence_ids
      FROM public.event_version_evidence vev
      WHERE vev.event_version_id = v_existing.id;

    SELECT EXISTS (
      SELECT 1 FROM public.event_version_evidence vev
      WHERE vev.event_version_id = v_existing.id
        AND vev.evidence_role IS NOT NULL
    ) INTO v_existing_evidence_role_violation;

    IF v_existing.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_existing.transition_type IS DISTINCT FROM p_transition_type
       OR v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff
       OR v_existing.effective_time IS DISTINCT FROM p_effective_time
       OR v_existing.effective_time_precision IS DISTINCT FROM p_effective_time_precision
       OR v_existing.canonical_event_state_schema_version IS DISTINCT FROM p_canonical_event_state_schema_version
       OR v_existing.canonical_event_state IS DISTINCT FROM p_canonical_event_state
       OR v_existing.official_confirmation_state IS DISTINCT FROM p_official_confirmation_state
       OR v_existing.source_independence_state IS DISTINCT FROM p_source_independence_state
       OR v_existing.supersedes_version_id IS DISTINCT FROM p_supersedes_version_id
       OR v_existing.state_fingerprint IS DISTINCT FROM v_candidate_state_fingerprint
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing_evidence_ids IS DISTINCT FROM v_evidence_decision_ids
       OR v_existing_evidence_role_violation
    THEN
      RAISE EXCEPTION
        'fn_event_create_event_version : violation d''unicité sur idempotency_fingerprint % dont l''intention committée diffère de cet appel — collision réelle, pas un rejeu.',
        p_idempotency_fingerprint;
    END IF;

    SELECT count(*) INTO v_inserted_evidence_count
      FROM public.event_version_evidence AS ve_count
      WHERE ve_count.event_version_id = v_existing.id;

    RETURN QUERY SELECT v_existing.id, v_existing.version_number, v_existing.transition_type, v_existing.state_fingerprint, v_existing.source_independence_state, v_inserted_evidence_count, 'REPLAYED'::TEXT, true;
    RETURN;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_event_create_event_version(
  UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, SMALLINT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_event_create_event_version(
  UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, SMALLINT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, UUID
) TO service_role;

COMMENT ON FUNCTION public.fn_event_create_event_version IS
  'RPC atomique OPS-023 (PR3) : persistance d''un EVENT VERSION (instantané immuable de l''état de connaissance MATÉRIEL d''un cluster), plus l''instantané complet de preuves de membership actives AS-OF knowledge_cutoff. state_fingerprint calculé DANS la RPC (contenu seul : canonical_event_state + effective_time + official_confirmation_state + source_independence_state, sha256 hex, jamais unique). Instantané de preuves dérivé (jamais fourni par l''appelant), sémantique AS-OF par graphe, intégrité temporelle via GREATEST(observed_at,ingested_at,assigned_at), jamais published_at/published_date. Vivacité de cluster évaluée EN DATE DU cutoff. Matérialité stricte : empreinte identique au prédécesseur -> NO_MATERIAL_CHANGE, aucune insertion. Idempotente (précheck + recheck post-verrou/recalcul + récupération scopée sur uq_event_versions_idempotency_fingerprint). N''accepte que des faits déjà décidés par l''appelant. Jamais d''UPDATE/DELETE. CORRECTIF RUNTIME 0021 : toute référence de colonne sur event_versions/event_version_evidence est qualifiée par un alias de table explicite (ev_chain/ev_tip/ev_successor/ve_count, en plus de ev/vev/v déjà présents) — les noms de sortie RETURNS TABLE (version_number, transition_type, state_fingerprint, source_independence_state, event_version_id) collisionnent avec de vraies colonnes de ces tables et rendaient certaines références non qualifiées ambiguës (ERROR 42702) à l''exécution, corrigé sans aucun changement de signature ni de sémantique.';

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
--      AND p.proname = 'fn_event_create_event_version';
--   -- attendu : search_path_setting = 'search_path=', prosecdef = false.
--
--   -- Probe de non-pollution (à exécuter en transaction, ROLLBACK
--   -- systématique). Suppose un cluster <c1> avec au moins une décision
--   -- ASSIGN active — reproduit exactement le premier appel réel qui
--   -- avait échoué en ERROR 42702 avant ce correctif :
--   BEGIN;
--     SELECT * FROM fn_event_create_event_version(
--       p_cluster_id := '<c1>',
--       p_transition_type := 'NOVELTY',
--       p_knowledge_cutoff := now(),
--       p_effective_time := NULL,
--       p_effective_time_precision := NULL,
--       p_canonical_event_state_schema_version := 1,
--       p_canonical_event_state := '{"event_type":"probe"}'::jsonb,
--       p_official_confirmation_state := 'UNCONFIRMED',
--       p_source_independence_state := 'UNKNOWN',
--       p_algorithm_version := 'probe-v1',
--       p_decision_actor := 'ops023-probe',
--       p_idempotency_fingerprint := 'probe-fp-version-0021-001'
--     );
--     -- attendu : outcome=CREATED, version_number=1, aucune erreur
--     -- 42702. Rejouer le même appel : outcome=REPLAYED.
--   ROLLBACK;
-- =====================================================================
