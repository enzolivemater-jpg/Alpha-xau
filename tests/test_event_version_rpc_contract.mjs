// Contrat statique de la RPC atomique EVENT VERSION OPS-023 (PR3,
// migration 0020 : fn_event_create_event_version). Analyse le texte SQL
// de la migration : aucune connexion PostgreSQL requise, s'exécute en CI
// normale. Ne prouve PAS le comportement transactionnel réel
// (verrouillage advisory effectif, concurrence réelle, sémantique de
// rollback réelle) — une vérification live contre Supabase (rollback/
// probes de non-pollution) est effectuée indépendamment, après fusion.
// Ce fichier prouve uniquement que le TEXTE de la migration respecte le
// contrat gelé.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, '0020_event_version_atomic_rpc.sql');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('migration 0020 existe', existsSync(MIGRATION_PATH));

const source = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

// ---------------------------------------------------------------------
// 0. Immutabilité des migrations 0012-0019 (déjà appliquées à Supabase
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
  '0019_event_cluster_relation_rpc.sql':
    '43970a5154939cb13b7a7f2a2f2dc2ae8b00ea329d1bdadf064e305acf7470e2',
};

for (const [fileName, expectedSha] of Object.entries(PRIOR_MIGRATIONS_EXPECTED_SHA256)) {
  const filePath = path.join(MIGRATIONS_DIR, fileName);
  const priorSource = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const actualSha = priorSource.length > 0 ? createHash('sha256').update(priorSource).digest('hex') : '';
  t(`migration ${fileName} reste inchangée (empreinte SHA-256 identique)`,
    actualSha === expectedSha, `attendu ${expectedSha}, trouvé ${actualSha}`);
}

t('migration 0020 ne référence le nom de fichier d\'aucune migration antérieure',
  !/0012_event_cluster_version_foundation|0013_event_function_search_path_hardening|0014_event_membership_atomic_rpcs|0015_event_membership_returning_ambiguity_fix|0016_event_membership_supersession_rpc|0017_event_membership_reassign_rpc|0018_event_identity_claim_rpc|0019_event_cluster_relation_rpc/.test(source));

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
t('migration 0020 est transactionnelle (BEGIN ... COMMIT)',
  /^\s*BEGIN;/m.test(liveSource) && /COMMIT;\s*$/m.test(liveSource.trimEnd()));

const createFunctionCount = (liveSource.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
t('exactement UNE nouvelle fonction créée', createFunctionCount === 1, `${createFunctionCount} trouvées`);
t('cette fonction est public.fn_event_create_event_version',
  /CREATE OR REPLACE FUNCTION public\.fn_event_create_event_version\(/.test(liveSource));
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

const fnSrc = extractFunctionSource(liveSource, 'fn_event_create_event_version');
t('corps de fn_event_create_event_version extrait pour analyse', fnSrc !== null);

// ---------------------------------------------------------------------
// 2. Signature, sécurité
// ---------------------------------------------------------------------
if (fnSrc !== null) {
  t('SECURITY INVOKER explicite', /SECURITY INVOKER/.test(fnSrc));
  t('SECURITY DEFINER absent', !/SECURITY DEFINER/.test(fnSrc));
  t('SET search_path = \'\' présent', /SET search_path = ''/.test(fnSrc));

  t('RETURNS TABLE(event_version_id, version_number, transition_type, state_fingerprint, source_independence_state, evidence_count, outcome, replayed)',
    /RETURNS TABLE \(\s*event_version_id\s+UUID,\s*version_number\s+INTEGER,\s*transition_type\s+TEXT,\s*state_fingerprint\s+TEXT,\s*source_independence_state\s+TEXT,\s*evidence_count\s+INTEGER,\s*outcome\s+TEXT,\s*replayed\s+BOOLEAN/.test(liveSource));

  const REQUIRED_PARAMS = [
    ['p_cluster_id', 'UUID'], ['p_transition_type', 'TEXT'], ['p_knowledge_cutoff', 'TIMESTAMPTZ'],
    ['p_effective_time', 'TIMESTAMPTZ'], ['p_effective_time_precision', 'TEXT'],
    ['p_canonical_event_state_schema_version', 'SMALLINT'], ['p_canonical_event_state', 'JSONB'],
    ['p_official_confirmation_state', 'TEXT'], ['p_source_independence_state', 'TEXT'],
    ['p_algorithm_version', 'TEXT'], ['p_decision_actor', 'TEXT'], ['p_idempotency_fingerprint', 'TEXT'],
  ];
  const signatureMatch = /CREATE OR REPLACE FUNCTION public\.fn_event_create_event_version\(([\s\S]*?)\)\s*\nRETURNS TABLE/.exec(liveSource);
  const signature = signatureMatch ? signatureMatch[1] : '';
  t('signature extraite', signature.length > 0);

  for (const [param, type] of REQUIRED_PARAMS) {
    const re = new RegExp(`${param}\\s+${type}(?!\\s+DEFAULT)`);
    t(`paramètre obligatoire ${param} présent, sans DEFAULT`, re.test(signature));
  }
  t('paramètre optionnel p_supersedes_version_id présent avec DEFAULT NULL',
    /p_supersedes_version_id\s+UUID\s+DEFAULT NULL/.test(signature));
  const optionalIdx = signature.search(/p_supersedes_version_id\s+UUID\s+DEFAULT NULL/);
  t('aucun paramètre obligatoire déclaré après le paramètre optionnel (ordre PostgreSQL valide)',
    optionalIdx > -1 && REQUIRED_PARAMS.every(([param]) => signature.indexOf(param) < optionalIdx));

  // ---------------------------------------------------------------------
  // 3. Validation scalaire de base + intégrité temporelle.
  // ---------------------------------------------------------------------
  t('rejette p_cluster_id NULL', /IF p_cluster_id IS NULL THEN/.test(fnSrc));
  t('n\'accepte que NOVELTY/CONFIRMATION/CORRECTION/REVERSAL',
    /IF p_transition_type IS NULL OR p_transition_type NOT IN \('NOVELTY', 'CONFIRMATION', 'CORRECTION', 'REVERSAL'\) THEN/.test(fnSrc));
  t('rejette p_knowledge_cutoff NULL', /IF p_knowledge_cutoff IS NULL THEN/.test(fnSrc));
  t('rejette p_knowledge_cutoff dans le futur (> transaction_timestamp())',
    /IF p_knowledge_cutoff > pg_catalog\.transaction_timestamp\(\) THEN/.test(fnSrc));
  t('cohérence effective_time/precision : NULL exige NULL',
    /IF p_effective_time IS NULL AND p_effective_time_precision IS NOT NULL THEN/.test(fnSrc));
  t('cohérence effective_time/precision : NOT NULL exige non-NULL non-vide',
    /IF p_effective_time IS NOT NULL AND \(p_effective_time_precision IS NULL OR length\(btrim\(p_effective_time_precision\)\) = 0\) THEN/.test(fnSrc));
  t('n\'introduit aucun vocabulaire figé pour effective_time_precision (aucun NOT IN sur cette colonne)',
    !/p_effective_time_precision NOT IN/.test(fnSrc));
  t('rejette canonical_event_state_schema_version NULL et <= 0',
    /IF p_canonical_event_state_schema_version IS NULL THEN/.test(fnSrc)
    && /IF p_canonical_event_state_schema_version <= 0 THEN/.test(fnSrc));
  t('rejette p_canonical_event_state NULL', /IF p_canonical_event_state IS NULL THEN/.test(fnSrc));
  t('rejette p_canonical_event_state qui n\'est pas un objet JSON',
    /IF jsonb_typeof\(p_canonical_event_state\) <> 'object' THEN/.test(fnSrc));
  t('rejette p_canonical_event_state objet JSON vide',
    /IF p_canonical_event_state = '\{\}'::jsonb THEN/.test(fnSrc));
  t('valide p_official_confirmation_state contre le vocabulaire gelé',
    /p_official_confirmation_state NOT IN \('UNCONFIRMED', 'SECONDARY_CONFIRMED', 'OFFICIALLY_CONFIRMED', 'OFFICIALLY_CORRECTED', 'OFFICIALLY_REVERSED'\)/.test(fnSrc));
  t('valide p_source_independence_state contre le vocabulaire gelé',
    /p_source_independence_state NOT IN \('UNKNOWN', 'SINGLE_EDITORIAL_ORIGIN', 'SYNDICATED_ONLY', 'INDEPENDENTLY_CORROBORATED'\)/.test(fnSrc));
  t('rejette p_algorithm_version/p_decision_actor/p_idempotency_fingerprint NULL/vide',
    /p_algorithm_version IS NULL OR length\(btrim\(p_algorithm_version\)\) = 0/.test(fnSrc)
    && /p_decision_actor IS NULL OR length\(btrim\(p_decision_actor\)\) = 0/.test(fnSrc)
    && /p_idempotency_fingerprint IS NULL OR length\(btrim\(p_idempotency_fingerprint\)\) = 0/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 4. Aucune règle provider/source codée en dur ; aucune heuristique
  //    d'indépendance éditoriale ; aucune inférence de REVERSAL.
  // ---------------------------------------------------------------------
  t('aucune règle provider codée en dur (federalreserve/ecb/us_treasury/ofac)',
    !/federalreserve|'ecb'|us_treasury|'ofac'/i.test(liveSource));
  t('aucune référence à news_articles.provider/source_domain pour inférer official_confirmation_state',
    !/a\.provider|a\.source_domain|news_articles\.provider|news_articles\.source_domain/i.test(fnSrc));
  t('n\'infère jamais REVERSAL automatiquement (aucune affectation de transition_type := ou p_transition_type := \'REVERSAL\')',
    !/transition_type\s*:=\s*'REVERSAL'/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 5. state_fingerprint : calculé dans la RPC, formule EXACTE,
  //    représentation epoch-microsecondes, SHA-256, exclusions.
  // ---------------------------------------------------------------------
  t('aucun paramètre p_state_fingerprint n\'existe dans la signature (calculé, jamais accepté)',
    !/p_state_fingerprint/.test(signature));
  t('v_state_fingerprint_payload contient EXACTEMENT canonical_event_state/effective_time_epoch_us/official_confirmation_state/source_independence_state',
    /v_state_fingerprint_payload := jsonb_build_object\(\s*\n\s*'canonical_event_state', p_canonical_event_state,\s*\n\s*'effective_time_epoch_us',\s*\n\s*CASE WHEN p_effective_time IS NULL THEN NULL\s*\n\s*ELSE ROUND\(EXTRACT\(EPOCH FROM p_effective_time\) \* 1000000\)::BIGINT\s*\n\s*END,\s*\n\s*'official_confirmation_state', p_official_confirmation_state,\s*\n\s*'source_independence_state', p_source_independence_state\s*\n\s*\);/.test(fnSrc));
  t('effective_time représenté en microsecondes-epoch UTC (EXTRACT EPOCH), jamais un texte de timestamp de session',
    /EXTRACT\(EPOCH FROM p_effective_time\) \* 1000000/.test(fnSrc) && !/p_effective_time::text/.test(fnSrc));
  t('exclut explicitement transition_type/supersedes_version_id/version_number/knowledge_cutoff/algorithm_version/decision_actor/created_at/schema_version/effective_time_precision du payload d\'empreinte',
    (() => {
      const payloadMatch = /v_state_fingerprint_payload := jsonb_build_object\(([\s\S]*?)\);/.exec(fnSrc);
      const payload = payloadMatch ? payloadMatch[1] : '__NOT_FOUND__';
      const excluded = [
        'p_transition_type', 'p_supersedes_version_id', 'version_number', 'p_knowledge_cutoff',
        'p_algorithm_version', 'p_decision_actor', 'created_at', 'schema_version', 'effective_time_precision',
      ];
      return payload !== '__NOT_FOUND__' && excluded.every((term) => !payload.includes(term));
    })());
  t('utilise extensions.digest(..., \'sha256\') pour calculer l\'empreinte',
    /extensions\.digest\(v_state_fingerprint_payload::text, 'sha256'\)/.test(fnSrc));
  t('aucune contrainte d\'unicité globale n\'est imposée par la RPC sur state_fingerprint (aucun index/contrainte créé, aucune vérification NOT EXISTS sur state_fingerprint seul)',
    !/CREATE (?:UNIQUE )?INDEX.*state_fingerprint/i.test(liveSource)
    && !/NOT EXISTS \(\s*\n?\s*SELECT 1 FROM public\.event_versions[\s\S]{0,80}state_fingerprint = v_candidate_state_fingerprint/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 6. Instantané de preuves : dérivé, sémantique AS-OF, ASSIGN/AMEND
  //    uniquement, intégrité temporelle, non-vide.
  // ---------------------------------------------------------------------
  t('aucun paramètre d\'ID de décision de preuve n\'existe dans la signature (dérivé, jamais fourni par l\'appelant)',
    !/p_evidence_decision_ids|p_evidence|p_decision_ids/i.test(signature));
  const evidenceDerivationCount = (fnSrc.match(/FROM public\.event_observation_memberships m\s*\n\s*WHERE m\.cluster_id = p_cluster_id\s*\n\s*AND m\.decision_type IN \('ASSIGN', 'AMEND'\)\s*\n\s*AND m\.assigned_at <= p_knowledge_cutoff\s*\n\s*AND NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.event_observation_memberships successor\s*\n\s*WHERE successor\.supersedes_decision_id = m\.decision_id\s*\n\s*AND successor\.assigned_at <= p_knowledge_cutoff\s*\n\s*\)/g) || []).length;
  t('dérive l\'instantané de preuves via sémantique AS-OF par graphe (ASSIGN/AMEND, assigned_at <= cutoff, aucun successeur <= cutoff) — au moins 2 occurrences (précheck + recalcul verrouillé)',
    evidenceDerivationCount >= 2, `trouvé ${evidenceDerivationCount}`);
  t('exclut RETRACT de l\'instantané de preuves (decision_type IN (\'ASSIGN\', \'AMEND\') uniquement, jamais RETRACT)',
    !/decision_type IN \('ASSIGN', 'AMEND', 'RETRACT'\)/.test(fnSrc));
  t('valide l\'intégrité temporelle via GREATEST(observed_at, ingested_at, assigned_at) <= cutoff',
    /GREATEST\(a\.observed_at, a\.ingested_at, m\.assigned_at\) > p_knowledge_cutoff/.test(fnSrc));
  t('ne référence jamais published_at/published_date pour l\'intégrité temporelle',
    !/published_at|published_date/i.test(fnSrc));
  t('exige au moins une preuve active (instantané non vide)',
    /IF v_evidence_decision_ids IS NULL OR cardinality\(v_evidence_decision_ids\) = 0 THEN/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 7. Idempotence : précheck avant verrou, recheck après verrou +
  //    recalcul, comparaison de l'ensemble EXACT de preuves stockées,
  //    evidence_role NULL exigé.
  // ---------------------------------------------------------------------
  const idempotencyWhereIndices = [];
  {
    let searchFrom = 0;
    for (;;) {
      const idx = fnSrc.indexOf('WHERE ev.idempotency_fingerprint = p_idempotency_fingerprint', searchFrom);
      if (idx === -1) break;
      idempotencyWhereIndices.push(idx);
      searchFrom = idx + 1;
    }
  }
  t('exactement 3 lookups par idempotency_fingerprint (précheck, recheck, récupération)',
    idempotencyWhereIndices.length === 3, `trouvé ${idempotencyWhereIndices.length}`);
  const clusterLockIdx = fnSrc.indexOf('PERFORM public.fn_event_lock_cluster(p_cluster_id);');
  t('précheck d\'idempotence présent AVANT le verrou de cluster',
    idempotencyWhereIndices.length > 0 && clusterLockIdx > -1 && idempotencyWhereIndices[0] < clusterLockIdx);
  t('la validation de rejeu compare l\'ensemble EXACT de decision_id stockés (v_existing_evidence_ids IS DISTINCT FROM v_evidence_decision_ids), au moins 3 fois',
    (fnSrc.match(/v_existing_evidence_ids IS DISTINCT FROM v_evidence_decision_ids/g) || []).length >= 3);
  t('exige que TOUTES les evidence_role stockées soient NULL pour un rejeu valide, au moins 3 fois',
    (fnSrc.match(/AND vev\.evidence_role IS NOT NULL/g) || []).length >= 3
    && (fnSrc.match(/OR v_existing_evidence_role_violation/g) || []).length >= 3);
  t('la validation de rejeu compare state_fingerprint calculé (v_candidate_state_fingerprint), au moins 3 fois',
    (fnSrc.match(/v_existing\.state_fingerprint IS DISTINCT FROM v_candidate_state_fingerprint/g) || []).length >= 3);
  t('la validation de rejeu compare cluster_id/transition_type/knowledge_cutoff/effective_time/effective_time_precision/schema_version/canonical_event_state/confirmation/independence/supersedes/algorithm_version/decision_actor, au moins 3 fois chacun',
    ['v_existing.cluster_id IS DISTINCT FROM p_cluster_id',
     'v_existing.transition_type IS DISTINCT FROM p_transition_type',
     'v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff',
     'v_existing.effective_time IS DISTINCT FROM p_effective_time',
     'v_existing.effective_time_precision IS DISTINCT FROM p_effective_time_precision',
     'v_existing.canonical_event_state_schema_version IS DISTINCT FROM p_canonical_event_state_schema_version',
     'v_existing.canonical_event_state IS DISTINCT FROM p_canonical_event_state',
     'v_existing.official_confirmation_state IS DISTINCT FROM p_official_confirmation_state',
     'v_existing.source_independence_state IS DISTINCT FROM p_source_independence_state',
     'v_existing.supersedes_version_id IS DISTINCT FROM p_supersedes_version_id',
     'v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version',
     'v_existing.decision_actor IS DISTINCT FROM p_decision_actor'].every((snippet) => fnSrc.split(snippet).length - 1 >= 3));

  // ---------------------------------------------------------------------
  // 8. Verrou de cluster : primitif partagé, existence, recalcul
  //    VERROUILLÉ de l'instantané, re-vérification post-verrous AVANT
  //    vivacité/prédécesseur/matérialité/INSERT.
  // ---------------------------------------------------------------------
  t('utilise le primitif de verrou partagé fn_event_lock_cluster',
    clusterLockIdx > -1);
  t('vérifie l\'existence du cluster après le verrou',
    /IF NOT EXISTS \(SELECT 1 FROM public\.event_clusters WHERE id = p_cluster_id\) THEN/.test(fnSrc));
  t('recalcule l\'instantané de preuves SOUS VERROU (pas de réutilisation d\'un instantané non verrouillé pour la mutation)',
    idempotencyWhereIndices.length >= 2
    && (() => {
      const secondEvidenceDerivationIdx = fnSrc.indexOf(
        "FROM public.event_observation_memberships m\n    WHERE m.cluster_id = p_cluster_id\n      AND m.decision_type IN ('ASSIGN', 'AMEND')\n      AND m.assigned_at <= p_knowledge_cutoff",
        clusterLockIdx,
      );
      return secondEvidenceDerivationIdx > clusterLockIdx && secondEvidenceDerivationIdx < idempotencyWhereIndices[1];
    })());

  const REPLAY_TRUE_RETURN_MARKER = "'REPLAYED'::TEXT, true;";
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
  t('exactement 3 retours REPLAYED trouvés (précheck, recheck post-verrous, récupération unique_violation)',
    replayTrueReturnIndices.length === 3, `trouvé ${replayTrueReturnIndices.length}`);
  const postLockRecheckReturnIdx = replayTrueReturnIndices.length >= 2 ? replayTrueReturnIndices[1] : -1;
  const clusterRetiredCheckIdx = fnSrc.indexOf('IF v_cluster_retired THEN');
  const stalePredecessorCheckIdx = fnSrc.indexOf('IF p_supersedes_version_id IS DISTINCT FROM v_tip.id THEN');
  const materialityCheckIdx = fnSrc.indexOf('IF NOT v_is_material THEN');
  const insertVersionIdx = fnSrc.indexOf('INSERT INTO public.event_versions AS v (');
  t('INVARIANT CRITIQUE : la RE-vérification d\'idempotence post-verrous précède le rejet de vivacité de cluster',
    postLockRecheckReturnIdx > -1 && clusterRetiredCheckIdx > -1 && postLockRecheckReturnIdx < clusterRetiredCheckIdx);
  t('INVARIANT CRITIQUE : la RE-vérification d\'idempotence post-verrous précède le rejet de prédécesseur périmé',
    postLockRecheckReturnIdx > -1 && stalePredecessorCheckIdx > -1 && postLockRecheckReturnIdx < stalePredecessorCheckIdx);
  t('INVARIANT CRITIQUE : la RE-vérification d\'idempotence post-verrous précède la décision de matérialité',
    postLockRecheckReturnIdx > -1 && materialityCheckIdx > -1 && postLockRecheckReturnIdx < materialityCheckIdx);
  t('INVARIANT CRITIQUE : la RE-vérification d\'idempotence post-verrous précède l\'INSERT',
    postLockRecheckReturnIdx > -1 && insertVersionIdx > -1 && postLockRecheckReturnIdx < insertVersionIdx);

  // ---------------------------------------------------------------------
  // 9. Vivacité de cluster EN DATE du cutoff (jamais l'état actuel).
  // ---------------------------------------------------------------------
  t('la vivacité de cluster utilise decided_at <= p_knowledge_cutoff (jamais l\'état actuel du graphe)',
    /o\.decided_at <= p_knowledge_cutoff/.test(fnSrc));
  t('la sémantique active tient compte de la supersession en date du cutoff (successeur avec decided_at <= cutoff)',
    /WHERE successor\.supersedes_operation_id = o\.operation_id\s*\n\s*AND successor\.decided_at <= p_knowledge_cutoff/.test(fnSrc));
  t('vérifie from_cluster_id = p_cluster_id pour la rétirade de cluster',
    /e\.from_cluster_id = p_cluster_id/.test(fnSrc));
  t('un rejeu/backfill historique avec un cutoff antérieur reste représentable (l\'opération de relation n\'est active que si decided_at <= cutoff, jamais l\'état courant seul)',
    /WHERE e\.from_cluster_id = p_cluster_id\s*\n\s*AND o\.decided_at <= p_knowledge_cutoff/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 10. Chaîne de version : corruption structurelle, première/ultérieure.
  // ---------------------------------------------------------------------
  t('détecte la corruption structurelle (count(*) <> MAX(version_number))',
    /IF v_version_count <> v_max_version_number THEN/.test(fnSrc));
  t('PREMIÈRE version : p_supersedes_version_id doit être NULL',
    /IF v_version_count = 0 THEN[\s\S]{0,200}IF p_supersedes_version_id IS NOT NULL THEN/.test(fnSrc));
  t('PREMIÈRE version : p_transition_type doit être NOVELTY',
    /IF p_transition_type <> 'NOVELTY' THEN/.test(fnSrc));
  t('PREMIÈRE version : version_number = 1',
    /v_new_version_number := 1;/.test(fnSrc));
  t('VERSION ULTÉRIEURE : rejette NOVELTY',
    /IF p_transition_type = 'NOVELTY' THEN\s*\n\s*RAISE EXCEPTION/.test(fnSrc));
  t('VERSION ULTÉRIEURE : le prédécesseur doit être le tip courant (sinon prédécesseur périmé)',
    /IF p_supersedes_version_id IS DISTINCT FROM v_tip\.id THEN\s*\n\s*RAISE EXCEPTION/.test(fnSrc));
  t('VERSION ULTÉRIEURE : détecte explicitement un successeur déjà existant (event_versions n\'a pas de contrainte UNIQUE sur supersedes_version_id)',
    /IF EXISTS \(SELECT 1 FROM public\.event_versions WHERE supersedes_version_id = p_supersedes_version_id\) THEN/.test(fnSrc)
    && /n'a PAS de contrainte UNIQUE sur[\s\S]{0,20}supersedes_version_id/.test(source));
  t('VERSION ULTÉRIEURE : monotonie temporelle (rejette knowledge_cutoff < prédécesseur)',
    /IF p_knowledge_cutoff < v_tip\.knowledge_cutoff THEN/.test(fnSrc));
  t('VERSION ULTÉRIEURE : version_number = prédécesseur + 1',
    /v_new_version_number := v_max_version_number \+ 1;/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 11. Garde-fou CONFIRMATION.
  // ---------------------------------------------------------------------
  t('CONFIRMATION ne peut pas modifier canonical_event_state/effective_time/effective_time_precision',
    /IF p_transition_type = 'CONFIRMATION' THEN\s*\n\s*IF v_tip\.canonical_event_state IS DISTINCT FROM p_canonical_event_state\s*\n\s*OR v_tip\.effective_time IS DISTINCT FROM p_effective_time\s*\n\s*OR v_tip\.effective_time_precision IS DISTINCT FROM p_effective_time_precision\s*\n\s*THEN/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 12. Matérialité.
  // ---------------------------------------------------------------------
  t('compare l\'empreinte candidate au state_fingerprint du prédécesseur pour la matérialité',
    /v_is_material := \(v_candidate_state_fingerprint IS DISTINCT FROM v_tip\.state_fingerprint\);/.test(fnSrc));
  t('première version toujours matérielle',
    /v_is_material := true;/.test(fnSrc));
  t('NO_MATERIAL_CHANGE ne produit AUCUN INSERT (retour AVANT le bloc INSERT)',
    materialityCheckIdx > -1 && insertVersionIdx > -1 && materialityCheckIdx < insertVersionIdx
    && /IF NOT v_is_material THEN[\s\S]{0,400}RETURN QUERY SELECT v_tip\.id[\s\S]{0,220}'NO_MATERIAL_CHANGE'::TEXT, false;\s*\n\s*RETURN;\s*\n\s*END IF;/.test(fnSrc));
  t('NO_MATERIAL_CHANGE retourne l\'ID et le version_number du prédécesseur courant (v_tip)',
    /RETURN QUERY SELECT v_tip\.id, v_tip\.version_number, v_tip\.transition_type, v_tip\.state_fingerprint, v_tip\.source_independence_state,/.test(fnSrc));
  t('A -> B -> A reste structurellement possible (aucune contrainte d\'unicité sur state_fingerprint imposée par la RPC)',
    !/UNIQUE.*state_fingerprint/i.test(liveSource));

  // ---------------------------------------------------------------------
  // 13. Insertion atomique : en-tête une fois, instantané complet,
  //     evidence_role NULL, comptage vérifié, alias + RETURNING qualifiés.
  // ---------------------------------------------------------------------
  t('l\'INSERT de l\'en-tête porte un alias de cible explicite (AS v)',
    /INSERT INTO public\.event_versions AS v \(/.test(fnSrc));
  t('le RETURNING référence l\'alias qualifié (v.id)',
    /RETURNING v\.id INTO v_event_version_id;/.test(fnSrc));
  t('un seul en-tête inséré (un seul INSERT INTO ...event_versions)',
    (fnSrc.match(/INSERT INTO public\.event_versions/g) || []).length === 1);
  t('l\'instantané COMPLET de preuves est inséré en bulk (INSERT ... SELECT depuis unnest)',
    /INSERT INTO public\.event_version_evidence \(event_version_id, decision_id, evidence_role\)\s*\n\s*SELECT v_event_version_id, d, NULL\s*\n\s*FROM unnest\(v_evidence_decision_ids\) d/.test(fnSrc));
  t('evidence_role est explicitement NULL à l\'insertion (aucun vocabulaire sémantique inventé)',
    /SELECT v_event_version_id, d, NULL\s*\n\s*FROM unnest\(v_evidence_decision_ids\) d/.test(fnSrc));
  t('vérifie que le nombre de preuves insérées égale l\'instantané dérivé',
    /IF v_inserted_evidence_count <> cardinality\(v_evidence_decision_ids\) THEN\s*\n\s*RAISE EXCEPTION/.test(fnSrc));
  t('l\'en-tête et les preuves vivent dans le MÊME bloc BEGIN\\/EXCEPTION (même portée atomique de fonction)',
    (() => {
      const beginBlockIdx = fnSrc.lastIndexOf('BEGIN', insertVersionIdx);
      const edgeInsertIdx = fnSrc.indexOf('INSERT INTO public.event_version_evidence', insertVersionIdx);
      const exceptionIdx = fnSrc.indexOf('EXCEPTION WHEN unique_violation THEN');
      return beginBlockIdx > -1 && edgeInsertIdx > -1 && exceptionIdx > -1
        && beginBlockIdx < insertVersionIdx && insertVersionIdx < edgeInsertIdx && edgeInsertIdx < exceptionIdx;
    })());
  t('aucun UPDATE contre une table d\'événement OPS-023', !/UPDATE\s+public\.event_/i.test(fnSrc));
  t('aucun DELETE contre une table d\'événement OPS-023', !/DELETE\s+FROM\s+public\.event_/i.test(fnSrc));

  // ---------------------------------------------------------------------
  // 14. Récupération scopée sur violation d'unicité.
  // ---------------------------------------------------------------------
  t('récupération EXCEPTION WHEN unique_violation présente',
    /EXCEPTION WHEN unique_violation THEN/.test(fnSrc));
  t('la récupération ne catch QUE uq_event_versions_idempotency_fingerprint (GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME), toute autre violation est relevée (RAISE)',
    /GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;\s*\n\s*IF v_constraint_name IS DISTINCT FROM 'uq_event_versions_idempotency_fingerprint' THEN\s*\n\s*RAISE;/.test(fnSrc));
  t('uq_event_versions_cluster_number et event_version_evidence_pkey ne sont jamais avalées par la récupération',
    !/v_constraint_name IS DISTINCT FROM 'uq_event_versions_cluster_number'/.test(fnSrc)
    && !/v_constraint_name IS DISTINCT FROM 'event_version_evidence_pkey'/.test(fnSrc)
    && !/v_constraint_name = 'uq_event_versions_cluster_number'/.test(fnSrc)
    && !/v_constraint_name = 'event_version_evidence_pkey'/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 15. Qualification de schéma.
  // ---------------------------------------------------------------------
  const RELATION_TABLES = [
    'event_clusters', 'event_versions', 'event_version_evidence',
    'event_observation_memberships', 'news_articles',
    'event_cluster_relation_operations', 'event_cluster_relation_edges',
  ];
  for (const tbl of RELATION_TABLES) {
    const unqualified = new RegExp(`(?<!public\\.)\\b${tbl}\\b`);
    t(`toute référence à ${tbl} est qualifiée public.${tbl}`, !unqualified.test(fnSrc));
  }
  t('fn_event_lock_cluster est appelée qualifiée public.',
    /public\.fn_event_lock_cluster\(/.test(fnSrc));
  t('extensions.digest est qualifiée', /extensions\.digest\(/.test(fnSrc));
  t('transaction_timestamp est qualifiée pg_catalog.',
    /pg_catalog\.transaction_timestamp\(\)/.test(fnSrc));
}

// ---------------------------------------------------------------------
// 16. Sécurité : EXECUTE révoqué/accordé, table grants/RLS inchangés.
// ---------------------------------------------------------------------
t('REVOKE ALL sur fn_event_create_event_version de PUBLIC, anon, authenticated',
  /REVOKE ALL ON FUNCTION public\.fn_event_create_event_version\([\s\S]*?\) FROM PUBLIC, anon, authenticated;/.test(liveSource));
t('GRANT EXECUTE sur fn_event_create_event_version à service_role uniquement',
  /GRANT EXECUTE ON FUNCTION public\.fn_event_create_event_version\([\s\S]*?\) TO service_role;/.test(liveSource));
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
t('aucune référence à une future RPC de processeur/identité/relation/membership',
  !/fn_event_assign_observation|fn_event_supersede_membership|fn_event_reassign_membership|fn_event_assert_identity_claim|fn_event_create_cluster_relation/i.test(liveSource));
t('aucun champ analytique EVENT IMPACT/Gold introduit (direction/magnitude/pricing/horizon/H1/H5/regime)',
  !/\b(direction|magnitude|pricing_state|horizon|regime)\b/i.test(liveSource) && !/\bH[1-5]\b/.test(liveSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
