-- =====================================================================
--  ALPHA-XAU — database/migrations/0018_event_identity_claim_rpc.sql
--
--  OBJET : primitif transactionnel OPS-023 Phase 2 (suite) — revendication
--  atomique d'IDENTITÉ FORTE D'ÉVÉNEMENT sur la table déjà gelée (0012)
--
--    public.event_cluster_identity_claims
--
--  Une identité forte identifie un ÉVÉNEMENT RÉEL — jamais une
--  observation. C'est EXACTEMENT le triplet namespacé :
--
--    authority_namespace + identity_type + identity_value
--
--  -> strong_identity_key (sha256 hex, GENERATED STORED, formule gelée
--     en 0012, NON modifiée ici).
--
--  Cette RPC gère :
--    - la première assertion d'une identité forte curée sur un cluster ;
--    - la correction/supersession explicite d'une revendication
--      antérieure (métadonnées, ou changement de la clé elle-même) ;
--    - le verrouillage déterministe de la clé d'identité forte, AVANT
--      toute validation de collision ;
--    - le rejet explicite d'une collision inter-cluster (jamais une
--      fusion automatique) ;
--    - l'idempotence retry-safe.
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - les migrations 0012-0017 (fichiers immuables, déjà appliqués —
--      NON modifiées) ;
--    - aucune table, contrainte, trigger, policy RLS existants, aucun
--      grant de table (seuls des GRANT/REVOKE de fonction sont
--      introduits ici) ;
--    - fn_event_lock_cluster (réutilisée telle quelle, non redéfinie) ;
--    - la formule GENERATED de strong_identity_key (recalculée ici à
--      l'identique, byte pour byte, jamais réinterprétée).
--
--  N'IMPLÉMENTE JAMAIS : fusion/scission automatique de cluster, arêtes
--  de relation, prévention de cycle, création d'EVENT VERSION,
--  changement de membership, processeur, worker/cron, Comité, Event
--  Impact, Gold Transmission, Silver Edge, notification, legacy,
--  frontend, Cloudflare, Anthropic. Aucune nouvelle table, aucun nouvel
--  index, aucune fonction utilitaire supplémentaire.
--
--  SOURCE DE L'IDENTITÉ : authority_namespace/identity_type/
--  identity_value sont des FAITS D'IDENTITÉ D'ÉVÉNEMENT CURÉS, fournis
--  explicitement par l'appelant. Cette RPC NE LIT JAMAIS news_articles
--  et NE DÉRIVE JAMAIS d'identité depuis provider_item_id/canonical_url/
--  URL d'article/identifiants provider-source-domain — cette promotion
--  automatique d'identifiant d'OBSERVATION vers identifiant d'ÉVÉNEMENT
--  est explicitement hors périmètre, gelée par 0012 comme interdite.
--  Aucune normalisation silencieuse (trim/lowercase/rewrite) des valeurs
--  d'identité : la colonne GENERATED reste seule autorité sur la clé.
--
--  VERROUILLAGE + ORDRE DE VALIDATION (discipline gelée, CRITIQUE pour la
--  correction ET pour la concurrence d'un rejeu identique) :
--    1. verrou de cluster (fn_event_lock_cluster, partagé, inchangé) ;
--    2. si supersession : CHARGEMENT du prédécesseur (existence, même
--       cluster, sa strong_identity_key) — PAS ENCORE de rejet de
--       fraîcheur ni de monotonie ici ;
--    3. verrou(s) advisory de clé d'identité forte (nouveau namespace
--       'xau_v2:event_identity', DEUX clés si une supersession change de
--       clé, acquises en ordre lexical trié déterministe — sinon une
--       seule fois si les deux clés coïncident) — AVANT toute validation
--       de collision, pour qu'aucune autre transaction ne puisse insérer
--       sous la même clé pendant l'examen ;
--    4. RE-vérification d'idempotence post-verrous (voir IDEMPOTENCE
--       ci-dessous) — SI rejeu exact : retour immédiat, replayed=true ;
--    5. SEULEMENT SI CE N'EST PAS un rejeu : rejet de fraîcheur périmée
--       (successeur déjà existant) et application de la monotonie
--       temporelle ;
--    6. validation de collision de clé active ;
--    7. INSERT.
--  L'ordre trié des verrous de clé empêche deux corrections opposées
--  concurrentes (X->Y et Y->X) d'acquérir leurs verrous dans un ordre
--  incohérent. Le rejet de fraîcheur périmée DOIT survenir APRÈS la
--  re-vérification d'idempotence post-verrous, jamais avant : sinon un
--  rejeu concurrent IDENTIQUE (T2 attendant le verrou de cluster pendant
--  que T1, même intention canonique, insère puis commite le successeur)
--  verrait son propre prédécesseur comme "périmé" par le successeur que
--  T1 vient de committer à l'identique, et échouerait à tort au lieu de
--  recevoir replayed=true.
--
--  IDEMPOTENCE (à deux niveaux, identique au pattern gelé 0014/0016/0017) :
--    1. pré-vérification par idempotency_fingerprint AVANT tout verrou ;
--    2. RE-vérification identique APRÈS acquisition du verrou de cluster
--       ET du/des verrou(s) de clé d'identité (couvre un appel
--       concurrent identique ayant commité pendant l'attente) ;
--    3. récupération scopée sur violation d'unicité, limitée à
--       uq_identity_claims_idempotency_fingerprint — toute autre
--       violation (notamment uq_identity_claims_supersedes) est relevée
--       telle quelle (re-RAISE).
--  Une revendication historiquement réussie reste rejouable même si une
--  revendication ultérieure l'a depuis supersédée (l'idempotence porte
--  sur l'INTENTION de CET appel, jamais sur l'état "vivant" actuel).
--
--  COLLISION DE CLÉ ACTIVE (section gelée) : une revendication ACTIVE =
--  aucun successeur n'existe (NOT EXISTS supersedes_claim_id = son
--  identity_claim_id). Sous le verrou de clé, examen des revendications
--  ACTIVES portant la clé NOUVELLE calculée :
--    - zéro   -> éligible ;
--    - >1     -> erreur d'invariant/corruption explicite (jamais
--                silencieuse) ;
--    - exactement une :
--        A) c'est exactement p_supersedes_claim_id, sur le MÊME cluster,
--           et cette supersession conserve la MÊME clé -> AUTORISÉ (le
--           INSERT supersédera ce prédécesseur actif) ;
--        B) MÊME cluster mais PAS le prédécesseur explicitement
--           supersédé -> REJET (assertion d'identité active dupliquée) ;
--        C) cluster DIFFÉRENT -> REJET (collision d'identité forte
--           inter-cluster).
--  Cette RPC NE déplace JAMAIS une revendication, NE fusionne JAMAIS de
--  cluster, NE mute JAMAIS un cluster, NE choisit JAMAIS un gagnant
--  silencieusement. Une collision inter-cluster est un FAIT nécessitant
--  une résolution explicite ultérieure (relation de cluster), hors
--  périmètre ici.
--
--  FRAÎCHEUR DU PRÉDÉCESSEUR (supersession) : existence et MÊME
--  cluster_id vérifiés sous verrou de cluster (chargement, étape 2
--  ci-dessus) ; détection EXPLICITE d'un successeur déjà existant
--  (lecture dédiée, PAS une dépendance exclusive à
--  uq_identity_claims_supersedes) et monotonie temporelle
--  (p_knowledge_cutoff >= prédécesseur.knowledge_cutoff) appliquées
--  seulement APRÈS la re-vérification d'idempotence post-verrous (étape
--  5 ci-dessus) — jamais avant, pour ne jamais faire échouer à tort un
--  rejeu concurrent identique. Une
--  supersession PEUT conserver la même strong_identity_key (correction
--  de métadonnées/raison) OU changer authority_namespace/identity_type/
--  identity_value — donc changer la clé — TOUJOURS comme correction
--  curée explicite, jamais une réécriture automatique.
--
--  AMBIGUÏTÉ RETURNING (leçon 0015, appliquée dès la création) : alias
--  de table explicite qualifié (AS c) et RETURNING c.identity_claim_id,
--  c.strong_identity_key INTO <variables dédiées>. La clé GENERATED
--  réellement matérialisée par l'INSERT est comparée à la clé calculée
--  par la RPC ; toute divergence lève une erreur d'invariant (ne devrait
--  jamais se produire si la formule reste identique — filet de sécurité
--  contre une dérive future de la colonne GENERATED).
--
--  SÉCURITÉ : SECURITY INVOKER (explicite), SET search_path = '' (durci
--  dès la création), toutes les références de relation qualifiées
--  public./pg_catalog./extensions., EXECUTE révoqué de PUBLIC/anon/
--  authenticated puis accordé à service_role uniquement. Aucun code
--  SECURITY DEFINER. Grants et RLS des TABLES existantes strictement
--  inchangés.
--
--  TRANSACTIONNELLE : BEGIN ... COMMIT. IDEMPOTENTE (fichier) :
--  CREATE OR REPLACE FUNCTION — rejouable sans effet si déjà appliquée.
--
--  VÉRIFICATION TRANSACTIONNELLE RÉELLE : les tests déterministes de ce
--  dépôt (analyse statique du texte SQL, sans PostgreSQL) NE PROUVENT
--  PAS le comportement transactionnel réel (verrouillage advisory
--  effectif, ordre réel d'acquisition, concurrence réelle). Une
--  vérification live contre Supabase (rollback/probes de non-pollution)
--  sera effectuée indépendamment, APRÈS fusion — hors périmètre de
--  cette migration.
--
--  PRÉREQUIS : migrations 0001-0017 (event_clusters,
--  event_cluster_identity_claims, fn_event_lock_cluster).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- public.fn_event_assert_identity_claim(...) RETURNS TABLE(...)
--
--    Paramètres SCALAIRES explicites (pas de payload JSON opaque).
--    ORDRE DE DÉCLARATION : les paramètres obligatoires (sans défaut)
--    sont déclarés en premier, puis p_supersedes_claim_id (DEFAULT
--    NULL) — PostgreSQL l'exige. Cet ordre SQL ne change rien à l'appel
--    via PostgREST (rpc/fn_event_assert_identity_claim), qui passe les
--    arguments par NOM (corps JSON), pas par position.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_assert_identity_claim(
  -- --- Obligatoires (sans défaut) ---
  p_cluster_id               UUID,
  p_authority_namespace      TEXT,
  p_identity_type            TEXT,
  p_identity_value           TEXT,
  p_knowledge_cutoff         TIMESTAMPTZ,
  p_algorithm_version        TEXT,
  p_decision_actor           TEXT,
  p_reason                   TEXT,
  p_idempotency_fingerprint  TEXT,
  -- --- Optionnel (supersession) ---
  p_supersedes_claim_id      UUID DEFAULT NULL
)
RETURNS TABLE (
  cluster_id             UUID,
  identity_claim_id      UUID,
  strong_identity_key    TEXT,
  superseded_claim_id    UUID,
  replayed               BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_new_strong_identity_key   TEXT;
  v_old_strong_identity_key   TEXT;
  v_existing                  RECORD;
  v_predecessor                RECORD;
  v_predecessor_successor_exists  BOOLEAN;
  v_lock_key_first             TEXT;
  v_lock_key_second            TEXT;
  v_active_claim_count         INTEGER;
  v_active_claim                RECORD;
  v_identity_claim_id           UUID;
  v_returned_strong_identity_key  TEXT;
  v_constraint_name             TEXT;
BEGIN
  -- ---------------------------------------------------------------
  -- ÉTAPE 1 — validation scalaire de base (aucune lecture DB), intégrité
  -- temporelle, calcul de la clé NOUVELLE (même formule byte pour byte
  -- que la colonne GENERATED de event_cluster_identity_claims, 0012).
  -- ---------------------------------------------------------------
  IF p_cluster_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_assert_identity_claim : p_cluster_id ne peut pas être NULL.';
  END IF;
  IF p_authority_namespace IS NULL OR length(btrim(p_authority_namespace)) = 0 THEN
    RAISE EXCEPTION 'fn_event_assert_identity_claim : p_authority_namespace est obligatoire et non vide.';
  END IF;
  IF p_identity_type IS NULL OR length(btrim(p_identity_type)) = 0 THEN
    RAISE EXCEPTION 'fn_event_assert_identity_claim : p_identity_type est obligatoire et non vide.';
  END IF;
  IF p_identity_value IS NULL OR length(btrim(p_identity_value)) = 0 THEN
    RAISE EXCEPTION 'fn_event_assert_identity_claim : p_identity_value est obligatoire et non vide.';
  END IF;
  IF p_knowledge_cutoff IS NULL THEN
    RAISE EXCEPTION 'fn_event_assert_identity_claim : p_knowledge_cutoff ne peut pas être NULL.';
  END IF;
  IF p_algorithm_version IS NULL OR length(btrim(p_algorithm_version)) = 0 THEN
    RAISE EXCEPTION 'fn_event_assert_identity_claim : p_algorithm_version est obligatoire et non vide.';
  END IF;
  IF p_decision_actor IS NULL OR length(btrim(p_decision_actor)) = 0 THEN
    RAISE EXCEPTION 'fn_event_assert_identity_claim : p_decision_actor est obligatoire et non vide.';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'fn_event_assert_identity_claim : p_reason est obligatoire et non vide.';
  END IF;
  IF p_idempotency_fingerprint IS NULL OR length(btrim(p_idempotency_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fn_event_assert_identity_claim : p_idempotency_fingerprint est obligatoire et non vide.';
  END IF;

  -- Intégrité temporelle : un cutoff historique/de rejeu est autorisé,
  -- jamais un cutoff dans le futur.
  IF p_knowledge_cutoff > pg_catalog.transaction_timestamp() THEN
    RAISE EXCEPTION
      'fn_event_assert_identity_claim : p_knowledge_cutoff (%) ne peut pas être postérieur à transaction_timestamp() (%).',
      p_knowledge_cutoff, pg_catalog.transaction_timestamp();
  END IF;

  -- Même formule EXACTE que la colonne GENERATED strong_identity_key
  -- (0012) : authority_namespace || chr(31) || identity_type ||
  -- chr(31) || identity_value, sha256 hex. Aucune normalisation
  -- silencieuse des valeurs sources.
  v_new_strong_identity_key := encode(
    extensions.digest(
      p_authority_namespace || chr(31) || p_identity_type || chr(31) || p_identity_value,
      'sha256'
    ),
    'hex'
  );

  -- ---------------------------------------------------------------
  -- ÉTAPE 2 — pré-vérification d'idempotence (chemin rapide, AVANT tout
  -- verrou). Une empreinte identique ne suffit JAMAIS seule à justifier
  -- un retour silencieux : l'intention canonique complète est validée,
  -- y compris la clé d'identité forte CALCULÉE (pas seulement les
  -- champs bruts). Une revendication historique reste rejouable même si
  -- supersédée depuis (l'idempotence porte sur l'intention de CET
  -- appel, jamais sur l'état "vivant" actuel).
  -- ---------------------------------------------------------------
  SELECT c.identity_claim_id, c.cluster_id, c.authority_namespace, c.identity_type,
         c.identity_value, c.strong_identity_key, c.knowledge_cutoff,
         c.algorithm_version, c.decision_actor, c.reason, c.supersedes_claim_id
    INTO v_existing
    FROM public.event_cluster_identity_claims c
    WHERE c.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    IF v_existing.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_existing.authority_namespace IS DISTINCT FROM p_authority_namespace
       OR v_existing.identity_type IS DISTINCT FROM p_identity_type
       OR v_existing.identity_value IS DISTINCT FROM p_identity_value
       OR v_existing.strong_identity_key IS DISTINCT FROM v_new_strong_identity_key
       OR v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing.reason IS DISTINCT FROM p_reason
       OR v_existing.supersedes_claim_id IS DISTINCT FROM p_supersedes_claim_id
    THEN
      RAISE EXCEPTION
        'fn_event_assert_identity_claim : idempotency_fingerprint % est déjà lié à une intention canonique différente (identity_claim_id=%) — collision, pas un rejeu.',
        p_idempotency_fingerprint, v_existing.identity_claim_id;
    END IF;

    RETURN QUERY SELECT v_existing.cluster_id, v_existing.identity_claim_id, v_existing.strong_identity_key, v_existing.supersedes_claim_id, true;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 3 — verrou de cluster (primitif partagé, inchangé), puis
  -- existence du cluster.
  -- ---------------------------------------------------------------
  PERFORM public.fn_event_lock_cluster(p_cluster_id);

  IF NOT EXISTS (SELECT 1 FROM public.event_clusters WHERE id = p_cluster_id) THEN
    RAISE EXCEPTION 'fn_event_assert_identity_claim : cluster % introuvable.', p_cluster_id;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 4 — CHARGEMENT du prédécesseur de supersession, SOUS LE
  -- VERROU DE CLUSTER : existence, MÊME cluster, et obtention de
  -- v_old_strong_identity_key (NULL si assertion fraîche indépendante)
  -- — nécessaire pour savoir QUELLE(S) clé(s) verrouiller à l'étape 5.
  --
  -- NE REJETTE PAS ENCORE pour fraîcheur périmée (successeur déjà
  -- existant) ni pour monotonie temporelle : un rejet ICI, AVANT le
  -- verrou de clé et la RE-vérification d'idempotence post-verrous,
  -- ferait échouer à tort un rejeu concurrent IDENTIQUE (même cluster,
  -- même prédécesseur, même intention canonique, même
  -- idempotency_fingerprint) qui a commité entre le précheck (étape 2)
  -- et l'acquisition du verrou de cluster (étape 3) — ce second appel
  -- verrait alors son prédécesseur comme "périmé" (un successeur —
  -- justement CETTE ligne rejouée à l'identique — existe déjà) alors
  -- qu'il devrait recevoir replayed=true. Le rejet de fraîcheur/
  -- monotonie est donc DIFFÉRÉ à l'étape 7, APRÈS que la RE-vérification
  -- d'idempotence post-verrous (étape 6) ait explicitement écarté
  -- l'hypothèse du rejeu.
  -- ---------------------------------------------------------------
  IF p_supersedes_claim_id IS NOT NULL THEN
    SELECT c.identity_claim_id, c.cluster_id, c.strong_identity_key, c.knowledge_cutoff
      INTO v_predecessor
      FROM public.event_cluster_identity_claims c
      WHERE c.identity_claim_id = p_supersedes_claim_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'fn_event_assert_identity_claim : prédécesseur % (p_supersedes_claim_id) introuvable.',
        p_supersedes_claim_id;
    END IF;
    IF v_predecessor.cluster_id IS DISTINCT FROM p_cluster_id THEN
      RAISE EXCEPTION
        'fn_event_assert_identity_claim : le prédécesseur % porte sur un cluster différent (attendu %, trouvé %).',
        p_supersedes_claim_id, p_cluster_id, v_predecessor.cluster_id;
    END IF;

    v_old_strong_identity_key := v_predecessor.strong_identity_key;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 5 — verrou(s) advisory de clé d'identité forte, namespace
  -- dédié 'xau_v2:event_identity', APRÈS le verrou de cluster et AVANT
  -- toute validation de collision. Deux clés distinctes (supersession
  -- changeant de clé) -> verrouillées en ordre LEXICAL trié déterministe
  -- (indépendant du sens X->Y vs Y->X) ; clés identiques -> un seul
  -- verrou.
  -- ---------------------------------------------------------------
  IF p_supersedes_claim_id IS NOT NULL AND v_old_strong_identity_key IS DISTINCT FROM v_new_strong_identity_key THEN
    IF v_old_strong_identity_key < v_new_strong_identity_key THEN
      v_lock_key_first := v_old_strong_identity_key;
      v_lock_key_second := v_new_strong_identity_key;
    ELSE
      v_lock_key_first := v_new_strong_identity_key;
      v_lock_key_second := v_old_strong_identity_key;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('xau_v2:event_identity'),
      pg_catalog.hashtext(v_lock_key_first)
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('xau_v2:event_identity'),
      pg_catalog.hashtext(v_lock_key_second)
    );
  ELSE
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('xau_v2:event_identity'),
      pg_catalog.hashtext(v_new_strong_identity_key)
    );
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 6 — RE-vérification d'idempotence, APRÈS le verrou de cluster
  -- ET le/les verrou(s) de clé d'identité : couvre un appel concurrent
  -- identique ayant commité PENDANT que cet appel attendait les
  -- verrous. Logique identique à l'étape 2.
  -- ---------------------------------------------------------------
  SELECT c.identity_claim_id, c.cluster_id, c.authority_namespace, c.identity_type,
         c.identity_value, c.strong_identity_key, c.knowledge_cutoff,
         c.algorithm_version, c.decision_actor, c.reason, c.supersedes_claim_id
    INTO v_existing
    FROM public.event_cluster_identity_claims c
    WHERE c.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    IF v_existing.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_existing.authority_namespace IS DISTINCT FROM p_authority_namespace
       OR v_existing.identity_type IS DISTINCT FROM p_identity_type
       OR v_existing.identity_value IS DISTINCT FROM p_identity_value
       OR v_existing.strong_identity_key IS DISTINCT FROM v_new_strong_identity_key
       OR v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing.reason IS DISTINCT FROM p_reason
       OR v_existing.supersedes_claim_id IS DISTINCT FROM p_supersedes_claim_id
    THEN
      RAISE EXCEPTION
        'fn_event_assert_identity_claim : idempotency_fingerprint % est déjà lié à une intention canonique différente (identity_claim_id=%) — collision, pas un rejeu.',
        p_idempotency_fingerprint, v_existing.identity_claim_id;
    END IF;

    RETURN QUERY SELECT v_existing.cluster_id, v_existing.identity_claim_id, v_existing.strong_identity_key, v_existing.supersedes_claim_id, true;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 7 — SEULEMENT MAINTENANT que le rejeu a été explicitement
  -- écarté (étape 6, ci-dessus) : rejet de fraîcheur périmée (successeur
  -- déjà existant — détection PRIMAIRE par lecture dédiée, PAS une
  -- dépendance exclusive à uq_identity_claims_supersedes pour le flux
  -- normal) et application de la monotonie temporelle
  -- (p_knowledge_cutoff >= prédécesseur.knowledge_cutoff, chargé à
  -- l'étape 4). Cet ordre garantit qu'un rejeu concurrent IDENTIQUE (T2
  -- attendant le verrou de cluster pendant que T1, avec la MÊME
  -- intention canonique, insère puis commite le successeur) atteint
  -- TOUJOURS la RE-vérification d'idempotence (étape 6) avant tout rejet
  -- de fraîcheur — sans quoi T2 verrait son prédécesseur comme périmé
  -- (par le successeur que T1 vient précisément de committer à
  -- l'identique) et échouerait à tort au lieu de retourner
  -- replayed=true.
  -- ---------------------------------------------------------------
  IF p_supersedes_claim_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.event_cluster_identity_claims c
      WHERE c.supersedes_claim_id = p_supersedes_claim_id
    ) INTO v_predecessor_successor_exists;

    IF v_predecessor_successor_exists THEN
      RAISE EXCEPTION
        'fn_event_assert_identity_claim : prédécesseur % périmé — un successeur existe déjà (pas le tip vivant).',
        p_supersedes_claim_id;
    END IF;

    IF p_knowledge_cutoff < v_predecessor.knowledge_cutoff THEN
      RAISE EXCEPTION
        'fn_event_assert_identity_claim : p_knowledge_cutoff (%) est antérieur à celui du prédécesseur % (%) — une supersession doit être temporellement monotone.',
        p_knowledge_cutoff, p_supersedes_claim_id, v_predecessor.knowledge_cutoff;
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 8 — collision de clé active, SOUS LE VERROU DE CLÉ. Une
  -- revendication ACTIVE = aucun successeur (graphe append-only, jamais
  -- asserted_at seul). 0 -> éligible ; >1 -> corruption/invariant ;
  -- exactement 1 -> cas A (même prédécesseur explicite + même cluster +
  -- même clé -> autorisé), B (même cluster, pas le prédécesseur ->
  -- rejet doublon), C (cluster différent -> rejet collision
  -- inter-cluster). Ne déplace/fusionne/mute JAMAIS un cluster, ne
  -- choisit jamais de gagnant silencieusement.
  -- ---------------------------------------------------------------
  SELECT count(*) INTO v_active_claim_count
    FROM public.event_cluster_identity_claims c
    WHERE c.strong_identity_key = v_new_strong_identity_key
      AND NOT EXISTS (
        SELECT 1 FROM public.event_cluster_identity_claims successor
        WHERE successor.supersedes_claim_id = c.identity_claim_id
      );

  IF v_active_claim_count > 1 THEN
    RAISE EXCEPTION
      'fn_event_assert_identity_claim : invariant violé — % revendications ACTIVES partagent la strong_identity_key % (attendu au plus 1).',
      v_active_claim_count, v_new_strong_identity_key;
  ELSIF v_active_claim_count = 1 THEN
    SELECT c.identity_claim_id, c.cluster_id
      INTO v_active_claim
      FROM public.event_cluster_identity_claims c
      WHERE c.strong_identity_key = v_new_strong_identity_key
        AND NOT EXISTS (
          SELECT 1 FROM public.event_cluster_identity_claims successor
          WHERE successor.supersedes_claim_id = c.identity_claim_id
        );

    IF v_active_claim.identity_claim_id = p_supersedes_claim_id
       AND v_active_claim.cluster_id = p_cluster_id
       AND v_old_strong_identity_key IS NOT DISTINCT FROM v_new_strong_identity_key
    THEN
      -- Cas A : supersession explicite du prédécesseur ACTIF, même clé,
      -- même cluster -> AUTORISÉ, le INSERT ci-dessous le supersédera.
      NULL;
    ELSIF v_active_claim.cluster_id = p_cluster_id THEN
      RAISE EXCEPTION
        'fn_event_assert_identity_claim : assertion d''identité active dupliquée — la strong_identity_key % est déjà portée par la revendication ACTIVE % sur le MÊME cluster %, et ce n''est pas le prédécesseur explicitement supersédé.',
        v_new_strong_identity_key, v_active_claim.identity_claim_id, p_cluster_id;
    ELSE
      RAISE EXCEPTION
        'fn_event_assert_identity_claim : collision d''identité forte INTER-CLUSTER — la strong_identity_key % est déjà portée par la revendication ACTIVE % sur le cluster % (différent de %) ; ceci est un FAIT nécessitant une résolution explicite de relation de cluster, jamais une fusion automatique.',
        v_new_strong_identity_key, v_active_claim.identity_claim_id, v_active_claim.cluster_id, p_cluster_id;
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 9 — insertion append-only unique. Alias de table explicite
  -- qualifié + RETURNING qualifié (leçon 0015). La clé GENERATED
  -- réellement matérialisée est comparée à la clé calculée par la RPC.
  -- ---------------------------------------------------------------
  BEGIN
    INSERT INTO public.event_cluster_identity_claims AS c (
      cluster_id, authority_namespace, identity_type, identity_value,
      knowledge_cutoff, algorithm_version, decision_actor, reason,
      supersedes_claim_id, idempotency_fingerprint
    ) VALUES (
      p_cluster_id, p_authority_namespace, p_identity_type, p_identity_value,
      p_knowledge_cutoff, p_algorithm_version, p_decision_actor, p_reason,
      p_supersedes_claim_id, p_idempotency_fingerprint
    )
    RETURNING c.identity_claim_id, c.strong_identity_key INTO v_identity_claim_id, v_returned_strong_identity_key;

    IF v_returned_strong_identity_key IS DISTINCT FROM v_new_strong_identity_key THEN
      RAISE EXCEPTION
        'fn_event_assert_identity_claim : invariant violé — la strong_identity_key matérialisée (%) diffère de la clé calculée par la RPC (%) pour identity_claim_id %.',
        v_returned_strong_identity_key, v_new_strong_identity_key, v_identity_claim_id;
    END IF;

    RETURN QUERY SELECT p_cluster_id, v_identity_claim_id, v_returned_strong_identity_key, p_supersedes_claim_id, false;
    RETURN;

  EXCEPTION WHEN unique_violation THEN
    -- Filet de sécurité : collision GLOBALE d'idempotency_fingerprint
    -- (unique sur TOUTE la table). On ne récupère QUE cette violation
    -- précise : uq_identity_claims_supersedes (ou toute autre) est
    -- relevée telle quelle (re-RAISE) — la fraîcheur du prédécesseur est
    -- déjà censée être garantie par la détection explicite de l'étape 7,
    -- sous verrou, après exclusion du rejeu à l'étape 6.
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IS DISTINCT FROM 'uq_identity_claims_idempotency_fingerprint' THEN
      RAISE;
    END IF;

    SELECT c.identity_claim_id, c.cluster_id, c.authority_namespace, c.identity_type,
           c.identity_value, c.strong_identity_key, c.knowledge_cutoff,
           c.algorithm_version, c.decision_actor, c.reason, c.supersedes_claim_id
      INTO v_existing
      FROM public.event_cluster_identity_claims c
      WHERE c.idempotency_fingerprint = p_idempotency_fingerprint;

    IF NOT FOUND
       OR v_existing.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_existing.authority_namespace IS DISTINCT FROM p_authority_namespace
       OR v_existing.identity_type IS DISTINCT FROM p_identity_type
       OR v_existing.identity_value IS DISTINCT FROM p_identity_value
       OR v_existing.strong_identity_key IS DISTINCT FROM v_new_strong_identity_key
       OR v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff
       OR v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing.reason IS DISTINCT FROM p_reason
       OR v_existing.supersedes_claim_id IS DISTINCT FROM p_supersedes_claim_id
    THEN
      RAISE EXCEPTION
        'fn_event_assert_identity_claim : violation d''unicité sur idempotency_fingerprint % dont l''intention committée diffère de cet appel — collision réelle, pas un rejeu.',
        p_idempotency_fingerprint;
    END IF;

    RETURN QUERY SELECT v_existing.cluster_id, v_existing.identity_claim_id, v_existing.strong_identity_key, v_existing.supersedes_claim_id, true;
    RETURN;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_event_assert_identity_claim(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_event_assert_identity_claim(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, UUID
) TO service_role;

COMMENT ON FUNCTION public.fn_event_assert_identity_claim IS
  'RPC atomique OPS-023 : revendication d''identité forte d''événement (authority_namespace + identity_type + identity_value -> strong_identity_key, sha256 hex, GENERATED, formule 0012 inchangée) sur event_cluster_identity_claims. Verrou de cluster (fn_event_lock_cluster) PUIS verrou(s) advisory de clé d''identité (namespace xau_v2:event_identity, deux clés triées lexicalement si une supersession change de clé) AVANT toute validation de collision. Collision de clé active : 0 éligible, 1 autorisé seulement si c''est le prédécesseur explicitement supersédé sur le même cluster avec la même clé, sinon rejet (même cluster = doublon, cluster différent = collision inter-cluster, jamais fusionnée automatiquement), >1 = invariant violé. Idempotente par idempotency_fingerprint (précheck + recheck post-verrous + récupération scopée). Jamais UPDATE/DELETE. Ne lit jamais news_articles, ne dérive jamais d''identité depuis provider_item_id/canonical_url.';

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
--      AND p.proname = 'fn_event_assert_identity_claim';
--   -- attendu : search_path_setting = 'search_path=', prosecdef = false.
--
--   -- Probe de non-pollution (à exécuter en transaction, ROLLBACK
--   -- systématique — ne jamais committer une probe de test). Suppose un
--   -- cluster préexistant <cluster-id> :
--   BEGIN;
--     SELECT * FROM fn_event_assert_identity_claim(
--       p_cluster_id := '<cluster-id>',
--       p_authority_namespace := 'test_probe_authority',
--       p_identity_type := 'test_probe_type',
--       p_identity_value := 'test_probe_value_001',
--       p_knowledge_cutoff := now(),
--       p_algorithm_version := 'probe-v1',
--       p_decision_actor := 'ops023-probe',
--       p_reason := 'probe initial assertion',
--       p_idempotency_fingerprint := 'probe-fp-identity-001'
--     );
--     -- attendu : une ligne, replayed=false. Rejouer le même appel :
--     -- attendu replayed=true, aucune nouvelle ligne. Puis superséder
--     -- avec un p_supersedes_claim_id = l'identity_claim_id ci-dessus,
--     -- même clé, nouvelle p_reason, nouvel idempotency_fingerprint :
--     -- attendu replayed=false, nouvelle ligne, l'ancienne devient
--     -- non-active.
--   ROLLBACK;
-- =====================================================================
