// Contrat statique de la RPC de mutation de relation de cluster OPS-023
// Phase 2 (migration 0019 : fn_event_create_cluster_relation —
// MERGE/SPLIT atomique, verrou global de topologie, prévention de
// cycle). Analyse le texte SQL de la migration : aucune connexion
// PostgreSQL requise, s'exécute en CI normale. Ne prouve PAS le
// comportement transactionnel réel (verrouillage advisory effectif,
// absence réelle d'interblocage, sémantique de rollback réelle) — une
// vérification live contre Supabase (rollback/probes de non-pollution)
// est effectuée indépendamment, après fusion. Ce fichier prouve
// uniquement que le TEXTE de la migration respecte le contrat gelé.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, '0019_event_cluster_relation_rpc.sql');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('migration 0019 existe', existsSync(MIGRATION_PATH));

const source = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

// ---------------------------------------------------------------------
// 0. Immutabilité des migrations 0012-0018 (déjà appliquées à Supabase
//    en production) : empreintes SHA-256 exactes, jamais modifiées.
// ---------------------------------------------------------------------
const PRIOR_MIGRATIONS_EXPECTED_SHA256 = {
  '0012_event_cluster_version_foundation.sql':
    '4d339f2f1a1e674a05ff11a204cc5caaf468639abb88ade84e379760046ee4ee',
  '0013_event_function_search_path_hardening.sql':
    '6ecef76c10422b992f02cec5277fcb2e29f7744594ec06b9b099f5f3ae79527e',
  '0014_event_membership_atomic_rpcs.sql':
    'ae670a1b610ee28e8a7baac900d29caff91b368b0c3f5c4d5591ab3c75468d73',
  '0015_event_membership_returning_ambiguity_fix.sql':
    '4d358832443b3ecdbc1ae795bc6f911db8428ea96d755248c982e68d5aa10e8c',
  '0016_event_membership_supersession_rpc.sql':
    'e9b51396822e525dbec3cb6d2b057d033e28724409da4de35bcac4a0de3db10a',
  '0017_event_membership_reassign_rpc.sql':
    '12fc58c21c5fcde93a8c05c9fd38991d629dffa85b0ca818aa4298ec074df28d',
  '0018_event_identity_claim_rpc.sql':
    'd07d4bd393596401ab183b8b15e940488add76498f3157262c61a7a3d8afd026',
};

for (const [fileName, expectedSha] of Object.entries(PRIOR_MIGRATIONS_EXPECTED_SHA256)) {
  const filePath = path.join(MIGRATIONS_DIR, fileName);
  const priorSource = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const actualSha = priorSource.length > 0 ? createHash('sha256').update(priorSource).digest('hex') : '';
  t(`migration ${fileName} reste inchangée (empreinte SHA-256 identique)`,
    actualSha === expectedSha, `attendu ${expectedSha}, trouvé ${actualSha}`);
}

t('migration 0019 ne référence le nom de fichier d\'aucune migration antérieure',
  !/0012_event_cluster_version_foundation|0013_event_function_search_path_hardening|0014_event_membership_atomic_rpcs|0015_event_membership_returning_ambiguity_fix|0016_event_membership_supersession_rpc|0017_event_membership_reassign_rpc|0018_event_identity_claim_rpc/.test(source));

// Code SQL réellement exécuté : lignes de commentaire ('--...') retirées.
const liveSource = source
  .split('\n')
  .map((line) => {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join('\n');

// ---------------------------------------------------------------------
// 1. Transactionnalité et périmètre
// ---------------------------------------------------------------------
t('migration 0019 est transactionnelle (BEGIN ... COMMIT)',
  /^\s*BEGIN;/m.test(liveSource) && /COMMIT;\s*$/m.test(liveSource.trimEnd()));

const createFunctionCount = (liveSource.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
t('exactement UNE nouvelle fonction créée', createFunctionCount === 1, `${createFunctionCount} trouvées`);
t('cette fonction est public.fn_event_create_cluster_relation',
  /CREATE OR REPLACE FUNCTION public\.fn_event_create_cluster_relation\(/.test(liveSource));
t('fn_event_lock_cluster n\'est PAS redéfinie (réutilisée telle quelle)',
  !/CREATE OR REPLACE FUNCTION public\.fn_event_lock_cluster/.test(liveSource));
t('aucune nouvelle table créée', !/CREATE TABLE/i.test(liveSource));
t('aucun nouvel index créé', !/CREATE (?:UNIQUE )?INDEX/i.test(liveSource));

function extractFunctionSource(src, fnName) {
  const startRe = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fnName}\\(`);
  const startMatch = startRe.exec(src);
  if (!startMatch) return null;
  const asIdx = src.indexOf('AS $$', startMatch.index);
  if (asIdx === -1) return null;
  const endIdx = src.indexOf('\n$$;', asIdx);
  if (endIdx === -1) return null;
  return src.slice(startMatch.index, endIdx + 4);
}

const fnSrc = extractFunctionSource(liveSource, 'fn_event_create_cluster_relation');
t('corps de fn_event_create_cluster_relation extrait pour analyse', fnSrc !== null);

// ---------------------------------------------------------------------
// 2. Signature, sécurité
// ---------------------------------------------------------------------
if (fnSrc !== null) {
  t('SECURITY INVOKER explicite', /SECURITY INVOKER/.test(fnSrc));
  t('SECURITY DEFINER absent', !/SECURITY DEFINER/.test(fnSrc));
  t('SET search_path = \'\' présent', /SET search_path = ''/.test(fnSrc));

  t('RETURNS TABLE(operation_id, operation_type, from_cluster_ids, to_cluster_ids, superseded_operation_id, edge_count, replayed)',
    /RETURNS TABLE \(\s*operation_id\s+UUID,\s*operation_type\s+TEXT,\s*from_cluster_ids\s+UUID\[\],\s*to_cluster_ids\s+UUID\[\],\s*superseded_operation_id\s+UUID,\s*edge_count\s+INTEGER,\s*replayed\s+BOOLEAN/.test(liveSource));

  const REQUIRED_PARAMS = [
    ['p_operation_type', 'TEXT'], ['p_from_cluster_ids', 'UUID\\[\\]'], ['p_to_cluster_ids', 'UUID\\[\\]'],
    ['p_algorithm_version', 'TEXT'], ['p_decision_actor', 'TEXT'], ['p_reason', 'TEXT'],
    ['p_idempotency_fingerprint', 'TEXT'],
  ];
  const signatureMatch = /CREATE OR REPLACE FUNCTION public\.fn_event_create_cluster_relation\(([\s\S]*?)\)\s*\nRETURNS TABLE/.exec(liveSource);
  const signature = signatureMatch ? signatureMatch[1] : '';
  t('signature extraite', signature.length > 0);

  for (const [param, type] of REQUIRED_PARAMS) {
    const re = new RegExp(`${param}\\s+${type}(?!\\s+DEFAULT)`);
    t(`paramètre obligatoire ${param} présent, sans DEFAULT`, re.test(signature));
  }
  t('paramètre optionnel p_supersedes_operation_id présent avec DEFAULT NULL',
    /p_supersedes_operation_id\s+UUID\s+DEFAULT NULL/.test(signature));
  const optionalIdx = signature.search(/p_supersedes_operation_id\s+UUID\s+DEFAULT NULL/);
  t('aucun paramètre obligatoire déclaré après le paramètre optionnel (ordre PostgreSQL valide)',
    optionalIdx > -1 && REQUIRED_PARAMS.every(([param]) => signature.indexOf(param) < optionalIdx));

  // ---------------------------------------------------------------------
  // 3. Validation de base : operation_type, tableaux non vides, NULL
  //    interdit, doublons rejetés explicitement, chevauchement from/to.
  // ---------------------------------------------------------------------
  t('rejette p_operation_type NULL', /IF p_operation_type IS NULL THEN/.test(fnSrc));
  t('n\'accepte que MERGE/SPLIT',
    /IF p_operation_type NOT IN \('MERGE', 'SPLIT'\) THEN/.test(fnSrc));
  t('rejette p_from_cluster_ids NULL ou vide',
    /IF p_from_cluster_ids IS NULL OR cardinality\(p_from_cluster_ids\) = 0 THEN/.test(fnSrc));
  t('rejette p_to_cluster_ids NULL ou vide',
    /IF p_to_cluster_ids IS NULL OR cardinality\(p_to_cluster_ids\) = 0 THEN/.test(fnSrc));
  t('rejette un élément NULL dans p_from_cluster_ids',
    /FROM unnest\(p_from_cluster_ids\) AS v WHERE v IS NULL/.test(fnSrc));
  t('rejette un élément NULL dans p_to_cluster_ids',
    /FROM unnest\(p_to_cluster_ids\) AS v WHERE v IS NULL/.test(fnSrc));
  t('rejette EXPLICITEMENT les doublons dans p_from_cluster_ids (comparaison count(*) vs count(DISTINCT))',
    /count\(\*\) FROM unnest\(p_from_cluster_ids\) v\) <> \(SELECT count\(DISTINCT v\) FROM unnest\(p_from_cluster_ids\) v\)/.test(fnSrc));
  t('rejette EXPLICITEMENT les doublons dans p_to_cluster_ids',
    /count\(\*\) FROM unnest\(p_to_cluster_ids\) v\) <> \(SELECT count\(DISTINCT v\) FROM unnest\(p_to_cluster_ids\) v\)/.test(fnSrc));
  t('le message de doublon documente explicitement l\'absence de déduplication silencieuse',
    /aucune déduplication silencieuse/.test(fnSrc));
  t('rejette un cluster apparaissant à la fois dans from et to',
    /FROM unnest\(p_from_cluster_ids\) f WHERE f = ANY\(p_to_cluster_ids\)/.test(fnSrc));
  t('rejette p_algorithm_version/p_decision_actor/p_reason/p_idempotency_fingerprint NULL/vide',
    /p_algorithm_version IS NULL OR length\(btrim\(p_algorithm_version\)\) = 0/.test(fnSrc)
    && /p_decision_actor IS NULL OR length\(btrim\(p_decision_actor\)\) = 0/.test(fnSrc)
    && /p_reason IS NULL OR length\(btrim\(p_reason\)\) = 0/.test(fnSrc)
    && /p_idempotency_fingerprint IS NULL OR length\(btrim\(p_idempotency_fingerprint\)\) = 0/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 4. Copies triées déterministes + cardinalité explicite MERGE/SPLIT.
  // ---------------------------------------------------------------------
  t('construit v_sorted_from trié déterministe (array_agg(v ORDER BY v))',
    /SELECT array_agg\(v ORDER BY v\) INTO v_sorted_from FROM unnest\(p_from_cluster_ids\) v;/.test(fnSrc));
  t('construit v_sorted_to trié déterministe',
    /SELECT array_agg\(v ORDER BY v\) INTO v_sorted_to FROM unnest\(p_to_cluster_ids\) v;/.test(fnSrc));
  t('cardinalité MERGE explicite : >= 2 from, = 1 to (AVANT tout INSERT)',
    /IF cardinality\(v_sorted_from\) < 2 THEN/.test(fnSrc) && /IF cardinality\(v_sorted_to\) <> 1 THEN/.test(fnSrc));
  t('cardinalité SPLIT explicite : = 1 from, >= 2 to',
    /IF cardinality\(v_sorted_from\) <> 1 THEN/.test(fnSrc) && /IF cardinality\(v_sorted_to\) < 2 THEN/.test(fnSrc));
  const cardinalityCheckIdx = fnSrc.search(/IF cardinality\(v_sorted_from\) < 2 THEN/);
  const firstInsertHeaderIdx = fnSrc.indexOf('INSERT INTO public.event_cluster_relation_operations AS o (');
  t('la validation de cardinalité survient AVANT tout INSERT',
    cardinalityCheckIdx > -1 && firstInsertHeaderIdx > -1 && cardinalityCheckIdx < firstInsertHeaderIdx);

  // ---------------------------------------------------------------------
  // 5. Arêtes candidates dérivées CANONIQUEMENT par la RPC (jamais un
  //    payload arbitraire de l'appelant).
  // ---------------------------------------------------------------------
  t('MERGE : v_candidate_from = v_sorted_from, v_candidate_to = array_fill(unique to, N)',
    /v_candidate_from := v_sorted_from;\s*\n\s*v_candidate_to := array_fill\(v_sorted_to\[1\], ARRAY\[cardinality\(v_sorted_from\)\]\);/.test(fnSrc));
  t('SPLIT : v_candidate_from = array_fill(unique from, N), v_candidate_to = v_sorted_to',
    /v_candidate_from := array_fill\(v_sorted_from\[1\], ARRAY\[cardinality\(v_sorted_to\)\]\);\s*\n\s*v_candidate_to := v_sorted_to;/.test(fnSrc));
  t('aucun paramètre d\'arête brute (p_edges/p_from_to_pairs) n\'existe dans la signature',
    !/p_edges|p_from_to_pairs|p_relation_edges/i.test(signature));

  // ---------------------------------------------------------------------
  // 6. Idempotence : précheck avant tout verrou, ensemble d'arêtes exact,
  //    opération existante structurellement valide.
  // ---------------------------------------------------------------------
  const idempotencyWhereIndices = [];
  {
    let searchFrom = 0;
    for (;;) {
      const idx = fnSrc.indexOf('WHERE o.idempotency_fingerprint = p_idempotency_fingerprint', searchFrom);
      if (idx === -1) break;
      idempotencyWhereIndices.push(idx);
      searchFrom = idx + 1;
    }
  }
  const topologyLockIdx = fnSrc.indexOf("pg_catalog.hashtext('xau_v2:event_relation')");
  t('précheck d\'idempotence présent AVANT le verrou global de topologie',
    idempotencyWhereIndices.length >= 2 && topologyLockIdx > -1 && idempotencyWhereIndices[0] < topologyLockIdx);
  t('l\'opération existante trouvée doit elle-même être structurellement valide pour son operation_type (filet anti-corruption)',
    (fnSrc.match(/opération existante % \(idempotency_fingerprint %\) a un ensemble d''arêtes structurellement invalide/g) || []).length >= 3);
  t('la validation de rejeu compare l\'ensemble EXACT d\'arêtes dérivées (v_edge_set_matches, via generate_subscripts)',
    (fnSrc.match(/NOT EXISTS \(\s*\n\s*SELECT 1 FROM generate_subscripts\(v_candidate_from, 1\) i\s*\n\s*WHERE NOT EXISTS \(/g) || []).length >= 3);
  t('la validation de rejeu compare operation_type, ensembles triés from/to, métadonnées, supersedes_operation_id',
    (fnSrc.match(/v_existing\.operation_type IS DISTINCT FROM p_operation_type/g) || []).length >= 3
    && (fnSrc.match(/v_existing_sorted_from IS DISTINCT FROM v_sorted_from/g) || []).length >= 3
    && (fnSrc.match(/v_existing_sorted_to IS DISTINCT FROM v_sorted_to/g) || []).length >= 3
    && (fnSrc.match(/v_existing\.supersedes_operation_id IS DISTINCT FROM p_supersedes_operation_id/g) || []).length >= 3);

  // ---------------------------------------------------------------------
  // 7. Verrou GLOBAL de topologie : namespace explicite, AVANT tout
  //    verrou de cluster.
  // ---------------------------------------------------------------------
  t('verrou advisory GLOBAL présent (pg_advisory_xact_lock)',
    /PERFORM pg_catalog\.pg_advisory_xact_lock\(\s*\n\s*pg_catalog\.hashtext\('xau_v2:event_relation'\),\s*\n\s*pg_catalog\.hashtext\('topology'\)\s*\n\s*\);/.test(fnSrc));
  t('namespace explicite xau_v2:event_relation / topology',
    /pg_catalog\.hashtext\('xau_v2:event_relation'\)/.test(fnSrc) && /pg_catalog\.hashtext\('topology'\)/.test(fnSrc));
  const clusterLockLoopIdx = fnSrc.indexOf('FOREACH v_lock_cluster_id IN ARRAY v_lock_cluster_ids LOOP');
  t('le verrou global de topologie précède la boucle de verrouillage de cluster',
    topologyLockIdx > -1 && clusterLockLoopIdx > -1 && topologyLockIdx < clusterLockLoopIdx);
  t('ce namespace n\'est jamais réutilisé pour membership (xau_v2:event_cluster) ou identité (xau_v2:event_identity)',
    !/pg_catalog\.hashtext\('xau_v2:event_cluster'\)/.test(fnSrc) && !/pg_catalog\.hashtext\('xau_v2:event_identity'\)/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 8. Chargement du prédécesseur AVANT l'ensemble final de verrous de
  //    cluster ; union candidats+prédécesseur ; déduplication + tri UUID
  //    ; SEUL fn_event_lock_cluster utilisé.
  // ---------------------------------------------------------------------
  const predecessorLoadIdx = fnSrc.indexOf('WHERE o.operation_id = p_supersedes_operation_id');
  t('le prédécesseur est chargé (existence + ses clusters via arêtes) APRÈS le verrou global',
    predecessorLoadIdx > -1 && topologyLockIdx > -1 && predecessorLoadIdx > topologyLockIdx);
  t('le prédécesseur est chargé AVANT la construction de l\'ensemble final de verrous de cluster',
    predecessorLoadIdx > -1 && clusterLockLoopIdx > -1 && predecessorLoadIdx < clusterLockLoopIdx);
  t('l\'ensemble de verrous de cluster est l\'union candidats + prédécesseur (from ∪ to ∪ predecessor from ∪ predecessor to)',
    /v_sorted_from \|\| v_sorted_to\s*\n\s*\|\| COALESCE\(v_predecessor_from_clusters, ARRAY\[\]::UUID\[\]\)\s*\n\s*\|\| COALESCE\(v_predecessor_to_clusters, ARRAY\[\]::UUID\[\]\)/.test(fnSrc));
  t('l\'ensemble de verrous est dédupliqué et TRIÉ par UUID (array_agg(DISTINCT c ORDER BY c))',
    /SELECT array_agg\(DISTINCT c ORDER BY c\)\s*\n\s*INTO v_lock_cluster_ids/.test(fnSrc));
  t('SEUL public.fn_event_lock_cluster est utilisé pour verrouiller les clusters (aucune autre implémentation de verrou de cluster)',
    /PERFORM public\.fn_event_lock_cluster\(v_lock_cluster_id\);/.test(fnSrc)
    && (fnSrc.match(/PERFORM public\.fn_event_lock_cluster\(/g) || []).length === 1);

  // ---------------------------------------------------------------------
  // 9. Re-vérification d'idempotence après TOUS les verrous, AVANT le
  //    rejet de fraîcheur périmée.
  // ---------------------------------------------------------------------
  t('re-vérification d\'idempotence présente APRÈS le verrou global ET tous les verrous de cluster',
    idempotencyWhereIndices.length >= 2 && clusterLockLoopIdx > -1 && idempotencyWhereIndices[1] > clusterLockLoopIdx);

  const REPLAY_TRUE_RETURN_MARKER =
    'RETURN QUERY SELECT v_existing.operation_id, v_existing.operation_type, v_existing_sorted_from, v_existing_sorted_to, v_existing.supersedes_operation_id, v_existing_edge_count, true;';
  const replayTrueReturnIndices = [];
  {
    let searchFrom = 0;
    for (;;) {
      const idx = fnSrc.indexOf(REPLAY_TRUE_RETURN_MARKER, searchFrom);
      if (idx === -1) break;
      replayTrueReturnIndices.push(idx);
      searchFrom = idx + 1;
    }
  }
  t('exactement 3 retours replayed=true trouvés (précheck, recheck post-verrous, récupération unique_violation)',
    replayTrueReturnIndices.length === 3, `trouvé ${replayTrueReturnIndices.length}`);
  const postLockRecheckReturnIdx = replayTrueReturnIndices.length >= 2 ? replayTrueReturnIndices[1] : -1;
  const stalePredecessorCheckIdx = fnSrc.indexOf('IF v_predecessor_successor_exists THEN');
  t('INVARIANT CRITIQUE : la RE-vérification d\'idempotence post-verrous précède le rejet de fraîcheur périmée',
    postLockRecheckReturnIdx > -1 && stalePredecessorCheckIdx > -1 && postLockRecheckReturnIdx < stalePredecessorCheckIdx);

  // ---------------------------------------------------------------------
  // 10. Existence des clusters candidats, sous verrou.
  // ---------------------------------------------------------------------
  const missingClusterIdx = fnSrc.indexOf('SELECT c INTO v_missing_cluster_id');
  t('vérifie l\'existence de chaque cluster candidat après les verrous',
    missingClusterIdx > -1 && clusterLockLoopIdx > -1 && missingClusterIdx > clusterLockLoopIdx);
  t('la vérification d\'existence porte sur v_sorted_from || v_sorted_to (candidats uniquement, pas le prédécesseur)',
    /FROM unnest\(v_sorted_from \|\| v_sorted_to\) c\s*\n\s*WHERE NOT EXISTS \(SELECT 1 FROM public\.event_clusters ec WHERE ec\.id = c\)/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 11. Fraîcheur du prédécesseur : détection explicite de successeur,
  //     jamais uniquement la contrainte UNIQUE.
  // ---------------------------------------------------------------------
  t('détecte explicitement un successeur déjà existant via une lecture dédiée',
    /SELECT EXISTS \(\s*\n\s*SELECT 1 FROM public\.event_cluster_relation_operations successor\s*\n\s*WHERE successor\.supersedes_operation_id = p_supersedes_operation_id\s*\n\s*\) INTO v_predecessor_successor_exists;/.test(fnSrc));
  t('le commentaire documente explicitement que la contrainte UNIQUE n\'est pas le mécanisme de contrôle de flux normal',
    /d[ée]pendance exclusive[\s\S]{0,20}uq_cluster_relation_ops_supersedes/.test(source));
  t('la supersession PEUT changer de operation_type (MERGE<->SPLIT) — aucune validation qui l\'interdirait',
    !/p_supersedes_operation_id IS NOT NULL AND p_operation_type/.test(fnSrc)
    && !/v_predecessor\.operation_type IS DISTINCT FROM p_operation_type/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 12. Graphe ACTIF : aucun successeur (jamais decided_at), prédécesseur
  //     corrigé EXCLU, arêtes candidates INCLUSES, CTE récursive bornée.
  // ---------------------------------------------------------------------
  t('définit les arêtes ACTIVES via NOT EXISTS (aucun successeur) — jamais decided_at',
    /active_edges AS \(\s*\n\s*SELECT e\.from_cluster_id, e\.to_cluster_id\s*\n\s*FROM public\.event_cluster_relation_edges e\s*\n\s*WHERE NOT EXISTS \(/.test(fnSrc));
  t('ne substitue jamais decided_at à la détection de currentness par graphe',
    !/ORDER BY\s+decided_at/i.test(fnSrc) && !/decided_at\s*[<>]/.test(fnSrc));
  t('exclut explicitement les arêtes du prédécesseur corrigé du graphe actif',
    /AND \(p_supersedes_operation_id IS NULL OR e\.operation_id <> p_supersedes_operation_id\)/.test(fnSrc));
  t('inclut les arêtes CANDIDATES dans le graphe utilisé pour la prévention de cycle',
    /candidate_edges AS \(\s*\n\s*SELECT v_candidate_from\[i\] AS from_cluster_id, v_candidate_to\[i\] AS to_cluster_id/.test(fnSrc)
    && /graph_edges AS \(\s*\n\s*SELECT from_cluster_id, to_cluster_id FROM active_edges\s*\n\s*UNION\s*\n\s*SELECT from_cluster_id, to_cluster_id FROM candidate_edges\s*\n\s*\)/.test(fnSrc));
  t('utilise WITH RECURSIVE pour une accessibilité dirigée déterministe',
    /WITH RECURSIVE/.test(fnSrc));
  t('la fermeture transitive utilise UNION (pas UNION ALL) — borne le nombre d\'itérations, immunise contre un cycle préexistant infini',
    /reachable \(start_node, end_node\) AS \(\s*\n\s*SELECT from_cluster_id, to_cluster_id FROM graph_edges\s*\n\s*UNION\s*\n\s*SELECT r\.start_node, g\.to_cluster_id/.test(fnSrc)
    && !/reachable \(start_node, end_node\) AS \([\s\S]{0,200}UNION ALL/.test(fnSrc));
  t('pour chaque arête candidate U->V, vérifie qu\'aucun chemin V->...->U n\'existe (jointure reachable sur start=to, end=from)',
    /JOIN reachable r\s*\n\s*ON r\.start_node = v_candidate_to\[i\]\s*\n\s*AND r\.end_node = v_candidate_from\[i\]/.test(fnSrc));
  t('rejette explicitement le cycle en identifiant l\'arête candidate en cause',
    /IF v_cycle_edge_from IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION/.test(fnSrc));

  const cycleCteIdx = fnSrc.indexOf('WITH RECURSIVE');
  t('la vérification de cycle survient SOUS le verrou global, AVANT l\'INSERT',
    cycleCteIdx > -1 && topologyLockIdx > -1 && firstInsertHeaderIdx > -1
    && cycleCteIdx > topologyLockIdx && cycleCteIdx < firstInsertHeaderIdx);
  t('la vérification de cycle survient APRÈS le rejet de fraîcheur périmée (le prédécesseur exclu doit être définitivement écarté avant)',
    cycleCteIdx > -1 && stalePredecessorCheckIdx > -1 && cycleCteIdx > stalePredecessorCheckIdx);

  // ---------------------------------------------------------------------
  // 13. Insertion atomique : en-tête une fois, ensemble complet d'arêtes,
  //     alias explicite + RETURNING qualifié, aucun UPDATE/DELETE.
  // ---------------------------------------------------------------------
  t('l\'INSERT de l\'en-tête porte un alias de cible explicite (AS o)',
    /INSERT INTO public\.event_cluster_relation_operations AS o \(/.test(fnSrc));
  t('le RETURNING référence l\'alias qualifié (o.operation_id)',
    /RETURNING o\.operation_id INTO v_operation_id;/.test(fnSrc));
  t('un seul en-tête inséré (un seul INSERT INTO ...operations)',
    (fnSrc.match(/INSERT INTO public\.event_cluster_relation_operations/g) || []).length === 1);
  t('l\'ensemble COMPLET des arêtes candidates est inséré via generate_subscripts (bulk INSERT ... SELECT)',
    /INSERT INTO public\.event_cluster_relation_edges \(operation_id, from_cluster_id, to_cluster_id\)\s*\n\s*SELECT v_operation_id, v_candidate_from\[i\], v_candidate_to\[i\]\s*\n\s*FROM generate_subscripts\(v_candidate_from, 1\) i;/.test(fnSrc));
  t('aucun UPDATE contre une table d\'événement OPS-023', !/UPDATE\s+public\.event_/i.test(fnSrc));
  t('aucun DELETE contre une table d\'événement OPS-023', !/DELETE\s+FROM\s+public\.event_/i.test(fnSrc));

  // ---------------------------------------------------------------------
  // 14. Récupération scopée sur violation d'unicité.
  // ---------------------------------------------------------------------
  t('récupération EXCEPTION WHEN unique_violation présente',
    /EXCEPTION WHEN unique_violation THEN/.test(fnSrc));
  t('la récupération ne catch QUE uq_cluster_relation_ops_idempotency_fingerprint (GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME), toute autre violation est relevée (RAISE)',
    /GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;\s*\n\s*IF v_constraint_name IS DISTINCT FROM 'uq_cluster_relation_ops_idempotency_fingerprint' THEN\s*\n\s*RAISE;/.test(fnSrc));
  t('uq_cluster_relation_ops_supersedes n\'est jamais avalée par la récupération (mentionnée uniquement en commentaire, jamais comme cible de comparaison IS DISTINCT FROM constraint_name)',
    !/v_constraint_name IS DISTINCT FROM 'uq_cluster_relation_ops_supersedes'/.test(fnSrc)
    && !/v_constraint_name = 'uq_cluster_relation_ops_supersedes'/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 15. Qualification de schéma.
  // ---------------------------------------------------------------------
  const RELATION_TABLES = ['event_clusters', 'event_cluster_relation_operations', 'event_cluster_relation_edges'];
  for (const tbl of RELATION_TABLES) {
    const unqualified = new RegExp(`(?<!public\\.)\\b${tbl}\\b`);
    t(`toute référence à ${tbl} est qualifiée public.${tbl}`, !unqualified.test(fnSrc));
  }
  t('fn_event_lock_cluster est appelée qualifiée public.',
    /public\.fn_event_lock_cluster\(/.test(fnSrc));
  t('pg_advisory_xact_lock/hashtext sont qualifiées pg_catalog.',
    /pg_catalog\.pg_advisory_xact_lock\(/.test(fnSrc) && /pg_catalog\.hashtext\(/.test(fnSrc));
}

// ---------------------------------------------------------------------
// 16. Sécurité : EXECUTE révoqué/accordé, table grants/RLS inchangés.
// ---------------------------------------------------------------------
t('REVOKE ALL sur fn_event_create_cluster_relation de PUBLIC, anon, authenticated',
  /REVOKE ALL ON FUNCTION public\.fn_event_create_cluster_relation\([\s\S]*?\) FROM PUBLIC, anon, authenticated;/.test(liveSource));
t('GRANT EXECUTE sur fn_event_create_cluster_relation à service_role uniquement',
  /GRANT EXECUTE ON FUNCTION public\.fn_event_create_cluster_relation\([\s\S]*?\) TO service_role;/.test(liveSource));
t('aucun GRANT à anon/authenticated/PUBLIC', !/GRANT[^;]*TO\s+(anon|authenticated|PUBLIC)\b/i.test(liveSource));
t('aucun GRANT/REVOKE sur une TABLE (seulement sur des fonctions)',
  !/(?:GRANT|REVOKE)[^;]*\bON\s+(?:TABLE\s+)?event_(?!.*FUNCTION)[a-z_]+\s+(?:TO|FROM)/i.test(liveSource));
t('aucune policy RLS créée/modifiée', !/CREATE POLICY|ALTER TABLE[^;]*ROW LEVEL SECURITY/i.test(liveSource));
t('aucun ALTER TABLE', !/ALTER TABLE/i.test(liveSource));

// ---------------------------------------------------------------------
// 17. Hors périmètre : aucune fonctionnalité hors périmètre.
// ---------------------------------------------------------------------
t('aucune référence à worker.ts/wrangler/cron dans la migration', !/wrangler|cron|worker\.ts/i.test(liveSource));
t('aucune référence au Comité/Anthropic/notification dans la migration',
  !/anthropic|committee|notifyAiEngine|ai_events/i.test(liveSource));
t('aucune référence à news_events (pipeline legacy) dans la migration', !/news_events/i.test(liveSource));
t('aucune référence à news_articles (cette RPC ne touche jamais les observations RAW)',
  !/news_articles/i.test(liveSource));
t('aucune référence à une future RPC de version/processeur/membership/identité',
  !/fn_event_create_event_version|fn_event_assign_observation|fn_event_supersede_membership|fn_event_reassign_membership|fn_event_assert_identity_claim/i.test(liveSource));
t('aucun champ analytique EVENT IMPACT introduit (direction/magnitude/pricing/horizon)',
  !/\b(direction|magnitude|pricing_state|horizon)\b/i.test(liveSource));
t('event_clusters n\'est jamais modifié (aucun UPDATE, aucune colonne ajoutée)',
  !/UPDATE\s+public\.event_clusters/i.test(liveSource) && !/ALTER TABLE\s+.*event_clusters/i.test(liveSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
