-- =====================================================================
--  ALPHA-XAU — database/migrations/0010_official_news_sources.sql
--
--  OBJET : ajouter OFAC comme provenance officielle distincte dans
--  data_sources, pour le futur pipeline RAW (NEWS-RAW-012B). Cette
--  migration cible une base DÉJÀ MIGRÉE (0001-0002 déjà appliquées) : le
--  contrat post-0002 (échelle reliability_score 0-100, us_treasury déjà
--  présent) est supposé déjà en place, PAS recréé ici.
--
--  us_treasury N'EST PAS MODIFIÉ. Il conserve exactement son identité
--  historique 0002 (provider_name='US Department of the Treasury',
--  domain='treasury.gov', reliability_score=100.00). Cette migration ne
--  fait que VÉRIFIER que cette identité est bien celle attendue avant de
--  poursuivre — elle échoue explicitement si ce n'est pas le cas, plutôt
--  que de deviner ou de réécrire silencieusement une provenance existante.
--
--  OFAC garde son propre source_code ('ofac'), jamais mappé sur
--  us_treasury : source_code représente la provenance/autorité observée,
--  pas une preuve d'indépendance éditoriale (cette détermination reste au
--  futur EVENT CLUSTER).
--
--  INTERDIT ICI : ON CONFLICT DO UPDATE, UPDATE, DELETE, réécriture
--  silencieuse d'une provenance existante. Un code déjà présent avec une
--  définition différente de celle attendue fait échouer la migration
--  (RAISE EXCEPTION), jamais une correction automatique.
--
--  REJOUABLE : une seconde exécution sur un état déjà correct ne mute
--  rien et réussit (OFAC déjà présent avec les valeurs exactes ci-dessous
--  -> branche ELSIF passe sans erreur ni écriture).
--
--  PRÉREQUIS : migrations 0001-0002 (data_sources + échelle 0-100 +
--  us_treasury).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- A. PRÉCONDITION us_treasury — vérifie l'identité historique 0002,
--    ne la modifie jamais.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT provider_name, base_url, domain, reliability_score, is_news_source
    INTO v_row
    FROM data_sources
   WHERE code = 'us_treasury';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'STOP: data_sources.us_treasury introuvable — prérequis migration 0002 manquant.';
  END IF;

  IF v_row.provider_name IS DISTINCT FROM 'US Department of the Treasury'
     OR v_row.base_url IS DISTINCT FROM 'https://home.treasury.gov'
     OR v_row.domain IS DISTINCT FROM 'treasury.gov'
     OR v_row.reliability_score IS DISTINCT FROM 100.00
     OR v_row.is_news_source IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION
      'STOP: data_sources.us_treasury ne correspond pas au contrat historique 0002 (provider_name=%, base_url=%, domain=%, reliability_score=%, is_news_source=%).',
      v_row.provider_name, v_row.base_url, v_row.domain, v_row.reliability_score, v_row.is_news_source;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- B. OFAC — insertion si absent, acceptation UNIQUEMENT si déjà présent
--    à l'identique. Aucun ON CONFLICT DO UPDATE, aucun UPDATE.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT provider_name, base_url, domain, reliability_score, is_market_source, is_news_source
    INTO v_row
    FROM data_sources
   WHERE code = 'ofac';

  IF NOT FOUND THEN
    INSERT INTO data_sources (
      code, provider_name, base_url, domain,
      reliability_score, is_market_source, is_news_source
    ) VALUES (
      'ofac',
      'Office of Foreign Assets Control (OFAC)',
      'https://ofac.treasury.gov',
      'ofac.treasury.gov',
      100.00,
      false,
      true
    );
  ELSIF v_row.provider_name IS DISTINCT FROM 'Office of Foreign Assets Control (OFAC)'
     OR v_row.base_url IS DISTINCT FROM 'https://ofac.treasury.gov'
     OR v_row.domain IS DISTINCT FROM 'ofac.treasury.gov'
     OR v_row.reliability_score IS DISTINCT FROM 100.00
     OR v_row.is_market_source IS DISTINCT FROM false
     OR v_row.is_news_source IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION
      'STOP: data_sources.ofac existe déjà avec une définition différente (provider_name=%, base_url=%, domain=%, reliability_score=%, is_market_source=%, is_news_source=%).',
      v_row.provider_name, v_row.base_url, v_row.domain, v_row.reliability_score, v_row.is_market_source, v_row.is_news_source;
  END IF;
  -- ELSE : déjà présent à l'identique -> aucune mutation, succès.
END $$;

-- ---------------------------------------------------------------------
-- C. POST-CHECK — exactement une ligne pour chaque code.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_count_ofac      INTEGER;
  v_count_treasury  INTEGER;
BEGIN
  SELECT count(*) INTO v_count_ofac     FROM data_sources WHERE code = 'ofac';
  SELECT count(*) INTO v_count_treasury FROM data_sources WHERE code = 'us_treasury';

  IF v_count_ofac <> 1 THEN
    RAISE EXCEPTION 'APPLY CHECK FAILED: % ligne(s) code=ofac (attendu 1)', v_count_ofac;
  END IF;
  IF v_count_treasury <> 1 THEN
    RAISE EXCEPTION 'APPLY CHECK FAILED: % ligne(s) code=us_treasury (attendu 1)', v_count_treasury;
  END IF;
END $$;

COMMIT;

-- =====================================================================
-- VÉRIFICATION (lecture seule, à exécuter après application)
--   SELECT code, provider_name, base_url, domain, reliability_score,
--          is_market_source, is_news_source
--     FROM data_sources WHERE code IN ('us_treasury', 'ofac');
--   -- attendu : us_treasury inchangé (100.00, treasury.gov), ofac présent
--   -- (100.00, ofac.treasury.gov), source_code distincts pour les deux.
-- =====================================================================
