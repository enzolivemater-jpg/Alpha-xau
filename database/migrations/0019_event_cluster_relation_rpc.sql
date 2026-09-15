-- =====================================================================
--  ALPHA-XAU — database/migrations/0019_event_cluster_relation_rpc.sql
--
--  OBJET : primitif transactionnel OPS-023 Phase 2 (suite) — mutation
--  atomique de relation de cluster (MERGE/SPLIT), sur les tables déjà
--  gelées (0012) :
--
--    public.event_cluster_relation_operations  (en-tête, append-only)
--    public.event_cluster_relation_edges       (arêtes membres)
--
--  Une opération = UN en-tête + son ensemble complet d'arêtes dérivées
--  canoniquement des deux tableaux de clusters fournis, insérés
--  ATOMIQUEMENT. Aucune fusion/scission automatique : chaque appel est
--  une décision curée explicite, jamais une réaction automatique à une
--  collision d'identité ou à une heuristique interne à cette RPC.
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - les migrations 0012-0018 (fichiers immuables, déjà appliqués —
--      NON modifiées) ;
--    - aucune table, contrainte, trigger, policy RLS existants, aucun
--      grant de table (seuls des GRANT/REVOKE de fonction sont
--      introduits ici) ;
--    - fn_event_lock_cluster (réutilisée telle quelle, non redéfinie) ;
--    - le trigger différé fn_check_cluster_relation_operation_cardinality
--      (0012, défense en profondeur inchangée — la RPC valide la même
--      cardinalité explicitement, AVANT tout INSERT, pour un message
--      d'erreur clair avant toute écriture).
--
--  VERROUILLAGE (discipline gelée, CRITIQUE pour la correction) :
--    1. verrou GLOBAL de topologie (namespace dédié
--       'xau_v2:event_relation'/'topology', pg_advisory_xact_lock) —
--       AVANT tout verrou de cluster. La détection de cycle lit le
--       graphe ACTIF complet, qui peut impliquer des clusters
--       intermédiaires absents de l'opération candidate : verrouiller
--       seulement les clusters candidats ne suffit PAS à rendre une
--       vérification globale de cycle/accessibilité race-free. Les
--       opérations MERGE/SPLIT sont peu fréquentes — la correction prime
--       sur le parallélisme. Ce verrou global n'est JAMAIS réutilisé
--       pour les opérations de membership ou d'identité (namespaces
--       disjoints : 'xau_v2:event_cluster', 'xau_v2:event_identity').
--    2. si supersession : CHARGEMENT du prédécesseur (existence + ses
--       clusters impliqués via ses arêtes) — PAS ENCORE de rejet de
--       fraîcheur ici (voir §RÉVIEW-FIX-001 de 0018, appliqué dès la
--       création ici : rejeter trop tôt ferait échouer à tort un rejeu
--       concurrent identique).
--    3. verrous de CHAQUE cluster impliqué (nouveaux + prédécesseur le
--       cas échéant), dédupliqués, triés par UUID, acquis un par un via
--       le SEUL primitif partagé public.fn_event_lock_cluster — jamais
--       une autre implémentation de verrou de cluster.
--    4. RE-vérification d'idempotence complète, APRÈS le verrou global
--       ET tous les verrous de cluster — SI rejeu exact : retour
--       immédiat, replayed=true.
--    5. SEULEMENT SI CE N'EST PAS un rejeu : existence des clusters
--       candidats, puis (si supersession) rejet de fraîcheur périmée.
--    6. prévention de cycle sous le verrou global.
--    7. INSERT (en-tête + arêtes complètes, un seul bloc atomique).
--
--  IDEMPOTENCE (à l'échelle de L'OPÉRATION ENTIÈRE, en-tête + ensemble
--  complet d'arêtes) :
--    1. pré-vérification par idempotency_fingerprint AVANT tout verrou ;
--    2. RE-vérification identique APRÈS le verrou global ET tous les
--       verrous de cluster (couvre un appel concurrent identique ayant
--       commité pendant l'attente) ;
--    3. récupération scopée sur violation d'unicité, limitée à
--       uq_cluster_relation_ops_idempotency_fingerprint — toute autre
--       violation (notamment uq_cluster_relation_ops_supersedes) est
--       relevée telle quelle (re-RAISE).
--  Dans les trois cas, l'intention canonique COMPLÈTE est revalidée :
--  operation_type, ensemble trié from, ensemble trié to, ensemble exact
--  d'arêtes dérivées, algorithm_version, decision_actor, reason,
--  supersedes_operation_id. L'opération existante trouvée doit elle-même
--  avoir un ensemble d'arêtes structurellement valide pour son
--  operation_type (filet de sécurité anti-corruption). Une opération
--  historiquement réussie reste rejouable même si supersédée depuis.
--
--  ENTRÉES : p_from_cluster_ids/p_to_cluster_ids sont des tableaux non
--  ordonnés sémantiquement — des copies TRIÉES déterministes sont
--  construites pour comparaison/verrouillage/valeurs de retour, mais
--  AUCUN doublon n'est silencieusement supprimé (rejet explicite) et
--  AUCUNE identité de cluster n'est réécrite. Les arêtes candidates sont
--  dérivées canoniquement par la RPC (MERGE : chaque source -> l'unique
--  destination ; SPLIT : l'unique source -> chaque destination) —
--  jamais un payload d'arêtes arbitraire fourni par l'appelant.
--
--  GRAPHE ACTIF (par graphe, jamais decided_at) : une opération est
--  ACTIVE si aucun successeur n'existe (NOT EXISTS
--  supersedes_operation_id = son operation_id). Pour une correction, les
--  arêtes du prédécessseur (p_supersedes_operation_id) sont EXCLUES du
--  graphe actif car la nouvelle opération le remplace atomiquement.
--
--  PRÉVENTION DE CYCLE : sous le verrou global, construction du graphe
--  = arêtes ACTIVES (excluant celles du prédécesseur corrigé) + arêtes
--  CANDIDATES. Pour chaque arête candidate U->V, aucun chemin dirigé
--  V->...->U ne doit exister dans ce graphe résultant — sinon rejet
--  explicite identifiant l'arête candidate en cause. Fermeture
--  transitive calculée via UNE SEULE CTE récursive (UNION, jamais UNION
--  ALL) : la déduplication de UNION borne strictement le nombre
--  d'itérations (au plus N² paires sur N clusters), donc AUCUNE donnée
--  malformée préexistante (cycle déjà présent dans le graphe actif) ne
--  peut provoquer une récursion infinie.
--
--  AMBIGUÏTÉ RETURNING (leçon 0015, appliquée dès la création) : alias
--  de table explicite qualifié (AS o) et RETURNING o.operation_id INTO
--  <variable dédiée> — RETURNS TABLE porte une colonne "operation_id"
--  identique au nom de colonne réel de la table, donc une ambiguïté
--  0014-style existe littéralement ici si le RETURNING n'est pas
--  qualifié. L'INSERT des arêtes ne fait l'objet d'aucun RETURNING (bulk
--  INSERT ... SELECT), donc aucune ambiguïté possible là.
--
--  SÉCURITÉ : SECURITY INVOKER (explicite), SET search_path = '' (durci
--  dès la création), toutes les références de relation/fonction
--  qualifiées public./pg_catalog.. Aucun code SECURITY DEFINER. EXECUTE
--  révoqué de PUBLIC/anon/authenticated puis accordé à service_role
--  uniquement. Grants et RLS des TABLES existantes strictement
--  inchangés.
--
--  HORS PÉRIMÈTRE ICI (gelé) : modification d'event_clusters, de
--  memberships, de revendications d'identité ; décision automatique de
--  MERGE/SPLIT ; réaction automatique à une collision d'identité ;
--  création d'EVENT VERSION ; processeur ; worker/cron ; Comité ; Event
--  Impact ; Gold Transmission ; Silver Edge ; notification ; legacy ;
--  frontend ; Cloudflare ; Anthropic. Aucun UPDATE, aucun DELETE, aucune
--  nouvelle table, aucun nouvel index, aucune fonction utilitaire
--  supplémentaire.
--
--  TRANSACTIONNELLE : BEGIN ... COMMIT. IDEMPOTENTE (fichier) :
--  CREATE OR REPLACE FUNCTION — rejouable sans effet si déjà appliquée.
--
--  VÉRIFICATION TRANSACTIONNELLE RÉELLE : les tests déterministes de ce
--  dépôt (analyse statique du texte SQL, sans PostgreSQL) NE PROUVENT
--  PAS le comportement transactionnel réel (verrouillage advisory
--  effectif, absence réelle d'interblocage, sémantique de rollback réelle).
--  Une vérification live contre Supabase (rollback/probes de
--  non-pollution) sera effectuée indépendamment, APRÈS fusion — hors
--  périmètre de cette migration.
--
--  PRÉREQUIS : migrations 0001-0018 (event_clusters,
--  event_cluster_relation_operations, event_cluster_relation_edges,
--  fn_event_lock_cluster).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- public.fn_event_create_cluster_relation(...) RETURNS TABLE(...)
--
--    Paramètres SCALAIRES/tableaux explicites (pas de payload JSON
--    opaque). ORDRE DE DÉCLARATION : les paramètres obligatoires (sans
--    défaut) sont déclarés en premier, puis p_supersedes_operation_id
--    (DEFAULT NULL) — PostgreSQL l'exige. Cet ordre SQL ne change rien à
--    l'appel via PostgREST (rpc/fn_event_create_cluster_relation), qui
--    passe les arguments par NOM (corps JSON), pas par position.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_create_cluster_relation(
  -- --- Obligatoires (sans défaut) ---
  p_operation_type            TEXT,
  p_from_cluster_ids          UUID[],
  p_to_cluster_ids            UUID[],
  p_algorithm_version         TEXT,
  p_decision_actor            TEXT,
  p_reason                    TEXT,
  p_idempotency_fingerprint   TEXT,
  -- --- Optionnel (supersession) ---
  p_supersedes_operation_id   UUID DEFAULT NULL
)
RETURNS TABLE (
  operation_id              UUID,
  operation_type            TEXT,
  from_cluster_ids          UUID[],
  to_cluster_ids            UUID[],
  superseded_operation_id   UUID,
  edge_count                INTEGER,
  replayed                  BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_sorted_from                   UUID[];
  v_sorted_to                     UUID[];
  v_candidate_from                UUID[];
  v_candidate_to                  UUID[];
  v_existing                      RECORD;
  v_existing_from_ct              INTEGER;
  v_existing_to_ct                INTEGER;
  v_existing_sorted_from          UUID[];
  v_existing_sorted_to            UUID[];
  v_existing_edge_count           INTEGER;
  v_edge_set_matches               BOOLEAN;
  v_predecessor                    RECORD;
  v_predecessor_from_clusters      UUID[];
  v_predecessor_to_clusters        UUID[];
  v_predecessor_successor_exists   BOOLEAN;
  v_lock_cluster_ids                UUID[];
  v_lock_cluster_id                 UUID;
  v_missing_cluster_id               UUID;
  v_cycle_edge_from                   UUID;
  v_cycle_edge_to                     UUID;
  v_operation_id                       UUID;
  v_constraint_name                     TEXT;
BEGIN
  -- ---------------------------------------------------------------
  -- ÉTAPE 1 — validation scalaire/tableau de base (aucune lecture DB),
  -- construction des copies TRIÉES déterministes, validation explicite
  -- de la cardinalité MERGE/SPLIT AVANT tout INSERT.
  -- ---------------------------------------------------------------
  IF p_operation_type IS NULL THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_operation_type ne peut pas être NULL.';
  END IF;
  IF p_operation_type NOT IN ('MERGE', 'SPLIT') THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_operation_type doit être MERGE ou SPLIT (reçu %).', p_operation_type;
  END IF;
  IF p_from_cluster_ids IS NULL OR cardinality(p_from_cluster_ids) = 0 THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_from_cluster_ids est obligatoire et non vide.';
  END IF;
  IF p_to_cluster_ids IS NULL OR cardinality(p_to_cluster_ids) = 0 THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_to_cluster_ids est obligatoire et non vide.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_from_cluster_ids) AS v WHERE v IS NULL) THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_from_cluster_ids ne peut pas contenir d''élément NULL.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_to_cluster_ids) AS v WHERE v IS NULL) THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_to_cluster_ids ne peut pas contenir d''élément NULL.';
  END IF;
  IF (SELECT count(*) FROM unnest(p_from_cluster_ids) v) <> (SELECT count(DISTINCT v) FROM unnest(p_from_cluster_ids) v) THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_from_cluster_ids contient des doublons — non autorisé (aucune déduplication silencieuse).';
  END IF;
  IF (SELECT count(*) FROM unnest(p_to_cluster_ids) v) <> (SELECT count(DISTINCT v) FROM unnest(p_to_cluster_ids) v) THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_to_cluster_ids contient des doublons — non autorisé (aucune déduplication silencieuse).';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_from_cluster_ids) f WHERE f = ANY(p_to_cluster_ids)) THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : un même cluster ne peut pas apparaître à la fois dans p_from_cluster_ids et p_to_cluster_ids.';
  END IF;
  IF p_algorithm_version IS NULL OR length(btrim(p_algorithm_version)) = 0 THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_algorithm_version est obligatoire et non vide.';
  END IF;
  IF p_decision_actor IS NULL OR length(btrim(p_decision_actor)) = 0 THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_decision_actor est obligatoire et non vide.';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_reason est obligatoire et non vide.';
  END IF;
  IF p_idempotency_fingerprint IS NULL OR length(btrim(p_idempotency_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : p_idempotency_fingerprint est obligatoire et non vide.';
  END IF;

  -- Copies TRIÉES déterministes (comparaison/verrouillage/retour) — les
  -- tableaux d'ENTRÉE p_from_cluster_ids/p_to_cluster_ids ne sont jamais
  -- réécrits, seulement recopiés triés.
  SELECT array_agg(v ORDER BY v) INTO v_sorted_from FROM unnest(p_from_cluster_ids) v;
  SELECT array_agg(v ORDER BY v) INTO v_sorted_to FROM unnest(p_to_cluster_ids) v;

  IF p_operation_type = 'MERGE' THEN
    IF cardinality(v_sorted_from) < 2 THEN
      RAISE EXCEPTION 'fn_event_create_cluster_relation : MERGE exige au moins 2 clusters source distincts (reçu %).', cardinality(v_sorted_from);
    END IF;
    IF cardinality(v_sorted_to) <> 1 THEN
      RAISE EXCEPTION 'fn_event_create_cluster_relation : MERGE exige exactement 1 cluster destination (reçu %).', cardinality(v_sorted_to);
    END IF;
  ELSE
    IF cardinality(v_sorted_from) <> 1 THEN
      RAISE EXCEPTION 'fn_event_create_cluster_relation : SPLIT exige exactement 1 cluster source (reçu %).', cardinality(v_sorted_from);
    END IF;
    IF cardinality(v_sorted_to) < 2 THEN
      RAISE EXCEPTION 'fn_event_create_cluster_relation : SPLIT exige au moins 2 clusters destination distincts (reçu %).', cardinality(v_sorted_to);
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 2 — dérivation CANONIQUE des arêtes candidates (jamais un
  -- payload d'arêtes fourni par l'appelant). MERGE : chaque source ->
  -- l'unique destination. SPLIT : l'unique source -> chaque destination.
  -- v_candidate_from[i] -> v_candidate_to[i] représente l'arête i.
  -- ---------------------------------------------------------------
  IF p_operation_type = 'MERGE' THEN
    v_candidate_from := v_sorted_from;
    v_candidate_to := array_fill(v_sorted_to[1], ARRAY[cardinality(v_sorted_from)]);
  ELSE
    v_candidate_from := array_fill(v_sorted_from[1], ARRAY[cardinality(v_sorted_to)]);
    v_candidate_to := v_sorted_to;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 3 — pré-vérification d'idempotence (chemin rapide, AVANT tout
  -- verrou). Intention canonique COMPLÈTE : operation_type, ensembles
  -- triés from/to, ensemble EXACT d'arêtes dérivées, métadonnées,
  -- supersedes_operation_id. L'opération existante doit elle-même être
  -- structurellement valide pour son operation_type (filet anti-
  -- corruption).
  -- ---------------------------------------------------------------
  SELECT o.operation_id, o.operation_type, o.algorithm_version, o.decision_actor,
         o.reason, o.supersedes_operation_id
    INTO v_existing
    FROM public.event_cluster_relation_operations o
    WHERE o.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    SELECT count(DISTINCT e.from_cluster_id), count(DISTINCT e.to_cluster_id)
      INTO v_existing_from_ct, v_existing_to_ct
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;

    IF (v_existing.operation_type = 'MERGE' AND (v_existing_from_ct < 2 OR v_existing_to_ct <> 1))
       OR (v_existing.operation_type = 'SPLIT' AND (v_existing_from_ct <> 1 OR v_existing_to_ct < 2))
    THEN
      RAISE EXCEPTION
        'fn_event_create_cluster_relation : opération existante % (idempotency_fingerprint %) a un ensemble d''arêtes structurellement invalide pour son operation_type % — corruption.',
        v_existing.operation_id, p_idempotency_fingerprint, v_existing.operation_type;
    END IF;

    SELECT array_agg(DISTINCT e.from_cluster_id ORDER BY e.from_cluster_id)
      INTO v_existing_sorted_from
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;
    SELECT array_agg(DISTINCT e.to_cluster_id ORDER BY e.to_cluster_id)
      INTO v_existing_sorted_to
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;
    SELECT count(*) INTO v_existing_edge_count
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;

    SELECT NOT EXISTS (
      SELECT 1 FROM generate_subscripts(v_candidate_from, 1) i
      WHERE NOT EXISTS (
        SELECT 1 FROM public.event_cluster_relation_edges e
        WHERE e.operation_id = v_existing.operation_id
          AND e.from_cluster_id = v_candidate_from[i]
          AND e.to_cluster_id = v_candidate_to[i]
      )
    ) INTO v_edge_set_matches;

    IF v_existing.operation_type IS DISTINCT FROM p_operation_type
       OR v_existing_sorted_from IS DISTINCT FROM v_sorted_from
       OR v_existing_sorted_to IS DISTINCT FROM v_sorted_to
       OR v_existing_edge_count IS DISTINCT FROM cardinality(v_candidate_from)
       OR NOT v_edge_set_matches
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing.reason IS DISTINCT FROM p_reason
       OR v_existing.supersedes_operation_id IS DISTINCT FROM p_supersedes_operation_id
    THEN
      RAISE EXCEPTION
        'fn_event_create_cluster_relation : idempotency_fingerprint % est déjà lié à une intention canonique différente (operation_id=%) — collision, pas un rejeu.',
        p_idempotency_fingerprint, v_existing.operation_id;
    END IF;

    RETURN QUERY SELECT v_existing.operation_id, v_existing.operation_type, v_existing_sorted_from, v_existing_sorted_to, v_existing.supersedes_operation_id, v_existing_edge_count, true;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 4 — verrou GLOBAL de topologie, AVANT tout verrou de cluster.
  -- ---------------------------------------------------------------
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('xau_v2:event_relation'),
    pg_catalog.hashtext('topology')
  );

  -- ---------------------------------------------------------------
  -- ÉTAPE 5 — CHARGEMENT du prédécesseur de supersession (existence +
  -- ses clusters impliqués via ses arêtes), SOUS LE VERROU GLOBAL. PAS
  -- ENCORE de rejet de fraîcheur périmée ici (voir en-tête de fichier,
  -- leçon RÉVIEW-FIX-001 de 0018) : nécessaire pour établir l'ensemble
  -- COMPLET des clusters à verrouiller (étape 6).
  -- ---------------------------------------------------------------
  IF p_supersedes_operation_id IS NOT NULL THEN
    SELECT o.operation_id INTO v_predecessor
      FROM public.event_cluster_relation_operations o
      WHERE o.operation_id = p_supersedes_operation_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'fn_event_create_cluster_relation : prédécesseur % (p_supersedes_operation_id) introuvable.',
        p_supersedes_operation_id;
    END IF;

    SELECT array_agg(DISTINCT e.from_cluster_id), array_agg(DISTINCT e.to_cluster_id)
      INTO v_predecessor_from_clusters, v_predecessor_to_clusters
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = p_supersedes_operation_id;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 6 — ensemble COMPLET des clusters impliqués (candidats +
  -- prédécesseur le cas échéant), dédupliqué, TRIÉ par UUID, verrouillé
  -- un par un via le SEUL primitif partagé fn_event_lock_cluster.
  -- ---------------------------------------------------------------
  SELECT array_agg(DISTINCT c ORDER BY c)
    INTO v_lock_cluster_ids
    FROM unnest(
      v_sorted_from || v_sorted_to
      || COALESCE(v_predecessor_from_clusters, ARRAY[]::UUID[])
      || COALESCE(v_predecessor_to_clusters, ARRAY[]::UUID[])
    ) AS c;

  FOREACH v_lock_cluster_id IN ARRAY v_lock_cluster_ids LOOP
    PERFORM public.fn_event_lock_cluster(v_lock_cluster_id);
  END LOOP;

  -- ---------------------------------------------------------------
  -- ÉTAPE 7 — RE-vérification d'idempotence, APRÈS le verrou global ET
  -- TOUS les verrous de cluster : couvre un appel concurrent identique
  -- ayant commité pendant l'attente. Logique identique à l'étape 3.
  -- CETTE RE-VÉRIFICATION DOIT SURVENIR AVANT le rejet de fraîcheur
  -- périmée (étape 9) — sinon un rejeu concurrent identique verrait à
  -- tort son propre prédécesseur comme périmé par le successeur que
  -- l'appel gagnant vient de committer à l'identique.
  -- ---------------------------------------------------------------
  SELECT o.operation_id, o.operation_type, o.algorithm_version, o.decision_actor,
         o.reason, o.supersedes_operation_id
    INTO v_existing
    FROM public.event_cluster_relation_operations o
    WHERE o.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    SELECT count(DISTINCT e.from_cluster_id), count(DISTINCT e.to_cluster_id)
      INTO v_existing_from_ct, v_existing_to_ct
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;

    IF (v_existing.operation_type = 'MERGE' AND (v_existing_from_ct < 2 OR v_existing_to_ct <> 1))
       OR (v_existing.operation_type = 'SPLIT' AND (v_existing_from_ct <> 1 OR v_existing_to_ct < 2))
    THEN
      RAISE EXCEPTION
        'fn_event_create_cluster_relation : opération existante % (idempotency_fingerprint %) a un ensemble d''arêtes structurellement invalide pour son operation_type % — corruption.',
        v_existing.operation_id, p_idempotency_fingerprint, v_existing.operation_type;
    END IF;

    SELECT array_agg(DISTINCT e.from_cluster_id ORDER BY e.from_cluster_id)
      INTO v_existing_sorted_from
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;
    SELECT array_agg(DISTINCT e.to_cluster_id ORDER BY e.to_cluster_id)
      INTO v_existing_sorted_to
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;
    SELECT count(*) INTO v_existing_edge_count
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;

    SELECT NOT EXISTS (
      SELECT 1 FROM generate_subscripts(v_candidate_from, 1) i
      WHERE NOT EXISTS (
        SELECT 1 FROM public.event_cluster_relation_edges e
        WHERE e.operation_id = v_existing.operation_id
          AND e.from_cluster_id = v_candidate_from[i]
          AND e.to_cluster_id = v_candidate_to[i]
      )
    ) INTO v_edge_set_matches;

    IF v_existing.operation_type IS DISTINCT FROM p_operation_type
       OR v_existing_sorted_from IS DISTINCT FROM v_sorted_from
       OR v_existing_sorted_to IS DISTINCT FROM v_sorted_to
       OR v_existing_edge_count IS DISTINCT FROM cardinality(v_candidate_from)
       OR NOT v_edge_set_matches
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing.reason IS DISTINCT FROM p_reason
       OR v_existing.supersedes_operation_id IS DISTINCT FROM p_supersedes_operation_id
    THEN
      RAISE EXCEPTION
        'fn_event_create_cluster_relation : idempotency_fingerprint % est déjà lié à une intention canonique différente (operation_id=%) — collision, pas un rejeu.',
        p_idempotency_fingerprint, v_existing.operation_id;
    END IF;

    RETURN QUERY SELECT v_existing.operation_id, v_existing.operation_type, v_existing_sorted_from, v_existing_sorted_to, v_existing.supersedes_operation_id, v_existing_edge_count, true;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 8 — existence de CHAQUE cluster candidat (nouveaux
  -- uniquement — les clusters d'arêtes du prédécesseur existent déjà
  -- via FK, jamais mutés ici).
  -- ---------------------------------------------------------------
  SELECT c INTO v_missing_cluster_id
    FROM unnest(v_sorted_from || v_sorted_to) c
    WHERE NOT EXISTS (SELECT 1 FROM public.event_clusters ec WHERE ec.id = c)
    LIMIT 1;

  IF v_missing_cluster_id IS NOT NULL THEN
    RAISE EXCEPTION 'fn_event_create_cluster_relation : cluster candidat % introuvable.', v_missing_cluster_id;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 9 — SEULEMENT MAINTENANT que le rejeu a été explicitement
  -- écarté (étape 7) : rejet de fraîcheur périmée (successeur déjà
  -- existant — détection PRIMAIRE par lecture dédiée, PAS une
  -- dépendance exclusive à uq_cluster_relation_ops_supersedes pour le
  -- flux normal). La nouvelle opération PEUT librement changer de type
  -- (MERGE<->SPLIT) par rapport au prédécesseur : une supersession est
  -- une correction curée explicite de l'interprétation relationnelle
  -- antérieure, jamais une conversion automatique.
  -- ---------------------------------------------------------------
  IF p_supersedes_operation_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.event_cluster_relation_operations successor
      WHERE successor.supersedes_operation_id = p_supersedes_operation_id
    ) INTO v_predecessor_successor_exists;

    IF v_predecessor_successor_exists THEN
      RAISE EXCEPTION
        'fn_event_create_cluster_relation : prédécesseur % périmé — un successeur existe déjà.',
        p_supersedes_operation_id;
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 10 — prévention de cycle, SOUS LE VERROU GLOBAL. Graphe =
  -- arêtes ACTIVES (aucun successeur), EXCLUANT celles du prédécesseur
  -- corrigé (remplacé atomiquement), PLUS les arêtes CANDIDATES.
  -- Fermeture transitive via UNE SEULE CTE récursive (UNION, jamais
  -- UNION ALL — borne le nombre d'itérations, immunise contre un cycle
  -- déjà présent dans des données malformées préexistantes). Pour
  -- chaque arête candidate U->V, aucun chemin V->...->U ne doit exister.
  -- ---------------------------------------------------------------
  WITH RECURSIVE
    active_edges AS (
      SELECT e.from_cluster_id, e.to_cluster_id
        FROM public.event_cluster_relation_edges e
       WHERE NOT EXISTS (
               SELECT 1 FROM public.event_cluster_relation_operations successor
                WHERE successor.supersedes_operation_id = e.operation_id
             )
         AND (p_supersedes_operation_id IS NULL OR e.operation_id <> p_supersedes_operation_id)
    ),
    candidate_edges AS (
      SELECT v_candidate_from[i] AS from_cluster_id, v_candidate_to[i] AS to_cluster_id
        FROM generate_subscripts(v_candidate_from, 1) AS i
    ),
    graph_edges AS (
      SELECT from_cluster_id, to_cluster_id FROM active_edges
      UNION
      SELECT from_cluster_id, to_cluster_id FROM candidate_edges
    ),
    reachable (start_node, end_node) AS (
      SELECT from_cluster_id, to_cluster_id FROM graph_edges
      UNION
      SELECT r.start_node, g.to_cluster_id
        FROM reachable r
        JOIN graph_edges g ON g.from_cluster_id = r.end_node
    )
  SELECT v_candidate_from[i], v_candidate_to[i]
    INTO v_cycle_edge_from, v_cycle_edge_to
    FROM generate_subscripts(v_candidate_from, 1) i
    JOIN reachable r
      ON r.start_node = v_candidate_to[i]
     AND r.end_node = v_candidate_from[i]
   LIMIT 1;

  IF v_cycle_edge_from IS NOT NULL THEN
    RAISE EXCEPTION
      'fn_event_create_cluster_relation : cycle rejeté — l''arête candidate % -> % fermerait un cycle dirigé (un chemin % -> ... -> % existe déjà dans le graphe actif+candidat résultant).',
      v_cycle_edge_from, v_cycle_edge_to, v_cycle_edge_to, v_cycle_edge_from;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 11 — insertion atomique : UN en-tête + l'ensemble COMPLET des
  -- arêtes dérivées, dans le MÊME bloc BEGIN/EXCEPTION. Alias de table
  -- explicite qualifié + RETURNING qualifié (leçon 0015 — RETURNS
  -- TABLE porte une colonne "operation_id" identique à la colonne réelle
  -- de la table).
  -- ---------------------------------------------------------------
  BEGIN
    INSERT INTO public.event_cluster_relation_operations AS o (
      operation_type, algorithm_version, decision_actor, reason,
      supersedes_operation_id, idempotency_fingerprint
    ) VALUES (
      p_operation_type, p_algorithm_version, p_decision_actor, p_reason,
      p_supersedes_operation_id, p_idempotency_fingerprint
    )
    RETURNING o.operation_id INTO v_operation_id;

    INSERT INTO public.event_cluster_relation_edges (operation_id, from_cluster_id, to_cluster_id)
    SELECT v_operation_id, v_candidate_from[i], v_candidate_to[i]
      FROM generate_subscripts(v_candidate_from, 1) i;

    RETURN QUERY SELECT v_operation_id, p_operation_type, v_sorted_from, v_sorted_to, p_supersedes_operation_id, cardinality(v_candidate_from), false;
    RETURN;

  EXCEPTION WHEN unique_violation THEN
    -- Filet de sécurité : collision GLOBALE d'idempotency_fingerprint
    -- (unique sur TOUTE la table). On ne récupère QUE cette violation
    -- précise : uq_cluster_relation_ops_supersedes (ou toute autre,
    -- y compris le trigger différé de cardinalité) est relevée telle
    -- quelle (re-RAISE) — la fraîcheur du prédécesseur est déjà censée
    -- être garantie par la détection explicite de l'étape 9, sous
    -- verrou, après exclusion du rejeu à l'étape 7.
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IS DISTINCT FROM 'uq_cluster_relation_ops_idempotency_fingerprint' THEN
      RAISE;
    END IF;

    SELECT o.operation_id, o.operation_type, o.algorithm_version, o.decision_actor,
           o.reason, o.supersedes_operation_id
      INTO v_existing
      FROM public.event_cluster_relation_operations o
      WHERE o.idempotency_fingerprint = p_idempotency_fingerprint;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'fn_event_create_cluster_relation : violation d''unicité sur idempotency_fingerprint % mais aucune opération committée retrouvée — corruption réelle, pas un rejeu.',
        p_idempotency_fingerprint;
    END IF;

    SELECT count(DISTINCT e.from_cluster_id), count(DISTINCT e.to_cluster_id)
      INTO v_existing_from_ct, v_existing_to_ct
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;

    IF (v_existing.operation_type = 'MERGE' AND (v_existing_from_ct < 2 OR v_existing_to_ct <> 1))
       OR (v_existing.operation_type = 'SPLIT' AND (v_existing_from_ct <> 1 OR v_existing_to_ct < 2))
    THEN
      RAISE EXCEPTION
        'fn_event_create_cluster_relation : opération existante % (idempotency_fingerprint %) a un ensemble d''arêtes structurellement invalide pour son operation_type % — corruption.',
        v_existing.operation_id, p_idempotency_fingerprint, v_existing.operation_type;
    END IF;

    SELECT array_agg(DISTINCT e.from_cluster_id ORDER BY e.from_cluster_id)
      INTO v_existing_sorted_from
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;
    SELECT array_agg(DISTINCT e.to_cluster_id ORDER BY e.to_cluster_id)
      INTO v_existing_sorted_to
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;
    SELECT count(*) INTO v_existing_edge_count
      FROM public.event_cluster_relation_edges e
      WHERE e.operation_id = v_existing.operation_id;

    SELECT NOT EXISTS (
      SELECT 1 FROM generate_subscripts(v_candidate_from, 1) i
      WHERE NOT EXISTS (
        SELECT 1 FROM public.event_cluster_relation_edges e
        WHERE e.operation_id = v_existing.operation_id
          AND e.from_cluster_id = v_candidate_from[i]
          AND e.to_cluster_id = v_candidate_to[i]
      )
    ) INTO v_edge_set_matches;

    IF v_existing.operation_type IS DISTINCT FROM p_operation_type
       OR v_existing_sorted_from IS DISTINCT FROM v_sorted_from
       OR v_existing_sorted_to IS DISTINCT FROM v_sorted_to
       OR v_existing_edge_count IS DISTINCT FROM cardinality(v_candidate_from)
       OR NOT v_edge_set_matches
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing.reason IS DISTINCT FROM p_reason
       OR v_existing.supersedes_operation_id IS DISTINCT FROM p_supersedes_operation_id
    THEN
      RAISE EXCEPTION
        'fn_event_create_cluster_relation : violation d''unicité sur idempotency_fingerprint % dont l''intention committée diffère de cet appel — collision réelle, pas un rejeu.',
        p_idempotency_fingerprint;
    END IF;

    RETURN QUERY SELECT v_existing.operation_id, v_existing.operation_type, v_existing_sorted_from, v_existing_sorted_to, v_existing.supersedes_operation_id, v_existing_edge_count, true;
    RETURN;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_event_create_cluster_relation(
  TEXT, UUID[], UUID[], TEXT, TEXT, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_event_create_cluster_relation(
  TEXT, UUID[], UUID[], TEXT, TEXT, TEXT, TEXT, UUID
) TO service_role;

COMMENT ON FUNCTION public.fn_event_create_cluster_relation IS
  'RPC atomique OPS-023 : mutation de relation de cluster (MERGE/SPLIT), en-tête + ensemble complet d''arêtes canoniquement dérivées, insérés atomiquement. Verrou GLOBAL de topologie (xau_v2:event_relation/topology) AVANT tout verrou de cluster (nécessaire pour une prévention de cycle race-free sur le graphe actif complet), puis verrous de cluster triés par UUID via fn_event_lock_cluster. Idempotente à l''échelle de l''opération entière (précheck + recheck post-verrous + récupération scopée sur uq_cluster_relation_ops_idempotency_fingerprint). Rejet de fraîcheur périmée du prédécesseur DIFFÉRÉ après le recheck post-verrous. Prévention de cycle sur le graphe actif (excluant le prédécesseur corrigé) + arêtes candidates, via CTE récursive UNION bornée. Jamais de décision automatique de MERGE/SPLIT, jamais d''UPDATE/DELETE.';

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
--      AND p.proname = 'fn_event_create_cluster_relation';
--   -- attendu : search_path_setting = 'search_path=', prosecdef = false.
--
--   -- Probe de non-pollution (à exécuter en transaction, ROLLBACK
--   -- systématique — ne jamais committer une probe de test). Suppose
--   -- trois clusters préexistants <c1>, <c2>, <c3> :
--   BEGIN;
--     SELECT * FROM fn_event_create_cluster_relation(
--       p_operation_type := 'MERGE',
--       p_from_cluster_ids := ARRAY['<c1>','<c2>']::uuid[],
--       p_to_cluster_ids := ARRAY['<c3>']::uuid[],
--       p_algorithm_version := 'probe-v1',
--       p_decision_actor := 'ops023-probe',
--       p_reason := 'probe initial merge',
--       p_idempotency_fingerprint := 'probe-fp-relation-001'
--     );
--     -- attendu : une ligne, edge_count=2, replayed=false. Rejouer le
--     -- même appel : attendu replayed=true, aucune nouvelle ligne.
--     -- Puis tenter un SPLIT <c3> -> {<c1>,<c2>} SANS supersession :
--     -- attendu une exception de cycle explicite (referme la boucle
--     -- créée par le MERGE précédent).
--   ROLLBACK;
-- =====================================================================
