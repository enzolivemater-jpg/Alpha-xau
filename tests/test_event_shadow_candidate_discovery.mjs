// Contrat OPS-023 PR8 — découverte de candidats Event Shadow, en LECTURE
// SEULE, state-derived (aucun curseur/watermark persisté).
//
// PARTIE A : analyse STATIQUE du texte SQL de la migration 0022 (aucune
// connexion PostgreSQL requise, s'exécute en CI normale) — même
// discipline que tests/test_event_rpc_contract.mjs : ne prouve PAS le
// comportement live réel (résultats effectifs d'une requête contre des
// données), seulement que le TEXTE de la migration respecte le contrat
// gelé (signature, sécurité, tuples de source, allowlist qualité,
// mapping de catégorie, topologie RECOVERY). Une vérification live
// (rollback/probes) reste hors périmètre de ce fichier.
//
// PARTIE B : contrat COMPORTEMENTAL réel de backend/event_engine/
// shadow_candidate_discovery.ts — transpile le TypeScript source avec
// `typescript` (déjà présent en devDependency) et exécute le module
// réellement compilé contre un port DB factice déterministe.
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

// =======================================================================
// PARTIE A — Contrat statique de la migration 0022.
// =======================================================================

const MIGRATION_PATH = path.join(__dirname, '..', 'database', 'migrations', '0022_event_shadow_candidate_discovery.sql');

t('migration 0022 existe', existsSync(MIGRATION_PATH));

const migrationSource = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

// Code SQL réellement exécuté : lignes de commentaire ('--...') retirées.
const liveSource = migrationSource
  .split('\n')
  .map((line) => {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join('\n');

function extractFunctionSource(src, fnNamePattern) {
  const startRe = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fnNamePattern}\\(`);
  const startMatch = startRe.exec(src);
  if (!startMatch) return null;
  const asIdx = src.indexOf('AS $$', startMatch.index);
  if (asIdx === -1) return null;
  const endIdx = src.indexOf('\n$$;', asIdx);
  if (endIdx === -1) return null;
  return src.slice(startMatch.index, endIdx + 4);
}

// ---------------------------------------------------------------------
// A1. Transactionnalité, unicité de la fonction créée.
// ---------------------------------------------------------------------
t('migration 0022 est transactionnelle (BEGIN ... COMMIT)',
  /^\s*BEGIN;/m.test(liveSource) && /COMMIT;\s*$/m.test(liveSource.trimEnd()));

const createFunctionCount = (liveSource.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
t('exactement 1 fonction créée (fn_event_shadow_discover_candidates, aucune autre)',
  createFunctionCount === 1, `${createFunctionCount} trouvées`);

t('fn_event_shadow_discover_candidates créée en public.fn_event_shadow_discover_candidates',
  /CREATE OR REPLACE FUNCTION public\.fn_event_shadow_discover_candidates\(/.test(liveSource));

const fnSrc = extractFunctionSource(liveSource, 'fn_event_shadow_discover_candidates');
t('corps de fn_event_shadow_discover_candidates extrait pour analyse', fnSrc !== null);

// ---------------------------------------------------------------------
// A2. Signature exacte, p_lane/p_limit, sécurité.
// ---------------------------------------------------------------------
if (fnSrc !== null) {
  t('signature exacte : p_lane TEXT, p_limit INTEGER DEFAULT 25',
    /CREATE OR REPLACE FUNCTION public\.fn_event_shadow_discover_candidates\(\s*p_lane\s+TEXT,\s*p_limit\s+INTEGER DEFAULT 25\s*\)/.test(liveSource));

  t('RETURNS TABLE porte exactement les 8 colonnes attendues, dans l\'ordre',
    /RETURNS TABLE \(\s*observation_id\s+UUID,\s*lane\s+TEXT,\s*ingested_at\s+TIMESTAMPTZ,\s*cluster_id\s+UUID,\s*decision_id\s+UUID,\s*assigned_at\s+TIMESTAMPTZ,\s*expected_processor_version\s+TEXT,\s*expected_orchestrator_version\s+TEXT\s*\)/.test(liveSource));

  t('SECURITY INVOKER explicite', /SECURITY INVOKER/.test(fnSrc));
  t('SECURITY DEFINER absent', !/SECURITY DEFINER/.test(fnSrc));
  t('SET search_path = \'\' présent', /SET search_path = ''/.test(fnSrc));
  t('STABLE déclaré (jamais VOLATILE)', /\bSTABLE\b/.test(fnSrc) && !/\bVOLATILE\b/.test(fnSrc));
  t('LANGUAGE plpgsql', /LANGUAGE plpgsql/.test(fnSrc));

  // ---------------------------------------------------------------------
  // A3. Seuls FRESH/RECOVERY supportés ; limite bornée 1..25 — échec fermé.
  // ---------------------------------------------------------------------
  t('p_lane hors {FRESH, RECOVERY} lève une exception (échec fermé)',
    /p_lane IS NULL OR p_lane NOT IN \('FRESH', 'RECOVERY'\) THEN[\s\S]{0,120}RAISE EXCEPTION/.test(fnSrc));
  t('p_limit hors [1,25] lève une exception (échec fermé)',
    /p_limit IS NULL OR p_limit < 1 OR p_limit > 25 THEN[\s\S]{0,120}RAISE EXCEPTION/.test(fnSrc));
  t('les deux garde-fous sont évalués AVANT toute requête (avant le premier IF p_lane = \'FRESH\')',
    (() => {
      const laneGuardIdx = fnSrc.search(/p_lane IS NULL OR p_lane NOT IN/);
      const limitGuardIdx = fnSrc.search(/p_limit IS NULL OR p_limit < 1/);
      const firstBranchIdx = fnSrc.search(/IF p_lane = 'FRESH' THEN/);
      return laneGuardIdx > -1 && limitGuardIdx > -1 && firstBranchIdx > -1
        && laneGuardIdx < firstBranchIdx && limitGuardIdx < firstBranchIdx;
    })());

  // ---------------------------------------------------------------------
  // A4. Sécurité EXECUTE : service_role uniquement.
  // ---------------------------------------------------------------------
  t('REVOKE ALL sur fn_event_shadow_discover_candidates de PUBLIC, anon, authenticated',
    /REVOKE ALL ON FUNCTION public\.fn_event_shadow_discover_candidates\(TEXT, INTEGER\) FROM PUBLIC, anon, authenticated;/.test(liveSource));
  t('GRANT EXECUTE sur fn_event_shadow_discover_candidates à service_role uniquement',
    /GRANT EXECUTE ON FUNCTION public\.fn_event_shadow_discover_candidates\(TEXT, INTEGER\) TO service_role;/.test(liveSource));
  t('aucun GRANT à anon/authenticated/PUBLIC (uniquement des REVOKE les concernant)',
    !/GRANT[^;]*TO\s+(anon|authenticated|PUBLIC)\b/i.test(liveSource));

  // ---------------------------------------------------------------------
  // A5. Aucune mutation : pas d'INSERT/UPDATE/DELETE, pas d'appel RPC de
  //    mutation Event, pas de SQL dynamique, pas de curseur/watermark.
  // ---------------------------------------------------------------------
  t('aucun INSERT dans la fonction', !/\bINSERT\s+INTO\b/i.test(fnSrc));
  t('aucun UPDATE dans la fonction', !/\bUPDATE\b/i.test(fnSrc));
  t('aucun DELETE dans la fonction', !/\bDELETE\s+FROM\b/i.test(fnSrc));
  t('aucun SQL dynamique (EXECUTE format(...))', !/\bEXECUTE\s+(format|'|")/i.test(fnSrc));
  for (const mutationRpc of [
    'fn_event_assign_observation', 'fn_event_create_event_version',
    'fn_event_reassign_membership', 'fn_event_supersede_membership',
    'fn_event_assert_identity_claim', 'fn_event_create_cluster_relation',
    'fn_event_lock_cluster',
  ]) {
    t(`aucun appel à ${mutationRpc} (RPC de mutation Event)`, !fnSrc.includes(mutationRpc));
  }
  t('aucune table de curseur/watermark créée dans la migration (aucun CREATE TABLE)',
    !/CREATE TABLE/i.test(liveSource));

  // ---------------------------------------------------------------------
  // A6. Qualification de schéma.
  // ---------------------------------------------------------------------
  const RELATION_TABLES = ['news_articles', 'event_observation_memberships', 'event_clusters', 'event_version_evidence'];
  for (const tbl of RELATION_TABLES) {
    const unqualified = new RegExp(`(?<!public\\.)\\b${tbl}\\b`);
    t(`toute référence à ${tbl} est qualifiée public.${tbl}`, !unqualified.test(fnSrc));
  }

  // ---------------------------------------------------------------------
  // A7. Tuples de source officielle vérifiée EXACTS (parité PR4 V1).
  // ---------------------------------------------------------------------
  const SOURCE_TUPLES = [
    ['federal_reserve', 'federalreserve', 'federalreserve.gov'],
    ['ecb', 'ecb', 'ecb.europa.eu'],
    ['us_treasury', 'us_treasury', 'home.treasury.gov'],
    ['ofac', 'ofac', 'ofac.treasury.gov'],
  ];
  for (const [provider, sourceCode, domain] of SOURCE_TUPLES) {
    const re = new RegExp(
      `n\\.provider = '${provider}' AND n\\.source_code = '${sourceCode}' AND n\\.source_domain = '${domain}'`,
    );
    t(`tuple de source exact présent (${provider}/${sourceCode}/${domain}), AND joint (jamais OR)`, re.test(fnSrc));
  }
  t('les 4 tuples de source apparaissent 2 fois chacun (une fois par voie FRESH/RECOVERY)',
    SOURCE_TUPLES.every(([provider, sourceCode, domain]) =>
      (fnSrc.match(new RegExp(`n\\.provider = '${provider}' AND n\\.source_code = '${sourceCode}' AND n\\.source_domain = '${domain}'`, 'g')) || []).length === 2));

  // ---------------------------------------------------------------------
  // A8. Mapping de catégorie EXACT par autorité (parité resolveEventType()).
  //
  // btrim() DOIT être appelé à DEUX arguments avec v_js_trim_chars —
  // btrim(text) à UN argument ne trime que l'espace ASCII U+0020, jamais
  // les autres WhiteSpace/LineTerminator ECMAScript que
  // `providerCategory.trim()` retire côté PR4 (deterministic_processor.ts).
  // Voir DECLARE v_js_trim_chars en tête de fonction.
  // ---------------------------------------------------------------------
  t('FED : monetary_policy_press_release OU speech (btrim à 2 arguments, v_js_trim_chars)',
    /n\.source_code = 'federalreserve' AND btrim\(n\.provider_category, v_js_trim_chars\) IN \('monetary_policy_press_release', 'speech'\)/.test(fnSrc));
  t('ECB : press_communication OU statistical_press_release (btrim à 2 arguments, v_js_trim_chars)',
    /n\.source_code = 'ecb' AND btrim\(n\.provider_category, v_js_trim_chars\) IN \('press_communication', 'statistical_press_release'\)/.test(fnSrc));
  t('TREASURY : press_release uniquement (btrim à 2 arguments, v_js_trim_chars)',
    /n\.source_code = 'us_treasury' AND btrim\(n\.provider_category, v_js_trim_chars\) = 'press_release'/.test(fnSrc));
  t('OFAC : toute catégorie non-null et non-vide (btrim à 2 arguments, v_js_trim_chars)',
    /n\.source_code = 'ofac' AND n\.provider_category IS NOT NULL AND length\(btrim\(n\.provider_category, v_js_trim_chars\)\) > 0/.test(fnSrc));
  t('v_js_trim_chars utilisé exactement 8 fois dans les prédicats de catégorie (4 par voie : FED/ECB/TREASURY/OFAC × FRESH/RECOVERY)',
    (fnSrc.match(/btrim\(n\.provider_category, v_js_trim_chars\)/g) || []).length === 8);
  t('aucun résidu de btrim(provider_category) à UN seul argument (espace ASCII uniquement — non équivalent à PR4 trim())',
    !/btrim\(n\.provider_category\)/.test(fnSrc));
  // Déclaration de v_js_trim_chars : CONSTANT TEXT, échappement Unicode
  // U&'...', couvrant EXACTEMENT le jeu ECMAScript WhiteSpace +
  // LineTerminator listé dans la revue indépendante — jamais la locale du
  // serveur comme autorité sémantique.
  t('v_js_trim_chars déclaré CONSTANT TEXT via U&\'...\' (échappement Unicode déterministe, pas de dépendance locale)',
    /v_js_trim_chars\s+CONSTANT\s+TEXT\s*:=\s*\n?\s*U&'/.test(fnSrc));
  const JS_TRIM_CODEPOINTS = [
    '0009', '000B', '000C', 'FEFF', // WhiteSpace hors espace
    '0020', '00A0', '1680', '2000', '2001', '2002', '2003', '2004', '2005',
    '2006', '2007', '2008', '2009', '200A', '202F', '205F', '3000', // Space_Separator
    '000A', '000D', '2028', '2029', // LineTerminator
  ];
  const trimDeclMatch = /v_js_trim_chars\s+CONSTANT\s+TEXT\s*:=\s*\n?\s*U&'([^']*)'/.exec(fnSrc);
  const trimDeclValue = trimDeclMatch ? trimDeclMatch[1] : '';
  t('v_js_trim_chars extrait pour analyse', trimDeclMatch !== null);
  for (const cp of JS_TRIM_CODEPOINTS) {
    t(`v_js_trim_chars contient \\${cp}`, trimDeclValue.includes(`\\${cp}`));
  }
  t(`v_js_trim_chars contient EXACTEMENT les ${JS_TRIM_CODEPOINTS.length} points de code attendus, aucun de plus`,
    (trimDeclValue.match(/\\[0-9A-Fa-f]{4}/g) || []).length === JS_TRIM_CODEPOINTS.length);

  // ---------------------------------------------------------------------
  // A9. Porte qualité PR4 V1 EXACTE (parité passesQualityGate()).
  // ---------------------------------------------------------------------
  t('VALID exige cardinality(ingest_quality_reasons) = 0',
    /n\.ingest_quality_state = 'VALID' AND cardinality\(n\.ingest_quality_reasons\) = 0/.test(fnSrc));
  t('DEGRADED exige cardinality(ingest_quality_reasons) > 0',
    /n\.ingest_quality_state = 'DEGRADED'\s*\n\s*AND cardinality\(n\.ingest_quality_reasons\) > 0/.test(fnSrc));
  // array_ndims(...) = 1 : news_articles.ingest_quality_reasons est TEXT[]
  // NOT NULL DEFAULT '{}' sans contrainte de dimension — PostgreSQL
  // autorise un tableau multidimensionnel. unnest() flatte tout tableau
  // multidimensionnel, alors que PR4 (reasons.every(reason =>
  // DEGRADED_REASON_ALLOWLIST.has(reason))) itère le tableau JS TEL QUEL ;
  // un élément multidimensionnel arriverait côté PR4 comme un Array JS
  // imbriqué (représentation PostgREST d'un tableau Postgres 2D+), que
  // Set.has() rejette toujours. Sans cette garde, unnest() accepterait à
  // tort [['publication_timestamp_parse_failed']].
  const ARRAY_NDIMS_RE = /AND cardinality\(n\.ingest_quality_reasons\) > 0\s*\n\s*AND array_ndims\(n\.ingest_quality_reasons\) = 1\s*\n\s*AND NOT EXISTS \(/g;
  t('DEGRADED exige array_ndims(ingest_quality_reasons) = 1, juste après cardinality > 0 et avant le NOT EXISTS',
    new RegExp(ARRAY_NDIMS_RE.source).test(fnSrc));
  t('array_ndims(...) = 1 apparaît EXACTEMENT 2 fois (une fois par voie FRESH/RECOVERY)',
    (fnSrc.match(ARRAY_NDIMS_RE) || []).length === 2);
  // Prédicat fail-closed EXACT : NULL OU not-in-allowlist est invalide.
  // Un élément NULL de ingest_quality_reasons ne doit JAMAIS être traité
  // comme implicitement autorisé — `NULL NOT IN (...)` s'évalue à NULL en
  // logique ternaire PostgreSQL, jamais TRUE, donc un `WHERE reason NOT IN
  // (...)` seul laisserait passer un tableau contenant NULL (la ligne
  // NOT EXISTS ne trouverait aucune ligne "manifestement hors allowlist").
  // La correction ajoute `reason IS NULL OR` pour fermer ce trou.
  const NULL_REASON_PREDICATE_RE =
    /NOT EXISTS \(\s*\n\s*SELECT 1\s*\n\s*FROM unnest\(n\.ingest_quality_reasons\) AS quality_reason\(reason\)\s*\n\s*WHERE\s*\n\s*quality_reason\.reason IS NULL\s*\n\s*OR quality_reason\.reason NOT IN \(/g;
  t('DEGRADED rejette explicitement les raisons NULL : NULL OU not-in-allowlist est invalide (NOT EXISTS unnest(...) AS quality_reason(reason) WHERE reason IS NULL OR reason NOT IN (...))',
    new RegExp(NULL_REASON_PREDICATE_RE.source).test(fnSrc));
  t('le prédicat de rejet NULL apparaît EXACTEMENT 2 fois (une fois par voie FRESH/RECOVERY, jamais 0, jamais >2)',
    (fnSrc.match(NULL_REASON_PREDICATE_RE) || []).length === 2);
  t('aucun résidu du prédicat pré-correctif (unnest(...) AS reason sans alias de colonne explicite)',
    !/FROM unnest\(n\.ingest_quality_reasons\) AS reason\b/.test(fnSrc));
  const ALLOWED_DEGRADED_REASONS = [
    'publication_timestamp_parse_failed',
    'publication_date_parse_failed',
    'publication_precision_unknown',
  ];
  for (const reason of ALLOWED_DEGRADED_REASONS) {
    t(`raison DEGRADED autorisée présente : ${reason}`, fnSrc.includes(`'${reason}'`));
    t(`raison DEGRADED autorisée '${reason}' apparaît exactement 2 fois (une par voie)`,
      (fnSrc.match(new RegExp(`'${reason}'`, 'g')) || []).length === 2);
  }
  t('l\'allowlist DEGRADED contient EXACTEMENT ces 3 valeurs, aucune de plus (aucune autre chaîne \'publication_\' introduite)',
    (fnSrc.match(/'publication_[a-z_]+'/g) || []).length === ALLOWED_DEGRADED_REASONS.length * 2);
  t('UNVERIFIED n\'apparaît JAMAIS comme état traitable autorisé (aucune branche ingest_quality_state = \'UNVERIFIED\')',
    !/ingest_quality_state = 'UNVERIFIED'/.test(fnSrc));
  t('DEGRADED exige TOUJOURS cardinality(ingest_quality_reasons) > 0 (tableau DEGRADED vide reste exclu), exactement 2 fois',
    (fnSrc.match(/n\.ingest_quality_state = 'DEGRADED'\s*\n\s*AND cardinality\(n\.ingest_quality_reasons\) > 0/g) || []).length === 2);
  // Exactement 2 occurrences de chaque bloc qualité (une par voie FRESH/RECOVERY).
  t('le bloc de porte qualité complet apparaît exactement 2 fois (FRESH + RECOVERY)',
    (fnSrc.match(/n\.ingest_quality_state = 'VALID' AND cardinality\(n\.ingest_quality_reasons\) = 0/g) || []).length === 2);

  // ---------------------------------------------------------------------
  // A9bis. Fixture de régression documentée — DEGRADED + [NULL].
  //
  // Reproduit en JS pur (aucune dépendance base de données) la sémantique
  // EXACTE du prédicat SQL fail-closed ci-dessus, pour documenter noir sur
  // blanc le cas qui motive ce correctif : un tableau ingest_quality_reasons
  // DEGRADED contenant un élément NULL doit rendre l'observation INÉLIGIBLE,
  // jamais silencieusement traitable. Ce n'est PAS une preuve d'exécution
  // live PostgreSQL (hors périmètre, voir en-tête PARTIE A) — c'est une
  // reformulation exécutable du même prédicat, pour verrouiller l'intention.
  // ---------------------------------------------------------------------
  // Réplique fidèle de PR4 passesQualityGate() DEGRADED branch :
  // `reasons.every((reason) => DEGRADED_REASON_ALLOWLIST.has(reason))`.
  // Set.has() compare par identité/valeur stricte — un élément Array (la
  // forme JS d'un élément de tableau Postgres multidimensionnel via
  // PostgREST) n'est JAMAIS une des 3 chaînes autorisées, donc
  // `.includes(reason)` ci-dessous le rejette naturellement, sans code
  // spécial — exactement comme Set.has() côté PR4 réel.
  function degradedReasonsAreEligible(reasons) {
    if (!Array.isArray(reasons) || reasons.length === 0) return false; // cardinality > 0
    return reasons.every((reason) => reason !== null && ALLOWED_DEGRADED_REASONS.includes(reason));
  }

  const DEGRADED_FIXTURES = [
    { name: 'DEGRADED + [NULL] : élément NULL unique', reasons: [null], expectedEligible: false },
    { name: 'DEGRADED + [publication_timestamp_parse_failed, NULL] : NULL mélangé à une raison valide', reasons: ['publication_timestamp_parse_failed', null], expectedEligible: false },
    { name: 'DEGRADED + [\'unknown_reason\'] : chaîne hors allowlist', reasons: ['unknown_reason'], expectedEligible: false },
    { name: 'DEGRADED + [] : tableau vide (cardinality > 0 échoue)', reasons: [], expectedEligible: false },
    { name: 'DEGRADED + [[allowed_reason]] : tableau multidimensionnel (élément Array, jamais une chaîne — Set.has() rejette toujours)', reasons: [['publication_timestamp_parse_failed']], expectedEligible: false },
    { name: 'DEGRADED + [publication_timestamp_parse_failed] : raison unique autorisée', reasons: ['publication_timestamp_parse_failed'], expectedEligible: true },
    { name: 'DEGRADED + les 3 raisons autorisées', reasons: [...ALLOWED_DEGRADED_REASONS], expectedEligible: true },
  ];
  for (const fixture of DEGRADED_FIXTURES) {
    t(`fixture régression — ${fixture.name} => eligible=${fixture.expectedEligible}`,
      degradedReasonsAreEligible(fixture.reasons) === fixture.expectedEligible);
  }

  // ---------------------------------------------------------------------
  // A8bis. Fixture de régression documentée — sémantique EXACTE
  // ECMAScript String.prototype.trim() pour provider_category.
  //
  // Utilise le VRAI `.trim()` du moteur JS exécutant ce test (Node.js),
  // pas une réimplémentation — c'est la définition la plus fidèle possible
  // de ce que PR4 fait réellement (providerCategory.trim()), sans
  // dépendance base de données ni locale serveur PostgreSQL.
  // ---------------------------------------------------------------------
  function categoryEligible(sourceCode, providerCategory) {
    if (providerCategory === null) return false;
    const trimmed = providerCategory.trim();
    switch (sourceCode) {
      case 'federalreserve': return trimmed === 'monetary_policy_press_release' || trimmed === 'speech';
      case 'ecb': return trimmed === 'press_communication' || trimmed === 'statistical_press_release';
      case 'us_treasury': return trimmed === 'press_release';
      case 'ofac': return trimmed.length > 0;
      default: return false;
    }
  }

  const CATEGORY_FIXTURES = [
    { name: 'FED "\\tspeech\\t" (tabulations) => eligible', sourceCode: 'federalreserve', category: '\tspeech\t', expectedEligible: true },
    { name: 'TREASURY "\\npress_release\\r" (LF/CR) => eligible', sourceCode: 'us_treasury', category: '\npress_release\r', expectedEligible: true },
    { name: 'ECB categorie entouree de NBSP (U+00A0, \\u00A0) => eligible', sourceCode: 'ecb', category: '\u00A0press_communication\u00A0', expectedEligible: true },
    { name: 'FED categorie entouree de U+FEFF ZERO WIDTH NO-BREAK SPACE (\\uFEFF) => eligible', sourceCode: 'federalreserve', category: '\uFEFFmonetary_policy_press_release\uFEFF', expectedEligible: true },
    { name: 'OFAC "\\t\\n" (whitespace pur) => ineligible (trim => chaine vide)', sourceCode: 'ofac', category: '\t\n', expectedEligible: false },
    { name: 'OFAC uniquement des Space_Separator Unicode (U+2003 EM SPACE \\u2003, U+2007 FIGURE SPACE \\u2007) => ineligible', sourceCode: 'ofac', category: '\u2003\u2007', expectedEligible: false },
    { name: 'OFAC categorie dynamique ordinaire non-vide => eligible', sourceCode: 'ofac', category: 'sanctions_update', expectedEligible: true },
  ];
  for (const fixture of CATEGORY_FIXTURES) {
    t(`fixture régression trim — ${fixture.name}`,
      categoryEligible(fixture.sourceCode, fixture.category) === fixture.expectedEligible);
  }

  // ---------------------------------------------------------------------
  // A10. FRESH — ZÉRO ligne de membership au total, jamais "pas de
  //    membership courante" seulement.
  // ---------------------------------------------------------------------
  const freshBranchMatch = /IF p_lane = 'FRESH' THEN([\s\S]*?)ELSIF p_lane = 'RECOVERY' THEN/.exec(fnSrc);
  const freshBranch = freshBranchMatch ? freshBranchMatch[1] : '';
  t('branche FRESH extraite', freshBranch.length > 0);
  t('FRESH : NOT EXISTS event_observation_memberships WHERE observation_id = n.id (zéro historique)',
    /NOT EXISTS \(\s*\n\s*SELECT 1\s*\n\s*FROM public\.event_observation_memberships m\s*\n\s*WHERE m\.observation_id = n\.id\s*\n\s*\)/.test(freshBranch));
  t('FRESH : cluster_id/decision_id/assigned_at retournés NULL',
    /NULL::UUID\s+AS cluster_id/.test(freshBranch) && /NULL::UUID\s+AS decision_id/.test(freshBranch) && /NULL::TIMESTAMPTZ\s+AS assigned_at/.test(freshBranch));
  t('FRESH : ordre déterministe ingested_at ASC, id ASC',
    /ORDER BY n\.ingested_at ASC, n\.id ASC/.test(freshBranch));

  // ---------------------------------------------------------------------
  // A11. RECOVERY — topologie PR5 stricte, jamais "membership existe et
  //    Event Version manquante" seul.
  // ---------------------------------------------------------------------
  const recoveryBranchMatch = /ELSIF p_lane = 'RECOVERY' THEN([\s\S]*?)END IF;\s*\nEND;/.exec(fnSrc);
  const recoveryBranch = recoveryBranchMatch ? recoveryBranchMatch[1] : '';
  t('branche RECOVERY extraite', recoveryBranch.length > 0);

  t('RECOVERY : exactement UNE décision de membership au total (count(*) = 1)',
    /SELECT count\(\*\)\s*\n\s*FROM public\.event_observation_memberships m2\s*\n\s*WHERE m2\.observation_id = n\.id\s*\n\s*\) = 1/.test(recoveryBranch));
  t('RECOVERY : decision_type = ASSIGN', /m\.decision_type = 'ASSIGN'/.test(recoveryBranch));
  t('RECOVERY : supersedes_decision_id IS NULL (encore courante)', /m\.supersedes_decision_id IS NULL/.test(recoveryBranch));
  t('RECOVERY : aucune décision successrice (NOT EXISTS ... supersedes_decision_id = m.decision_id)',
    /NOT EXISTS \(\s*\n\s*SELECT 1\s*\n\s*FROM public\.event_observation_memberships succ\s*\n\s*WHERE succ\.supersedes_decision_id = m\.decision_id\s*\n\s*\)/.test(recoveryBranch));
  t('RECOVERY : membership_method = DETERMINISTIC_OFFICIAL_FOUNDING_V1 (chemin PR5 V1 exact)',
    /m\.membership_method = 'DETERMINISTIC_OFFICIAL_FOUNDING_V1'/.test(recoveryBranch));
  t('RECOVERY : algorithm_version (membership) = ops023-event-shadow-orchestrator-v1',
    /m\.algorithm_version = 'ops023-event-shadow-orchestrator-v1'/.test(recoveryBranch));
  t('RECOVERY : decision_actor = xau_v2:event_shadow:v1',
    /m\.decision_actor = 'xau_v2:event_shadow:v1'/.test(recoveryBranch));
  t('RECOVERY : cluster.first_observation_id = observation_id',
    /c\.first_observation_id = n\.id/.test(recoveryBranch));
  t('RECOVERY : cluster.algorithm_version = ops023-deterministic-event-processor-v1',
    /c\.algorithm_version = 'ops023-deterministic-event-processor-v1'/.test(recoveryBranch));
  t('RECOVERY : cluster.cluster_key = \'provisional:\' || observation_id',
    /c\.cluster_key = 'provisional:' \|\| n\.id::text/.test(recoveryBranch));
  t('RECOVERY : NOT EXISTS event_version_evidence WHERE decision_id = m.decision_id (autorité de complétion)',
    /NOT EXISTS \(\s*\n\s*SELECT 1\s*\n\s*FROM public\.event_version_evidence ev\s*\n\s*WHERE ev\.decision_id = m\.decision_id\s*\n\s*\)/.test(recoveryBranch));
  t('RECOVERY : ordre déterministe ingested_at ASC, id ASC', /ORDER BY n\.ingested_at ASC, n\.id ASC/.test(recoveryBranch));
  t('RECOVERY : jamais une simple heuristique "cluster existe" ou "ingestion_runs success" ou "âge de timestamp" comme critère de complétion',
    !/ingestion_runs/i.test(recoveryBranch) && !/now\(\)/i.test(recoveryBranch) && !/interval\s/i.test(recoveryBranch));

  // ---------------------------------------------------------------------
  // A12. Hors périmètre : aucune référence worker/cron/Comité/legacy.
  // ---------------------------------------------------------------------
  t('aucune référence à worker.ts/wrangler/cron dans la migration', !/wrangler|cron|worker\.ts|scheduled\(/i.test(liveSource));
  t('aucune référence au Comité/Anthropic/notification dans la migration',
    !/anthropic|committee|notifyAiEngine|ai_events/i.test(liveSource));
  t('aucune référence à news_events (pipeline legacy) dans la migration', !/news_events/i.test(liveSource));
  t('aucune policy RLS créée/modifiée', !/CREATE POLICY|ALTER TABLE[^;]*ROW LEVEL SECURITY/i.test(liveSource));
  t('aucune horloge applicative (Date.now/new Date) dans la migration', !/Date\.now\(\)|new Date\(/.test(liveSource));
  t('aucune valeur aléatoire (random())', !/\brandom\(\)/i.test(fnSrc));
}

// =======================================================================
// PARTIE B — Contrat comportemental de shadow_candidate_discovery.ts.
// =======================================================================

const DISCOVERY_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'shadow_candidate_discovery.ts');
t('backend/event_engine/shadow_candidate_discovery.ts existe', existsSync(DISCOVERY_PATH));

const discoverySource = existsSync(DISCOVERY_PATH) ? readFileSync(DISCOVERY_PATH, 'utf8') : '';

// Code TS réellement exécutable : commentaires de bloc puis de ligne
// retirés, pour ne jamais faire correspondre de la documentation qui
// décrit précisément ce que le module NE fait PAS (ex. "never fetch()",
// "never runEventShadowBatch") — même technique que la section 11
// (isolation) de tests/test_event_shadow_orchestrator.mjs.
const liveDiscoverySource = discoverySource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

// ---------------------------------------------------------------------
// B0. Isolation statique : jamais un import PR4/PR5/PR6/PR7, jamais une
//    référence exécutable aux RPC de mutation ou à runEventShadowBatch/
//    processEventShadowObservation.
// ---------------------------------------------------------------------
t('aucun import relatif (module totalement autonome, zéro couplage PR4/PR5/PR6/PR7)',
  !/^import /m.test(liveDiscoverySource));
t('aucune référence exécutable à runEventShadowBatch', !liveDiscoverySource.includes('runEventShadowBatch'));
t('aucune référence exécutable à processEventShadowObservation', !liveDiscoverySource.includes('processEventShadowObservation'));
t('aucune référence exécutable à planEventProcessing', !liveDiscoverySource.includes('planEventProcessing'));
for (const mutationRpc of [
  'fn_event_assign_observation', 'fn_event_create_event_version',
  'fn_event_reassign_membership', 'fn_event_supersede_membership',
  'fn_event_assert_identity_claim', 'fn_event_create_cluster_relation',
]) {
  t(`aucune référence exécutable à ${mutationRpc} (RPC de mutation Event) dans le module TS`, !liveDiscoverySource.includes(mutationRpc));
}
t('aucun fetch() exécutable dans le module TS', !/\bfetch\(/.test(liveDiscoverySource));
t('aucune lecture de process.env dans le module TS', !/process\.env/.test(liveDiscoverySource));
t('aucune horloge applicative exécutable (Date.now/new Date) dans le module TS', !/Date\.now\(\)|new Date\(/.test(liveDiscoverySource));
t('aucune valeur aléatoire exécutable (Math.random/crypto) dans le module TS', !/Math\.random\(\)|crypto\./.test(liveDiscoverySource));

// ---------------------------------------------------------------------
// B1. Transpilation + chargement ESM réel.
// ---------------------------------------------------------------------
function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
    },
  }).outputText;
}

let mod = null;
let tmpDir = null;
try {
  const transpiled = transpile(discoverySource);
  tmpDir = mkdtempSync(path.join(tmpdir(), 'ops023-shadow-candidate-discovery-'));
  const tmpFile = path.join(tmpDir, 'shadow_candidate_discovery.mjs');
  writeFileSync(tmpFile, transpiled, 'utf8');
  mod = await import(pathToFileURL(tmpFile).href);
} catch (err) {
  console.error('FAILED TO TRANSPILE/LOAD shadow_candidate_discovery.ts:', err);
} finally {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
}

t('le module transpile et se charge sans erreur', mod !== null);
t('OPS023_EVENT_SHADOW_DISCOVERY_VERSION exporté', typeof mod?.OPS023_EVENT_SHADOW_DISCOVERY_VERSION === 'string' && mod.OPS023_EVENT_SHADOW_DISCOVERY_VERSION === 'ops023-event-shadow-candidate-discovery-v1');
t('discoverEventShadowCandidates exportée (fonction)', typeof mod?.discoverEventShadowCandidates === 'function');
t('EventShadowDiscoveryInvariantError exportée (classe)', typeof mod?.EventShadowDiscoveryInvariantError === 'function');

if (mod === null) {
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
}

const { discoverEventShadowCandidates, EventShadowDiscoveryInvariantError } = mod;

const EXPECTED_PROCESSOR_VERSION = 'ops023-deterministic-event-processor-v1';
const EXPECTED_ORCHESTRATOR_VERSION = 'ops023-event-shadow-orchestrator-v1';

// ---------------------------------------------------------------------
// Fixtures + fake DB port.
// ---------------------------------------------------------------------
let seq = 0;
function nextUuid() {
  seq += 1;
  const hex = seq.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function makeFreshRow(overrides = {}) {
  return {
    observation_id: nextUuid(),
    lane: 'FRESH',
    ingested_at: '2026-09-01T10:00:00.000Z',
    cluster_id: null,
    decision_id: null,
    assigned_at: null,
    expected_processor_version: EXPECTED_PROCESSOR_VERSION,
    expected_orchestrator_version: EXPECTED_ORCHESTRATOR_VERSION,
    ...overrides,
  };
}

function makeRecoveryRow(overrides = {}) {
  return {
    observation_id: nextUuid(),
    lane: 'RECOVERY',
    ingested_at: '2026-09-01T10:00:00.000Z',
    cluster_id: nextUuid(),
    decision_id: nextUuid(),
    assigned_at: '2026-09-01T10:05:00.000Z',
    expected_processor_version: EXPECTED_PROCESSOR_VERSION,
    expected_orchestrator_version: EXPECTED_ORCHESTRATOR_VERSION,
    ...overrides,
  };
}

/** Fake DB : route par p_lane, enregistre chaque appel, lève une erreur
 *  explicite pour tout path non attendu (preuve d'isolation). */
function makeFakeDb({ recoveryRows = [], freshRows = [] }) {
  const calls = [];
  const db = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (path !== 'rpc/fn_event_shadow_discover_candidates') {
        throw new Error(`unexpected DB call reached the fake (isolation violation): ${method} ${path}`);
      }
      if (body.p_lane === 'RECOVERY') return recoveryRows;
      if (body.p_lane === 'FRESH') return freshRows;
      throw new Error(`unexpected p_lane: ${JSON.stringify(body.p_lane)}`);
    },
  };
  return { db, calls };
}

async function expectThrow(fn, label) {
  try {
    await fn();
    t(label, false, 'expected a throw/rejection, none occurred');
    return null;
  } catch (err) {
    t(label, true);
    return err;
  }
}

// ---------------------------------------------------------------------
// B2. Seules deux voies : calls RPC, ordre, isolation.
// ---------------------------------------------------------------------
{
  const { db, calls } = makeFakeDb({});
  await discoverEventShadowCandidates(db, 10);
  t('exactement 2 appels RPC (RECOVERY puis FRESH)', calls.length === 2);
  t('les deux appels ciblent rpc/fn_event_shadow_discover_candidates',
    calls.every((c) => c.path === 'rpc/fn_event_shadow_discover_candidates'));
  t('le premier appel est RECOVERY (recovery-first)', calls[0].body.p_lane === 'RECOVERY');
  t('le second appel est FRESH', calls[1].body.p_lane === 'FRESH');
  t('chaque appel porte p_limit = maxCandidates', calls[0].body.p_limit === 10 && calls[1].body.p_limit === 10);
}

// ---------------------------------------------------------------------
// B3. Seulement fresh / seulement recovery.
// ---------------------------------------------------------------------
{
  const fresh = [makeFreshRow(), makeFreshRow(), makeFreshRow()];
  const { db } = makeFakeDb({ freshRows: fresh });
  const result = await discoverEventShadowCandidates(db, 25);
  t('seulement FRESH : toutes les lignes sélectionnées', result.selected.length === 3 && result.freshSelected === 3 && result.recoverySelected === 0);
  t('seulement FRESH : ordre préservé (oldest-first tel que retourné par la RPC)',
    result.selected.map((c) => c.observationId).join(',') === fresh.map((r) => r.observation_id).join(','));
}
{
  const recovery = [makeRecoveryRow(), makeRecoveryRow()];
  const { db } = makeFakeDb({ recoveryRows: recovery });
  const result = await discoverEventShadowCandidates(db, 25);
  t('seulement RECOVERY : toutes les lignes sélectionnées', result.selected.length === 2 && result.recoverySelected === 2 && result.freshSelected === 0);
  t('seulement RECOVERY : les champs cluster/decision/assigned_at sont exposés',
    result.selected.every((c) => c.clusterId !== null && c.decisionId !== null && c.assignedAt !== null));
}

// ---------------------------------------------------------------------
// B4. Alternance équitable — mélange, maxCandidates impair, une voie
//    s'épuise en premier, plafond 25.
// ---------------------------------------------------------------------
{
  const recovery = [makeRecoveryRow(), makeRecoveryRow()];
  const fresh = [makeFreshRow(), makeFreshRow(), makeFreshRow()];
  const { db } = makeFakeDb({ recoveryRows: recovery, freshRows: fresh });
  const result = await discoverEventShadowCandidates(db, 25);
  const expectedOrder = [recovery[0], fresh[0], recovery[1], fresh[1], fresh[2]].map((r) => r.observation_id);
  t('alternance : RECOVERY[0], FRESH[0], RECOVERY[1], FRESH[1], puis reste de FRESH',
    result.selectedObservationIds.join(',') === expectedOrder.join(','));
  t('alternance : recoverySelected=2, freshSelected=3', result.recoverySelected === 2 && result.freshSelected === 3);
}
{
  // maxCandidates impair : coupe au milieu d'un round.
  const recovery = [makeRecoveryRow(), makeRecoveryRow(), makeRecoveryRow()];
  const fresh = [makeFreshRow(), makeFreshRow(), makeFreshRow()];
  const { db } = makeFakeDb({ recoveryRows: recovery, freshRows: fresh });
  const result = await discoverEventShadowCandidates(db, 3);
  const expectedOrder = [recovery[0], fresh[0], recovery[1]].map((r) => r.observation_id);
  t('maxCandidates impair (3) : coupe exactement à la limite, jamais plus',
    result.selected.length === 3 && result.selectedObservationIds.join(',') === expectedOrder.join(','));
}
{
  // Une voie s'épuise tôt : le reste des créneaux vient de l'autre voie.
  const recovery = [makeRecoveryRow()];
  const fresh = [makeFreshRow(), makeFreshRow(), makeFreshRow(), makeFreshRow()];
  const { db } = makeFakeDb({ recoveryRows: recovery, freshRows: fresh });
  const result = await discoverEventShadowCandidates(db, 25);
  const expectedOrder = [recovery[0], fresh[0], fresh[1], fresh[2], fresh[3]].map((r) => r.observation_id);
  t('une voie épuisée tôt (RECOVERY=1) : les créneaux restants viennent de FRESH, jamais un starving',
    result.selectedObservationIds.join(',') === expectedOrder.join(','));
}
{
  // Plafond 25.
  const recovery = Array.from({ length: 25 }, () => makeRecoveryRow());
  const { db } = makeFakeDb({ recoveryRows: recovery });
  const result = await discoverEventShadowCandidates(db, 25);
  t('maximum 25 : sélection plafonnée à 25', result.selected.length === 25 && result.maxCandidates === 25);
}

// ---------------------------------------------------------------------
// B5. maxCandidates invalide : échec fermé.
// ---------------------------------------------------------------------
{
  const { db } = makeFakeDb({});
  const err0 = await expectThrow(() => discoverEventShadowCandidates(db, 0), 'maxCandidates=0 rejeté');
  t('erreur maxCandidates=0 est INVALID_MAX_CANDIDATES', err0 instanceof EventShadowDiscoveryInvariantError && err0.code === 'INVALID_MAX_CANDIDATES');
  const err26 = await expectThrow(() => discoverEventShadowCandidates(db, 26), 'maxCandidates=26 rejeté');
  t('erreur maxCandidates=26 est INVALID_MAX_CANDIDATES', err26 instanceof EventShadowDiscoveryInvariantError && err26.code === 'INVALID_MAX_CANDIDATES');
  const errFloat = await expectThrow(() => discoverEventShadowCandidates(db, 5.5), 'maxCandidates non-entier rejeté');
  t('erreur maxCandidates=5.5 est INVALID_MAX_CANDIDATES', errFloat instanceof EventShadowDiscoveryInvariantError && errFloat.code === 'INVALID_MAX_CANDIDATES');
}

// ---------------------------------------------------------------------
// B6. Lignes RPC malformées — échec fermé, jamais un silencieux drop.
// ---------------------------------------------------------------------
{
  const { db } = makeFakeDb({ freshRows: [makeFreshRow({ observation_id: 'not-a-uuid' })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'observation_id malformé rejeté');
  t('erreur observation_id malformé est MALFORMED_OBSERVATION_ID', err instanceof EventShadowDiscoveryInvariantError && err.code === 'MALFORMED_OBSERVATION_ID');
}
{
  const { db } = makeFakeDb({ freshRows: [makeFreshRow({ lane: 'RECOVERY' })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'lane incohérente (RECOVERY renvoyée sous un appel FRESH) rejetée');
  t('erreur lane incohérente est WRONG_LANE', err instanceof EventShadowDiscoveryInvariantError && err.code === 'WRONG_LANE');
}
{
  const { db } = makeFakeDb({ freshRows: [makeFreshRow({ ingested_at: 'not-a-timestamp' })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'ingested_at malformé rejeté');
  t('erreur ingested_at malformé est MALFORMED_INGESTED_AT', err instanceof EventShadowDiscoveryInvariantError && err.code === 'MALFORMED_INGESTED_AT');
}
{
  const { db } = makeFakeDb({ freshRows: [{ ...makeFreshRow(), extra_unexpected_field: 'x' }] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'champ inattendu dans la ligne rejeté');
  t('erreur champ inattendu est UNEXPECTED_ROW_SHAPE', err instanceof EventShadowDiscoveryInvariantError && err.code === 'UNEXPECTED_ROW_SHAPE');
}
{
  const row = makeFreshRow();
  delete row.assigned_at;
  const { db } = makeFakeDb({ freshRows: [row] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'clé manquante dans la ligne rejetée');
  t('erreur clé manquante est UNEXPECTED_ROW_SHAPE', err instanceof EventShadowDiscoveryInvariantError && err.code === 'UNEXPECTED_ROW_SHAPE');
}
{
  const { db } = makeFakeDb({ freshRows: ['not-an-object'] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'ligne non-objet rejetée');
  t('erreur ligne non-objet est MALFORMED_RPC_ROW', err instanceof EventShadowDiscoveryInvariantError && err.code === 'MALFORMED_RPC_ROW');
}
{
  const { db } = makeFakeDb({ freshRows: 'not-an-array' });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'réponse RPC non-tableau rejetée');
  t('erreur réponse non-tableau est MALFORMED_RPC_RESPONSE', err instanceof EventShadowDiscoveryInvariantError && err.code === 'MALFORMED_RPC_RESPONSE');
}
{
  const oversized = Array.from({ length: 5 }, () => makeFreshRow());
  const { db } = makeFakeDb({ freshRows: oversized });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 3), 'plus de lignes que demandé rejeté');
  t('erreur plus de lignes que p_limit est TOO_MANY_ROWS_RETURNED', err instanceof EventShadowDiscoveryInvariantError && err.code === 'TOO_MANY_ROWS_RETURNED');
}

// ---------------------------------------------------------------------
// B7. Doublons — même voie, puis à travers les deux voies.
// ---------------------------------------------------------------------
{
  const dupId = nextUuid();
  const { db } = makeFakeDb({ freshRows: [makeFreshRow({ observation_id: dupId }), makeFreshRow({ observation_id: dupId })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'observationId dupliqué DANS une même voie rejeté');
  t('erreur doublon intra-voie est DUPLICATE_OBSERVATION_ID', err instanceof EventShadowDiscoveryInvariantError && err.code === 'DUPLICATE_OBSERVATION_ID');
}
{
  const sharedId = nextUuid();
  const { db } = makeFakeDb({
    recoveryRows: [makeRecoveryRow({ observation_id: sharedId })],
    freshRows: [makeFreshRow({ observation_id: sharedId })],
  });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'même observationId dans les DEUX voies rejeté');
  t('erreur même observationId dans les deux voies est OBSERVATION_ID_IN_BOTH_LANES', err instanceof EventShadowDiscoveryInvariantError && err.code === 'OBSERVATION_ID_IN_BOTH_LANES');
}

// ---------------------------------------------------------------------
// B8. Versions processeur/orchestrateur — échec fermé sur toute dérive.
// ---------------------------------------------------------------------
{
  const { db } = makeFakeDb({ freshRows: [makeFreshRow({ expected_processor_version: 'wrong-version' })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'expected_processor_version divergent rejeté');
  t('erreur version processeur divergente est PROCESSOR_VERSION_MISMATCH', err instanceof EventShadowDiscoveryInvariantError && err.code === 'PROCESSOR_VERSION_MISMATCH');
}
{
  const { db } = makeFakeDb({ freshRows: [makeFreshRow({ expected_orchestrator_version: 'wrong-version' })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'expected_orchestrator_version divergent rejeté');
  t('erreur version orchestrateur divergente est ORCHESTRATOR_VERSION_MISMATCH', err instanceof EventShadowDiscoveryInvariantError && err.code === 'ORCHESTRATOR_VERSION_MISMATCH');
}

// ---------------------------------------------------------------------
// B9. Cohérence d'identité par voie — FRESH ne porte jamais d'identité,
//    RECOVERY porte toujours son identité complète.
// ---------------------------------------------------------------------
{
  const { db } = makeFakeDb({ freshRows: [makeFreshRow({ decision_id: nextUuid() })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'FRESH portant une decision_id non-null rejeté');
  t('erreur FRESH avec identité inattendue est FRESH_ROW_UNEXPECTED_IDENTITY', err instanceof EventShadowDiscoveryInvariantError && err.code === 'FRESH_ROW_UNEXPECTED_IDENTITY');
}
{
  const { db } = makeFakeDb({ freshRows: [makeFreshRow({ cluster_id: nextUuid() })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'FRESH portant un cluster_id non-null rejeté');
  t('erreur FRESH avec cluster_id inattendu est FRESH_ROW_UNEXPECTED_IDENTITY', err instanceof EventShadowDiscoveryInvariantError && err.code === 'FRESH_ROW_UNEXPECTED_IDENTITY');
}
{
  const { db } = makeFakeDb({ freshRows: [makeFreshRow({ assigned_at: '2026-09-01T10:00:00.000Z' })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'FRESH portant un assigned_at non-null rejeté');
  t('erreur FRESH avec assigned_at inattendu est FRESH_ROW_UNEXPECTED_IDENTITY', err instanceof EventShadowDiscoveryInvariantError && err.code === 'FRESH_ROW_UNEXPECTED_IDENTITY');
}
{
  const { db } = makeFakeDb({ recoveryRows: [makeRecoveryRow({ decision_id: null })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'RECOVERY sans decision_id rejeté');
  t('erreur RECOVERY sans decision_id est RECOVERY_ROW_MISSING_IDENTITY', err instanceof EventShadowDiscoveryInvariantError && err.code === 'RECOVERY_ROW_MISSING_IDENTITY');
}
{
  const { db } = makeFakeDb({ recoveryRows: [makeRecoveryRow({ cluster_id: null })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'RECOVERY sans cluster_id rejeté');
  t('erreur RECOVERY sans cluster_id est RECOVERY_ROW_MISSING_IDENTITY', err instanceof EventShadowDiscoveryInvariantError && err.code === 'RECOVERY_ROW_MISSING_IDENTITY');
}
{
  const { db } = makeFakeDb({ recoveryRows: [makeRecoveryRow({ assigned_at: null })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'RECOVERY sans assigned_at rejeté');
  t('erreur RECOVERY sans assigned_at est RECOVERY_ROW_MISSING_IDENTITY', err instanceof EventShadowDiscoveryInvariantError && err.code === 'RECOVERY_ROW_MISSING_IDENTITY');
}
{
  const { db } = makeFakeDb({ recoveryRows: [makeRecoveryRow({ cluster_id: 'not-a-uuid' })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'RECOVERY avec cluster_id malformé rejeté');
  t('erreur RECOVERY cluster_id malformé est MALFORMED_CLUSTER_ID', err instanceof EventShadowDiscoveryInvariantError && err.code === 'MALFORMED_CLUSTER_ID');
}
{
  const { db } = makeFakeDb({ recoveryRows: [makeRecoveryRow({ decision_id: 'not-a-uuid' })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'RECOVERY avec decision_id malformé rejeté');
  t('erreur RECOVERY decision_id malformé est MALFORMED_DECISION_ID', err instanceof EventShadowDiscoveryInvariantError && err.code === 'MALFORMED_DECISION_ID');
}
{
  const { db } = makeFakeDb({ recoveryRows: [makeRecoveryRow({ assigned_at: 'not-a-timestamp' })] });
  const err = await expectThrow(() => discoverEventShadowCandidates(db, 25), 'RECOVERY avec assigned_at malformé rejeté');
  t('erreur RECOVERY assigned_at malformé est MALFORMED_ASSIGNED_AT', err instanceof EventShadowDiscoveryInvariantError && err.code === 'MALFORMED_ASSIGNED_AT');
}

// ---------------------------------------------------------------------
// B10. Déterminisme — même entrée, même sortie exacte.
// ---------------------------------------------------------------------
{
  const recovery = [makeRecoveryRow(), makeRecoveryRow()];
  const fresh = [makeFreshRow(), makeFreshRow()];
  const { db: db1 } = makeFakeDb({ recoveryRows: recovery, freshRows: fresh });
  const { db: db2 } = makeFakeDb({ recoveryRows: recovery, freshRows: fresh });
  const result1 = await discoverEventShadowCandidates(db1, 25);
  const result2 = await discoverEventShadowCandidates(db2, 25);
  t('déterminisme : deux exécutions avec les mêmes lignes RPC produisent un résultat rigoureusement identique',
    JSON.stringify(result1) === JSON.stringify(result2));
}

// ---------------------------------------------------------------------
// B11. Résultat structuré — contrat minimal.
// ---------------------------------------------------------------------
{
  const recovery = [makeRecoveryRow()];
  const fresh = [makeFreshRow()];
  const { db } = makeFakeDb({ recoveryRows: recovery, freshRows: fresh });
  const result = await discoverEventShadowCandidates(db, 25);
  t('version exposée = OPS023_EVENT_SHADOW_DISCOVERY_VERSION', result.version === mod.OPS023_EVENT_SHADOW_DISCOVERY_VERSION);
  t('maxCandidates exposé', result.maxCandidates === 25);
  t('recoveryFetched/freshFetched exposés', result.recoveryFetched === 1 && result.freshFetched === 1);
  t('chaque item sélectionné expose observationId/lane/ingestedAt/clusterId/decisionId/assignedAt',
    result.selected.every((c) => 'observationId' in c && 'lane' in c && 'ingestedAt' in c && 'clusterId' in c && 'decisionId' in c && 'assignedAt' in c));
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f > 0 ? 1 : 0);
