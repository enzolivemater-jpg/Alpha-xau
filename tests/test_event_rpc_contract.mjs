// Contrat statique des RPC atomiques OPS-023 Phase 2 (migration 0014).
// Analyse le texte SQL de la migration : aucune connexion PostgreSQL
// requise, s'exécute en CI normale. Ne prouve PAS le comportement
// transactionnel réel (verrouillage effectif, atomicité, récupération
// de course) — une vérification live contre Supabase (rollback/probes
// de non-pollution) est effectuée indépendamment, après fusion. Ce
// fichier prouve uniquement que le TEXTE de la migration respecte le
// contrat gelé (paramètres, search_path, qualification, invariants
// déjà portés par 0012 non dupliqués, périmètre strictement limité).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(__dirname, '..', 'database', 'migrations', '0014_event_membership_atomic_rpcs.sql');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('migration 0014 existe', existsSync(MIGRATION_PATH));

const source = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

// Code SQL réellement exécuté : lignes de commentaire ('--...') retirées,
// pour ne jamais faire correspondre du SQL cité en exemple dans le bloc
// de vérification en fin de fichier (commenté).
const liveSource = source
  .split('\n')
  .map((line) => {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join('\n');

// ---------------------------------------------------------------------
// 1. Transactionnalité et périmètre des fonctions créées
// ---------------------------------------------------------------------
t('migration 0014 est transactionnelle (BEGIN ... COMMIT)',
  /^\s*BEGIN;/m.test(liveSource) && /COMMIT;\s*$/m.test(liveSource.trimEnd()));

const createFunctionCount = (liveSource.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
t('exactement 2 fonctions créées (fn_event_lock_cluster + fn_event_assign_observation, aucune autre)',
  createFunctionCount === 2, `${createFunctionCount} trouvées`);

t('fn_event_lock_cluster créée en public.fn_event_lock_cluster',
  /CREATE OR REPLACE FUNCTION public\.fn_event_lock_cluster\(p_cluster_id UUID\)/.test(liveSource));
t('fn_event_assign_observation créée en public.fn_event_assign_observation',
  /CREATE OR REPLACE FUNCTION public\.fn_event_assign_observation\(/.test(liveSource));

// ---------------------------------------------------------------------
// 2. fn_event_lock_cluster : verrou advisory partagé, namespace stable
// ---------------------------------------------------------------------
function extractFunctionSource(src, fnNamePattern) {
  const startRe = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fnNamePattern}\\(`);
  const startMatch = startRe.exec(src);
  if (!startMatch) return null;
  // Le corps se termine au premier "\n$$;\n" après le AS $$ ouvrant.
  const asIdx = src.indexOf('AS $$', startMatch.index);
  if (asIdx === -1) return null;
  const endIdx = src.indexOf('\n$$;', asIdx);
  if (endIdx === -1) return null;
  return src.slice(startMatch.index, endIdx + 4);
}

const lockFnSrc = extractFunctionSource(liveSource, 'fn_event_lock_cluster');
t('corps de fn_event_lock_cluster extrait pour analyse', lockFnSrc !== null);

if (lockFnSrc !== null) {
  t('fn_event_lock_cluster : SECURITY INVOKER explicite', /SECURITY INVOKER/.test(lockFnSrc));
  t('fn_event_lock_cluster : SECURITY DEFINER absent', !/SECURITY DEFINER/.test(lockFnSrc));
  t('fn_event_lock_cluster : SET search_path = \'\' présent', /SET search_path = ''/.test(lockFnSrc));
  t('fn_event_lock_cluster : rejette un p_cluster_id NULL',
    /p_cluster_id IS NULL THEN[\s\S]{0,80}RAISE EXCEPTION/.test(lockFnSrc));
  t('fn_event_lock_cluster : verrouillage advisory de TRANSACTION (pg_advisory_xact_lock, pas pg_advisory_lock simple)',
    /pg_catalog\.pg_advisory_xact_lock\(/.test(lockFnSrc));
  t('fn_event_lock_cluster : dérivation par pg_catalog.hashtextextended, qualifiée pg_catalog',
    /pg_catalog\.hashtextextended\(/.test(lockFnSrc));
  t('fn_event_lock_cluster : namespace stable "xau_v2:event_cluster:" présent',
    /xau_v2:event_cluster:/.test(lockFnSrc));
  t('fn_event_lock_cluster : un seul cluster_id par appel (pas de verrou sur un ensemble/hash de plusieurs IDs)',
    (lockFnSrc.match(/pg_advisory_xact_lock\(/g) || []).length === 1
    && !/hashtextextended\([^)]*ARRAY/i.test(lockFnSrc)
    && !/string_agg/i.test(lockFnSrc));
}

// ---------------------------------------------------------------------
// 3. fn_event_assign_observation : signature, modes, sécurité
// ---------------------------------------------------------------------
const assignFnSrc = extractFunctionSource(liveSource, 'fn_event_assign_observation');
t('corps de fn_event_assign_observation extrait pour analyse', assignFnSrc !== null);

if (assignFnSrc !== null) {
  t('fn_event_assign_observation : SECURITY INVOKER explicite', /SECURITY INVOKER/.test(assignFnSrc));
  t('fn_event_assign_observation : SECURITY DEFINER absent', !/SECURITY DEFINER/.test(assignFnSrc));
  t('fn_event_assign_observation : SET search_path = \'\' présent', /SET search_path = ''/.test(assignFnSrc));

  t('fn_event_assign_observation : RETURNS TABLE(cluster_id, decision_id, cluster_created_now, replayed)',
    /RETURNS TABLE \(\s*cluster_id\s+UUID,\s*decision_id\s+UUID,\s*cluster_created_now\s+BOOLEAN,\s*replayed\s+BOOLEAN/.test(liveSource));

  const REQUIRED_PARAMS = [
    'p_observation_id', 'p_membership_method', 'p_evidence_digest',
    'p_membership_algorithm_version', 'p_decision_actor',
    'p_idempotency_fingerprint', 'p_semantic_state_fingerprint',
  ];
  const OPTIONAL_PARAMS = [
    'p_cluster_id', 'p_cluster_key', 'p_category', 'p_region',
    'p_cluster_algorithm_version', 'p_membership_confidence',
    'p_editorial_origin_key', 'p_wire_lineage_key', 'p_lineage_resolution_method',
    'p_lineage_resolution_confidence', 'p_lineage_evidence',
  ];
  const signatureMatch = /CREATE OR REPLACE FUNCTION public\.fn_event_assign_observation\(([\s\S]*?)\)\s*\nRETURNS TABLE/.exec(liveSource);
  const signature = signatureMatch ? signatureMatch[1] : '';
  t('signature de fn_event_assign_observation extraite', signature.length > 0);

  for (const param of REQUIRED_PARAMS) {
    const re = new RegExp(`${param}\\s+(UUID|TEXT)(?!\\s+DEFAULT)`);
    t(`paramètre obligatoire ${param} présent, sans DEFAULT`, re.test(signature));
  }
  for (const param of OPTIONAL_PARAMS) {
    const re = new RegExp(`${param}\\s+(UUID|TEXT|NUMERIC)\\s+DEFAULT NULL`);
    t(`paramètre optionnel ${param} présent avec DEFAULT NULL`, re.test(signature));
  }
  // Ordre PostgreSQL valide : aucun paramètre obligatoire (sans DEFAULT)
  // ne doit apparaître APRÈS le premier paramètre optionnel.
  const firstOptionalIdx = signature.search(/p_cluster_id\s+UUID\s+DEFAULT NULL/);
  t('aucun paramètre obligatoire déclaré après le premier paramètre optionnel (ordre PostgreSQL valide)',
    firstOptionalIdx > -1 && REQUIRED_PARAMS.every((param) => signature.indexOf(param) < firstOptionalIdx));

  t('mode CREATE_AND_ASSIGN présent (IF p_cluster_id IS NULL THEN)',
    /IF p_cluster_id IS NULL THEN/.test(assignFnSrc));
  t('mode ASSIGN_EXISTING présent (chemin exécuté quand p_cluster_id IS NOT NULL, sans branche IF explicite redondante)',
    /ASSIGN_EXISTING/.test(assignFnSrc) && /PERFORM public\.fn_event_lock_cluster\(p_cluster_id\)/.test(assignFnSrc));

  t('CREATE_AND_ASSIGN exige p_cluster_key non vide',
    /p_cluster_key IS NULL OR length\(btrim\(p_cluster_key\)\) = 0 THEN[\s\S]{0,80}RAISE EXCEPTION/.test(assignFnSrc));
  t('CREATE_AND_ASSIGN exige p_cluster_algorithm_version non vide',
    /p_cluster_algorithm_version IS NULL OR length\(btrim\(p_cluster_algorithm_version\)\) = 0 THEN[\s\S]{0,100}RAISE EXCEPTION/.test(assignFnSrc));

  t('event_clusters et event_observation_memberships sont créés dans la MÊME fonction (pas de RPC séparée pour le cluster)',
    /INSERT INTO public\.event_clusters/.test(assignFnSrc)
    && /INSERT INTO public\.event_observation_memberships/.test(assignFnSrc));

  t('le cluster généré est verrouillé (fn_event_lock_cluster) avant toute écriture, dans la transaction',
    /v_new_cluster_id := pg_catalog\.gen_random_uuid\(\);\s*\n\s*PERFORM public\.fn_event_lock_cluster\(v_new_cluster_id\);/.test(assignFnSrc));

  // ---------------------------------------------------------------------
  // 4. Idempotence : pré-vérification + récupération sur violation
  // ---------------------------------------------------------------------
  t('pré-vérification par idempotency_fingerprint avant toute écriture',
    /WHERE m\.idempotency_fingerprint = p_idempotency_fingerprint;[\s\S]{0,40}IF FOUND THEN/.test(assignFnSrc));
  t('intention canonique complète revalidée avant tout retour de rejeu (pas un retour aveugle sur simple correspondance d\'empreinte)',
    (assignFnSrc.match(/IS DISTINCT FROM p_observation_id/g) || []).length >= 2
    && (assignFnSrc.match(/IS DISTINCT FROM p_evidence_digest/g) || []).length >= 2);
  t('validation de l\'intention fondatrice du cluster pour un rejeu CREATE_AND_ASSIGN (first_observation_id/cluster_key/category/region/algorithm_version)',
    /v_existing_cluster\.first_observation_id IS DISTINCT FROM p_observation_id/.test(assignFnSrc)
    && /v_existing_cluster\.cluster_key IS DISTINCT FROM p_cluster_key/.test(assignFnSrc)
    && /v_existing_cluster\.category IS DISTINCT FROM p_category/.test(assignFnSrc)
    && /v_existing_cluster\.region IS DISTINCT FROM p_region/.test(assignFnSrc)
    && /v_existing_cluster\.algorithm_version IS DISTINCT FROM p_cluster_algorithm_version/.test(assignFnSrc));
  t('collision d\'intention (empreinte identique, contenu différent) lève une exception explicite, jamais un retour silencieux',
    /collision, pas un rejeu/.test(assignFnSrc) || /collision réelle, pas un rejeu/.test(assignFnSrc));

  const uniqueViolationBlocks = (assignFnSrc.match(/EXCEPTION WHEN unique_violation THEN/g) || []).length;
  t('récupération sur violation d\'unicité présente dans les DEUX modes (CREATE_AND_ASSIGN et ASSIGN_EXISTING)',
    uniqueViolationBlocks === 2);
  t('la récupération ne catch QUE la violation du constraint d\'idempotence (GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME), toute autre violation est relevée (RAISE) sans conversion',
    (assignFnSrc.match(/GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;/g) || []).length === 2
    && (assignFnSrc.match(/IS DISTINCT FROM 'uq_memberships_idempotency_fingerprint' THEN\s*\n\s*RAISE;/g) || []).length === 2);
  t('replayed=true uniquement retourné après revalidation de l\'intention dans le chemin de récupération',
    /RETURN QUERY SELECT v_existing\.cluster_id, v_existing\.decision_id, false, true;/g.test(assignFnSrc));

  // ---------------------------------------------------------------------
  // 4bis. ASSIGN_EXISTING rejette explicitement les paramètres de
  //    fondation de cluster (jamais ignorés silencieusement).
  // ---------------------------------------------------------------------
  const CREATION_ONLY_PARAMS = ['p_cluster_key', 'p_category', 'p_region', 'p_cluster_algorithm_version'];
  t('ASSIGN_EXISTING rejette explicitement p_cluster_key/p_category/p_region/p_cluster_algorithm_version si renseignés (RAISE EXCEPTION, jamais ignoré)',
    CREATION_ONLY_PARAMS.every((param) => new RegExp(`${param} IS NOT NULL`).test(assignFnSrc))
    && /p_cluster_key IS NOT NULL\s*\n\s*OR p_category IS NOT NULL\s*\n\s*OR p_region IS NOT NULL\s*\n\s*OR p_cluster_algorithm_version IS NOT NULL\s*\n\s*THEN\s*\n\s*RAISE EXCEPTION/.test(assignFnSrc));
  t('ce garde-fou est placé AVANT la pré-vérification d\'idempotence (avant WHERE m.idempotency_fingerprint = p_idempotency_fingerprint) — s\'applique donc au premier appel, au rejeu séquentiel ET au retry après réponse perdue, sans jamais pouvoir retourner replayed=true en le contournant',
    (() => {
      const guardIdx = assignFnSrc.search(/p_cluster_key IS NOT NULL\s*\n\s*OR p_category IS NOT NULL/);
      const idempotencyCheckIdx = assignFnSrc.indexOf('WHERE m.idempotency_fingerprint = p_idempotency_fingerprint');
      return guardIdx > -1 && idempotencyCheckIdx > -1 && guardIdx < idempotencyCheckIdx;
    })());
  t('ce garde-fou est aussi placé avant le verrouillage/l\'écriture ASSIGN_EXISTING (avant fn_event_lock_cluster(p_cluster_id))',
    (() => {
      const guardIdx = assignFnSrc.search(/p_cluster_key IS NOT NULL\s*\n\s*OR p_category IS NOT NULL/);
      const lockIdx = assignFnSrc.indexOf('PERFORM public.fn_event_lock_cluster(p_cluster_id);');
      return guardIdx > -1 && lockIdx > -1 && guardIdx < lockIdx;
    })());
  t('le garde-fou n\'est PAS dupliqué : une seule occurrence dans la fonction (point de validation unique)',
    (assignFnSrc.match(/p_cluster_key IS NOT NULL\s*\n\s*OR p_category IS NOT NULL/g) || []).length === 1);

  // ---------------------------------------------------------------------
  // 4ter. Une ligne issue d'une future REASSIGN (membership_operation_id
  //    renseigné, ou decision_type != 'ASSIGN') n'est JAMAIS acceptée
  //    comme rejeu de cette RPC ASSIGN autonome — dans les trois sites
  //    de vérification (chemin rapide + les deux récupérations).
  // ---------------------------------------------------------------------
  const membershipOperationIdSelected = (assignFnSrc.match(/m\.membership_operation_id/g) || []).length;
  t('membership_operation_id sélectionné dans les 3 SELECT de vérification (chemin rapide + 2 récupérations)',
    membershipOperationIdSelected === 3);

  const decisionTypeSelected = (assignFnSrc.match(/m\.decision_id, m\.cluster_id, m\.observation_id, m\.decision_type,/g) || []).length;
  t('decision_type sélectionné dans les 3 SELECT de vérification (chemin rapide + 2 récupérations)',
    decisionTypeSelected === 3);

  const decisionTypeGuardCount = (assignFnSrc.match(/v_existing\.decision_type IS DISTINCT FROM 'ASSIGN'/g) || []).length;
  t('decision_type = \'ASSIGN\' validé dans les 3 sites (chemin rapide + 2 récupérations)',
    decisionTypeGuardCount === 3);

  const operationIdGuardCount = (assignFnSrc.match(/v_existing\.membership_operation_id IS NOT NULL/g) || []).length;
  t('membership_operation_id IS NULL validé dans les 3 sites (chemin rapide + 2 récupérations)',
    operationIdGuardCount === 3);

  // ---------------------------------------------------------------------
  // 5. Aucune UPDATE/DELETE ; aucun modèle d'invariant concurrent
  // ---------------------------------------------------------------------
  t('aucun UPDATE contre une table d\'événement OPS-023', !/UPDATE\s+public\.event_/i.test(assignFnSrc));
  t('aucun DELETE contre une table d\'événement OPS-023', !/DELETE\s+FROM\s+public\.event_/i.test(assignFnSrc));
  t('aucune nouvelle contrainte UNIQUE/CHECK dupliquée (les invariants restent portés par la migration 0012)',
    !/ADD CONSTRAINT/i.test(liveSource) && !/CREATE UNIQUE INDEX/i.test(liveSource));

  // ---------------------------------------------------------------------
  // 6. Qualification de schéma / pg_catalog
  // ---------------------------------------------------------------------
  const RELATION_TABLES = ['event_clusters', 'event_observation_memberships', 'news_articles'];
  for (const tbl of RELATION_TABLES) {
    const unqualified = new RegExp(`(?<!public\\.)\\b${tbl}\\b`);
    t(`fn_event_assign_observation : toute référence à ${tbl} est qualifiée public.${tbl}`,
      !unqualified.test(assignFnSrc));
  }
  t('gen_random_uuid() qualifié pg_catalog', /pg_catalog\.gen_random_uuid\(\)/.test(assignFnSrc));
}

// ---------------------------------------------------------------------
// 7. Sécurité : EXECUTE révoqué de PUBLIC/anon/authenticated, accordé à
//    service_role uniquement — grants/RLS des TABLES inchangés.
// ---------------------------------------------------------------------
t('REVOKE EXECUTE sur fn_event_lock_cluster de PUBLIC, anon, authenticated',
  /REVOKE ALL ON FUNCTION public\.fn_event_lock_cluster\(UUID\) FROM PUBLIC, anon, authenticated;/.test(liveSource));
t('GRANT EXECUTE sur fn_event_lock_cluster à service_role uniquement',
  /GRANT EXECUTE ON FUNCTION public\.fn_event_lock_cluster\(UUID\) TO service_role;/.test(liveSource));
t('REVOKE ALL sur fn_event_assign_observation de PUBLIC, anon, authenticated',
  /REVOKE ALL ON FUNCTION public\.fn_event_assign_observation\([\s\S]*?\) FROM PUBLIC, anon, authenticated;/.test(liveSource));
t('GRANT EXECUTE sur fn_event_assign_observation à service_role uniquement',
  /GRANT EXECUTE ON FUNCTION public\.fn_event_assign_observation\([\s\S]*?\) TO service_role;/.test(liveSource));
t('aucun GRANT à anon/authenticated/PUBLIC (uniquement des REVOKE les concernant)',
  !/GRANT[^;]*TO\s+(anon|authenticated|PUBLIC)\b/i.test(liveSource));
t('aucun GRANT/REVOKE sur une TABLE (seulement sur des FONCTIONS) — grants de table inchangés',
  !/(?:GRANT|REVOKE)[^;]*\bON\s+(?:TABLE\s+)?event_(?!.*FUNCTION)[a-z_]+\s+(?:TO|FROM)/i.test(liveSource));
t('aucune policy RLS créée/modifiée', !/CREATE POLICY|ALTER TABLE[^;]*ROW LEVEL SECURITY/i.test(liveSource));

// ---------------------------------------------------------------------
// 8. Hors périmètre : migrations 0012/0013 non modifiées, aucune
//    intégration worker/cron/Committee/legacy.
// ---------------------------------------------------------------------
t('migration 0014 ne modifie pas les migrations 0012/0013 (aucune référence à leur nom de fichier)',
  !/0012_event_cluster_version_foundation|0013_event_function_search_path_hardening/.test(source));
t('aucune référence à worker.ts/wrangler/cron dans la migration', !/wrangler|cron|worker\.ts/i.test(liveSource));
t('aucune référence au Comité/Anthropic/notification dans la migration',
  !/anthropic|committee|notifyAiEngine|ai_events/i.test(liveSource));
t('aucune référence à news_events (pipeline legacy) dans la migration', !/news_events/i.test(liveSource));
t('aucun champ analytique EVENT IMPACT introduit (direction/magnitude/pricing/horizon)',
  !/\b(direction|magnitude|pricing_state|horizon)\b/i.test(liveSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
