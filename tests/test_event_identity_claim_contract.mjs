// Contrat statique de la RPC de revendication d'identité forte OPS-023
// Phase 2 (migration 0018 : fn_event_assert_identity_claim — assertion/
// supersession sur event_cluster_identity_claims, verrouillage de clé
// d'identité, collision inter-cluster). Analyse le texte SQL de la
// migration : aucune connexion PostgreSQL requise, s'exécute en CI
// normale. Ne prouve PAS le comportement transactionnel réel
// (verrouillage advisory effectif, ordre réel d'acquisition, concurrence
// réelle) — une vérification live contre Supabase (rollback/probes de
// non-pollution) est effectuée indépendamment, après fusion. Ce fichier
// prouve uniquement que le TEXTE de la migration respecte le contrat
// gelé.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, '0018_event_identity_claim_rpc.sql');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('migration 0018 existe', existsSync(MIGRATION_PATH));

const source = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

// ---------------------------------------------------------------------
// 0. Immutabilité des migrations 0012-0017 (déjà appliquées à Supabase
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
};

for (const [fileName, expectedSha] of Object.entries(PRIOR_MIGRATIONS_EXPECTED_SHA256)) {
  const filePath = path.join(MIGRATIONS_DIR, fileName);
  const priorSource = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const actualSha = priorSource.length > 0 ? createHash('sha256').update(priorSource).digest('hex') : '';
  t(`migration ${fileName} reste inchangée (empreinte SHA-256 identique)`,
    actualSha === expectedSha, `attendu ${expectedSha}, trouvé ${actualSha}`);
}

t('migration 0018 ne référence le nom de fichier d\'aucune migration antérieure',
  !/0012_event_cluster_version_foundation|0013_event_function_search_path_hardening|0014_event_membership_atomic_rpcs|0015_event_membership_returning_ambiguity_fix|0016_event_membership_supersession_rpc|0017_event_membership_reassign_rpc/.test(source));

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
t('migration 0018 est transactionnelle (BEGIN ... COMMIT)',
  /^\s*BEGIN;/m.test(liveSource) && /COMMIT;\s*$/m.test(liveSource.trimEnd()));

const createFunctionCount = (liveSource.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
t('exactement UNE nouvelle fonction créée', createFunctionCount === 1, `${createFunctionCount} trouvées`);
t('cette fonction est public.fn_event_assert_identity_claim',
  /CREATE OR REPLACE FUNCTION public\.fn_event_assert_identity_claim\(/.test(liveSource));
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

const fnSrc = extractFunctionSource(liveSource, 'fn_event_assert_identity_claim');
t('corps de fn_event_assert_identity_claim extrait pour analyse', fnSrc !== null);

// ---------------------------------------------------------------------
// 2. Signature, sécurité
// ---------------------------------------------------------------------
if (fnSrc !== null) {
  t('SECURITY INVOKER explicite', /SECURITY INVOKER/.test(fnSrc));
  t('SECURITY DEFINER absent', !/SECURITY DEFINER/.test(fnSrc));
  t('SET search_path = \'\' présent', /SET search_path = ''/.test(fnSrc));

  t('RETURNS TABLE(cluster_id, identity_claim_id, strong_identity_key, superseded_claim_id, replayed)',
    /RETURNS TABLE \(\s*cluster_id\s+UUID,\s*identity_claim_id\s+UUID,\s*strong_identity_key\s+TEXT,\s*superseded_claim_id\s+UUID,\s*replayed\s+BOOLEAN/.test(liveSource));

  const REQUIRED_PARAMS = [
    ['p_cluster_id', 'UUID'], ['p_authority_namespace', 'TEXT'], ['p_identity_type', 'TEXT'],
    ['p_identity_value', 'TEXT'], ['p_knowledge_cutoff', 'TIMESTAMPTZ'], ['p_algorithm_version', 'TEXT'],
    ['p_decision_actor', 'TEXT'], ['p_reason', 'TEXT'], ['p_idempotency_fingerprint', 'TEXT'],
  ];
  const signatureMatch = /CREATE OR REPLACE FUNCTION public\.fn_event_assert_identity_claim\(([\s\S]*?)\)\s*\nRETURNS TABLE/.exec(liveSource);
  const signature = signatureMatch ? signatureMatch[1] : '';
  t('signature extraite', signature.length > 0);

  for (const [param, type] of REQUIRED_PARAMS) {
    const re = new RegExp(`${param}\\s+${type}(?!\\s+DEFAULT)`);
    t(`paramètre obligatoire ${param} (${type}) présent, sans DEFAULT`, re.test(signature));
  }
  t('paramètre optionnel p_supersedes_claim_id présent avec DEFAULT NULL',
    /p_supersedes_claim_id\s+UUID\s+DEFAULT NULL/.test(signature));
  const optionalIdx = signature.search(/p_supersedes_claim_id\s+UUID\s+DEFAULT NULL/);
  t('aucun paramètre obligatoire déclaré après le paramètre optionnel (ordre PostgreSQL valide)',
    optionalIdx > -1 && REQUIRED_PARAMS.every(([param]) => signature.indexOf(param) < optionalIdx));

  // ---------------------------------------------------------------------
  // 3. Validation scalaire de base + intégrité temporelle.
  // ---------------------------------------------------------------------
  const SCALAR_NULL_CHECKS = [
    'IF p_cluster_id IS NULL THEN',
    "IF p_authority_namespace IS NULL OR length(btrim(p_authority_namespace)) = 0 THEN",
    "IF p_identity_type IS NULL OR length(btrim(p_identity_type)) = 0 THEN",
    "IF p_identity_value IS NULL OR length(btrim(p_identity_value)) = 0 THEN",
    'IF p_knowledge_cutoff IS NULL THEN',
    "IF p_algorithm_version IS NULL OR length(btrim(p_algorithm_version)) = 0 THEN",
    "IF p_decision_actor IS NULL OR length(btrim(p_decision_actor)) = 0 THEN",
    "IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN",
    "IF p_idempotency_fingerprint IS NULL OR length(btrim(p_idempotency_fingerprint)) = 0 THEN",
  ];
  for (const snippet of SCALAR_NULL_CHECKS) {
    t(`validation scalaire présente : ${snippet}`, fnSrc.includes(snippet));
  }
  t('rejette p_knowledge_cutoff dans le futur (> transaction_timestamp())',
    /IF p_knowledge_cutoff > pg_catalog\.transaction_timestamp\(\) THEN/.test(fnSrc));
  t('un cutoff historique/de rejeu reste autorisé (aucun rejet sur < now())',
    !/p_knowledge_cutoff\s*<\s*pg_catalog\.transaction_timestamp\(\)/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 4. Formule strong_identity_key EXACTEMENT identique à la colonne
  //    GENERATED (0012) : authority_namespace || chr(31) || identity_type
  //    || chr(31) || identity_value, sha256 hex.
  // ---------------------------------------------------------------------
  t('calcule v_new_strong_identity_key avec la formule byte-exacte de la colonne GENERATED (0012)',
    /v_new_strong_identity_key := encode\(\s*\n\s*extensions\.digest\(\s*\n\s*p_authority_namespace \|\| chr\(31\) \|\| p_identity_type \|\| chr\(31\) \|\| p_identity_value,\s*\n\s*'sha256'\s*\n\s*\),\s*\n\s*'hex'\s*\n\s*\);/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 5. Aucune dérivation depuis news_articles / identifiants d'observation.
  // ---------------------------------------------------------------------
  t('aucune référence à news_articles dans le CORPS de la fonction (cette RPC ne lit jamais les observations RAW ; le nom peut légitimement apparaître dans COMMENT ON FUNCTION, hors périmètre de ce test)',
    !/news_articles/i.test(fnSrc));
  t('aucune dérivation depuis provider_item_id/canonical_url/article URL/provider-source-domain dans le CORPS de la fonction',
    !/provider_item_id|canonical_url|article_url|source_domain/i.test(fnSrc));

  // ---------------------------------------------------------------------
  // 6. Verrouillage de cluster : primitif partagé, AVANT toute validation
  //    de collision.
  // ---------------------------------------------------------------------
  t('utilise le primitif de verrou partagé fn_event_lock_cluster',
    /PERFORM public\.fn_event_lock_cluster\(p_cluster_id\);/.test(fnSrc));

  const clusterLockIdx = fnSrc.indexOf('PERFORM public.fn_event_lock_cluster(p_cluster_id);');
  const activeClaimCountIdx = fnSrc.indexOf('SELECT count(*) INTO v_active_claim_count');
  t('le verrou de cluster est acquis AVANT la validation de collision de clé active',
    clusterLockIdx > -1 && activeClaimCountIdx > -1 && clusterLockIdx < activeClaimCountIdx);

  // ---------------------------------------------------------------------
  // 7. Verrouillage advisory de clé d'identité : namespace explicite,
  //    APRÈS le verrou de cluster, AVANT la collision, tri lexical
  //    déterministe quand deux clés distinctes, une seule fois si
  //    identiques.
  // ---------------------------------------------------------------------
  t('verrou advisory d\'identité présent (pg_advisory_xact_lock)',
    /pg_catalog\.pg_advisory_xact_lock\(/.test(fnSrc));
  t('namespace advisory explicite \'xau_v2:event_identity\'',
    /pg_catalog\.hashtext\('xau_v2:event_identity'\)/.test(fnSrc));

  const advisoryLockIndices = [];
  {
    let searchFrom = 0;
    for (;;) {
      const idx = fnSrc.indexOf('pg_catalog.pg_advisory_xact_lock(', searchFrom);
      if (idx === -1) break;
      advisoryLockIndices.push(idx);
      searchFrom = idx + 1;
    }
  }
  t('au moins 2 sites d\'appel pg_advisory_xact_lock existent dans le texte (branche 2-clés + branche 1-clé)',
    advisoryLockIndices.length >= 2);
  t('tous les verrous advisory d\'identité sont acquis APRÈS le verrou de cluster et AVANT la validation de collision',
    advisoryLockIndices.every((idx) => idx > clusterLockIdx && idx < activeClaimCountIdx));

  t('branche à DEUX clés : calcule un ordre lexical trié (min puis max) quand les clés diffèrent',
    /IF v_old_strong_identity_key < v_new_strong_identity_key THEN\s*\n\s*v_lock_key_first := v_old_strong_identity_key;\s*\n\s*v_lock_key_second := v_new_strong_identity_key;\s*\n\s*ELSE\s*\n\s*v_lock_key_first := v_new_strong_identity_key;\s*\n\s*v_lock_key_second := v_old_strong_identity_key;\s*\n\s*END IF;/.test(fnSrc));
  t('verrouille v_lock_key_first PUIS v_lock_key_second (ordre trié respecté à l\'acquisition)',
    (() => {
      const firstIdx = fnSrc.indexOf('pg_catalog.hashtext(v_lock_key_first)');
      const secondIdx = fnSrc.indexOf('pg_catalog.hashtext(v_lock_key_second)');
      return firstIdx > -1 && secondIdx > -1 && firstIdx < secondIdx;
    })());
  t('condition de branchement 2-clés vs 1-clé : deux clés seulement si p_supersedes_claim_id fourni ET clés distinctes',
    /IF p_supersedes_claim_id IS NOT NULL AND v_old_strong_identity_key IS DISTINCT FROM v_new_strong_identity_key THEN/.test(fnSrc));
  t('branche ELSE (clé identique ou assertion fraîche) verrouille v_new_strong_identity_key une seule fois',
    /ELSE\s*\n\s*PERFORM pg_catalog\.pg_advisory_xact_lock\(\s*\n\s*pg_catalog\.hashtext\('xau_v2:event_identity'\),\s*\n\s*pg_catalog\.hashtext\(v_new_strong_identity_key\)\s*\n\s*\);\s*\n\s*END IF;/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 8. Idempotence : précheck avant tout verrou, recheck après verrou de
  //    cluster ET verrou(s) d'identité.
  // ---------------------------------------------------------------------
  const idempotencyWhereIndices = [];
  {
    let searchFrom = 0;
    for (;;) {
      const idx = fnSrc.indexOf('WHERE c.idempotency_fingerprint = p_idempotency_fingerprint', searchFrom);
      if (idx === -1) break;
      idempotencyWhereIndices.push(idx);
      searchFrom = idx + 1;
    }
  }
  t('précheck d\'idempotence présent AVANT le verrou de cluster', idempotencyWhereIndices.length >= 2 && idempotencyWhereIndices[0] < clusterLockIdx);
  const lastAdvisoryLockIdx = advisoryLockIndices.length > 0 ? advisoryLockIndices[advisoryLockIndices.length - 1] : -1;
  t('re-vérification d\'idempotence présente APRÈS le verrou de cluster ET le(s) verrou(s) d\'identité, AVANT la validation de collision',
    idempotencyWhereIndices.some((idx) => idx > lastAdvisoryLockIdx && idx < activeClaimCountIdx));
  t('la validation de rejeu compare la clé d\'identité GÉNÉRÉE (v_new_strong_identity_key), pas seulement les champs bruts',
    (fnSrc.match(/v_existing\.strong_identity_key IS DISTINCT FROM v_new_strong_identity_key/g) || []).length >= 2);
  t('la validation de rejeu inclut supersedes_claim_id (une revendication REASSIGN/AMEND différente n\'est jamais acceptée comme rejeu)',
    (fnSrc.match(/v_existing\.supersedes_claim_id IS DISTINCT FROM p_supersedes_claim_id/g) || []).length >= 2);

  // ---------------------------------------------------------------------
  // 9. Prédécesseur de supersession : existence, même cluster, fraîcheur
  //    explicite, monotonie temporelle.
  // ---------------------------------------------------------------------
  t('charge le prédécesseur uniquement si p_supersedes_claim_id IS NOT NULL',
    /IF p_supersedes_claim_id IS NOT NULL THEN/.test(fnSrc));
  t('rejette un prédécesseur introuvable (NOT FOUND -> RAISE EXCEPTION)',
    /WHERE c\.identity_claim_id = p_supersedes_claim_id;[\s\S]{0,80}IF NOT FOUND THEN[\s\S]{0,80}RAISE EXCEPTION/.test(fnSrc));
  t('rejette un prédécesseur dont cluster_id diffère',
    /v_predecessor\.cluster_id IS DISTINCT FROM p_cluster_id THEN/.test(fnSrc));
  t('détecte explicitement un successeur déjà existant (prédécesseur périmé) via une lecture dédiée, pas seulement via la contrainte UNIQUE',
    /SELECT EXISTS \(\s*\n\s*SELECT 1 FROM public\.event_cluster_identity_claims c\s*\n\s*WHERE c\.supersedes_claim_id = p_supersedes_claim_id\s*\n\s*\) INTO v_predecessor_successor_exists;/.test(fnSrc)
    && /IF v_predecessor_successor_exists THEN[\s\S]{0,80}RAISE EXCEPTION/.test(fnSrc));
  t('le commentaire documente explicitement que la contrainte UNIQUE n\'est pas le mécanisme de contrôle de flux normal',
    /d[ée]pendance exclusive[\s\S]{0,20}uq_identity_claims_supersedes/.test(source));
  t('monotonie temporelle : rejette p_knowledge_cutoff < prédécesseur.knowledge_cutoff',
    /IF p_knowledge_cutoff < v_predecessor\.knowledge_cutoff THEN\s*\n\s*RAISE EXCEPTION/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 10. Collision de clé active : sémantique par graphe (aucun
  //     successeur), >1 = corruption, cas A/B/C.
  // ---------------------------------------------------------------------
  t('définit une revendication ACTIVE via NOT EXISTS (aucun successeur) — jamais asserted_at seul',
    /WHERE c\.strong_identity_key = v_new_strong_identity_key\s*\n\s*AND NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.event_cluster_identity_claims successor\s*\n\s*WHERE successor\.supersedes_claim_id = c\.identity_claim_id\s*\n\s*\)/.test(fnSrc));
  t('ne substitue jamais asserted_at à la détection de currentness par graphe',
    !/ORDER BY\s+asserted_at/i.test(fnSrc));
  t('>1 revendication ACTIVE sur la même clé -> erreur d\'invariant/corruption explicite',
    /IF v_active_claim_count > 1 THEN\s*\n\s*RAISE EXCEPTION/.test(fnSrc));
  t('Cas A : même prédécesseur explicite + même cluster + même clé -> AUTORISÉ (pas de RAISE)',
    /IF v_active_claim\.identity_claim_id = p_supersedes_claim_id\s*\n\s*AND v_active_claim\.cluster_id = p_cluster_id\s*\n\s*AND v_old_strong_identity_key IS NOT DISTINCT FROM v_new_strong_identity_key\s*\n\s*THEN[\s\S]{0,120}NULL;/.test(fnSrc));
  t('Cas B : même cluster, pas le prédécesseur -> REJET doublon actif',
    /ELSIF v_active_claim\.cluster_id = p_cluster_id THEN\s*\n\s*RAISE EXCEPTION/.test(fnSrc));
  t('Cas C : cluster différent -> REJET collision inter-cluster (message le mentionne explicitement)',
    /ELSE\s*\n\s*RAISE EXCEPTION[\s\S]{0,300}INTER-CLUSTER/.test(fnSrc));
  t('aucune fusion/déplacement/mutation automatique de cluster (aucun UPDATE sur event_clusters, aucune référence MERGE)',
    !/UPDATE\s+public\.event_clusters/i.test(fnSrc) && !/fn_event_(merge|split)/i.test(liveSource));

  // ---------------------------------------------------------------------
  // 11. Insertion : append-only, alias explicite + RETURNING qualifié,
  //     comparaison clé calculée vs clé matérialisée.
  // ---------------------------------------------------------------------
  t('l\'INSERT porte un alias de cible explicite (AS c)',
    /INSERT INTO public\.event_cluster_identity_claims AS c \(/.test(fnSrc));
  t('le RETURNING référence l\'alias qualifié (c.identity_claim_id, c.strong_identity_key)',
    /RETURNING c\.identity_claim_id, c\.strong_identity_key INTO v_identity_claim_id, v_returned_strong_identity_key;/.test(fnSrc));
  t('compare la clé GENERATED matérialisée (v_returned_strong_identity_key) à la clé calculée (v_new_strong_identity_key), lève une erreur d\'invariant en cas de divergence',
    /IF v_returned_strong_identity_key IS DISTINCT FROM v_new_strong_identity_key THEN\s*\n\s*RAISE EXCEPTION/.test(fnSrc));
  t('un seul RETURNING existe dans toute la fonction', (fnSrc.match(/RETURNING/g) || []).length === 1);
  t('aucun UPDATE contre une table d\'événement OPS-023', !/UPDATE\s+public\.event_/i.test(fnSrc));
  t('aucun DELETE contre une table d\'événement OPS-023', !/DELETE\s+FROM\s+public\.event_/i.test(fnSrc));

  // ---------------------------------------------------------------------
  // 12. Récupération scopée sur violation d'unicité.
  // ---------------------------------------------------------------------
  t('récupération EXCEPTION WHEN unique_violation présente',
    /EXCEPTION WHEN unique_violation THEN/.test(fnSrc));
  t('la récupération ne catch QUE uq_identity_claims_idempotency_fingerprint (GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME), toute autre violation est relevée (RAISE)',
    /GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;\s*\n\s*IF v_constraint_name IS DISTINCT FROM 'uq_identity_claims_idempotency_fingerprint' THEN\s*\n\s*RAISE;/.test(fnSrc));
  t('après récupération, revalide la clé d\'identité générée avant de retourner replayed=true',
    (() => {
      const exceptionIdx = fnSrc.indexOf('EXCEPTION WHEN unique_violation THEN');
      if (exceptionIdx === -1) return false;
      const tail = fnSrc.slice(exceptionIdx);
      return /v_existing\.strong_identity_key IS DISTINCT FROM v_new_strong_identity_key/.test(tail)
        && /true;/.test(tail);
    })());

  // ---------------------------------------------------------------------
  // 13. Qualification de schéma.
  // ---------------------------------------------------------------------
  const RELATION_TABLES = ['event_clusters', 'event_cluster_identity_claims'];
  for (const tbl of RELATION_TABLES) {
    const unqualified = new RegExp(`(?<!public\\.)\\b${tbl}\\b`);
    t(`toute référence à ${tbl} est qualifiée public.${tbl}`, !unqualified.test(fnSrc));
  }
  t('fn_event_lock_cluster est appelée qualifiée public.',
    /public\.fn_event_lock_cluster\(/.test(fnSrc));
  t('extensions.digest est qualifiée', /extensions\.digest\(/.test(fnSrc));
  t('pg_advisory_xact_lock/hashtext/transaction_timestamp sont qualifiées pg_catalog.',
    /pg_catalog\.pg_advisory_xact_lock\(/.test(fnSrc)
    && /pg_catalog\.hashtext\(/.test(fnSrc)
    && /pg_catalog\.transaction_timestamp\(\)/.test(fnSrc));
}

// ---------------------------------------------------------------------
// 14. Sécurité : EXECUTE révoqué/accordé, table grants/RLS inchangés.
// ---------------------------------------------------------------------
t('REVOKE ALL sur fn_event_assert_identity_claim de PUBLIC, anon, authenticated',
  /REVOKE ALL ON FUNCTION public\.fn_event_assert_identity_claim\([\s\S]*?\) FROM PUBLIC, anon, authenticated;/.test(liveSource));
t('GRANT EXECUTE sur fn_event_assert_identity_claim à service_role uniquement',
  /GRANT EXECUTE ON FUNCTION public\.fn_event_assert_identity_claim\([\s\S]*?\) TO service_role;/.test(liveSource));
t('aucun GRANT à anon/authenticated/PUBLIC', !/GRANT[^;]*TO\s+(anon|authenticated|PUBLIC)\b/i.test(liveSource));
t('aucun GRANT/REVOKE sur une TABLE (seulement sur des fonctions)',
  !/(?:GRANT|REVOKE)[^;]*\bON\s+(?:TABLE\s+)?event_(?!.*FUNCTION)[a-z_]+\s+(?:TO|FROM)/i.test(liveSource));
t('aucune policy RLS créée/modifiée', !/CREATE POLICY|ALTER TABLE[^;]*ROW LEVEL SECURITY/i.test(liveSource));
t('aucun ALTER TABLE', !/ALTER TABLE/i.test(liveSource));

// ---------------------------------------------------------------------
// 15. Hors périmètre : aucune fonctionnalité hors périmètre.
// ---------------------------------------------------------------------
t('aucune référence à worker.ts/wrangler/cron dans la migration', !/wrangler|cron|worker\.ts/i.test(liveSource));
t('aucune référence au Comité/Anthropic/notification dans la migration',
  !/anthropic|committee|notifyAiEngine|ai_events/i.test(liveSource));
t('aucune référence à news_events (pipeline legacy) dans la migration', !/news_events/i.test(liveSource));
t('aucune référence à une future RPC de merge/split/version/relation-edge/membership',
  !/fn_event_merge|fn_event_split|fn_event_create_event_version|fn_event_create_cluster_relation|fn_event_reassign|fn_event_assign_observation|fn_event_supersede_membership/i.test(liveSource));
t('aucun champ analytique EVENT IMPACT introduit (direction/magnitude/pricing/horizon)',
  !/\b(direction|magnitude|pricing_state|horizon)\b/i.test(liveSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
