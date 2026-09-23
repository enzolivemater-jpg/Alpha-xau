// Contrat BEHAVIORAL (pas seulement statique) du processeur déterministe
// OPS-023 PR4 (backend/event_engine/deterministic_processor.ts). Ce
// fichier transpile le TypeScript source avec `typescript` (déjà présent
// en devDependency, aucune nouvelle dépendance ajoutée), charge le module
// résultant en ESM, et appelle directement les fonctions exportées —
// preuve réelle du comportement, pas seulement une correspondance de
// motif texte. Des garde-fous statiques (imports/tokens interdits)
// complètent, sans jamais remplacer, ces tests comportementaux.
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'deterministic_processor.ts');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('backend/event_engine/deterministic_processor.ts existe', existsSync(SOURCE_PATH));

const source = existsSync(SOURCE_PATH) ? readFileSync(SOURCE_PATH, 'utf8') : '';

// ---------------------------------------------------------------------
// 0. Transpilation + chargement ESM réel — le module est ensuite appelé
//    directement, ses fonctions exécutées pour de vrai.
// ---------------------------------------------------------------------
let mod = null;
let tmpDir = null;
try {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
    },
  }).outputText;

  tmpDir = mkdtempSync(path.join(tmpdir(), 'ops023-event-processor-'));
  const tmpFile = path.join(tmpDir, 'deterministic_processor.mjs');
  writeFileSync(tmpFile, transpiled, 'utf8');
  mod = await import(pathToFileURL(tmpFile).href);
} catch (err) {
  console.error('FAILED TO TRANSPILE/LOAD deterministic_processor.ts:', err);
} finally {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
}

t('le module transpile et se charge sans erreur', mod !== null);
t('OPS023_EVENT_PROCESSOR_VERSION est exporté', typeof mod?.OPS023_EVENT_PROCESSOR_VERSION === 'string' && mod.OPS023_EVENT_PROCESSOR_VERSION.length > 0);
t('planEventProcessing est exporté (fonction)', typeof mod?.planEventProcessing === 'function');
t('resolveSourceIndependence est exporté (fonction)', typeof mod?.resolveSourceIndependence === 'function');

if (mod === null) {
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
}

const { planEventProcessing, resolveSourceIndependence, OPS023_EVENT_PROCESSOR_VERSION } = mod;

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
function makeObservation(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'federal_reserve',
    providerItemId: 'guid-fed-1',
    sourceCode: 'federalreserve',
    sourceDomain: 'federalreserve.gov',
    canonicalUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260901a.htm',
    title: 'Federal Reserve issues FOMC statement',
    summary: 'The Committee decided to maintain the target range.',
    content: null,
    providerCategory: 'monetary_policy_press_release',
    publishedAt: '2026-09-01T18:00:00.000Z',
    publishedDate: null,
    observedAt: '2026-09-01T18:05:00.000Z',
    ingestedAt: '2026-09-01T18:05:03.000Z',
    ingestQualityState: 'VALID',
    ingestQualityReasons: [],
    ...overrides,
  };
}

function planFor(observation, strongIdentity = { kind: 'NONE' }, clusterContext = null) {
  return planEventProcessing({ observation, strongIdentity, clusterContext });
}

function assertProcess(plan, label) {
  t(`${label} : PROCESS`, plan?.kind === 'PROCESS', `kind=${plan?.kind} reason=${plan?.reason}`);
  return plan;
}
function assertAbstain(plan, expectedAbstention, expectedReason, label) {
  t(`${label} : ABSTAIN(${expectedAbstention}/${expectedReason})`,
    plan?.kind === 'ABSTAIN' && plan.abstention === expectedAbstention && plan.reason === expectedReason,
    `got kind=${plan?.kind} abstention=${plan?.abstention} reason=${plan?.reason}`);
}

// ---------------------------------------------------------------------
// 1. Registre de source officielle — tuples EXACTS uniquement.
// ---------------------------------------------------------------------
assertProcess(planFor(makeObservation()), 'FED tuple exact');

// providerCategory=statistical_press_release (not press_communication):
// this section tests exact SOURCE TUPLE matching only, and
// statistical_press_release remains unconditionally eligible regardless
// of URL/title (§8bis event eligibility gate applies only to ECB
// press_communication — see its own dedicated section below).
assertProcess(planFor(makeObservation({
  provider: 'ecb', providerItemId: 'ecb-1', sourceCode: 'ecb', sourceDomain: 'ecb.europa.eu',
  canonicalUrl: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr260901.htm',
  providerCategory: 'statistical_press_release',
})), 'ECB tuple exact');

assertProcess(planFor(makeObservation({
  provider: 'us_treasury', providerItemId: 'treasury-1', sourceCode: 'us_treasury', sourceDomain: 'home.treasury.gov',
  canonicalUrl: 'https://home.treasury.gov/news/press-releases/jy0001',
  providerCategory: 'press_release',
})), 'US Treasury tuple exact');

assertProcess(planFor(makeObservation({
  provider: 'ofac', providerItemId: 'ofac-1', sourceCode: 'ofac', sourceDomain: 'ofac.treasury.gov',
  canonicalUrl: 'https://ofac.treasury.gov/recent-actions/20260901',
  providerCategory: 'Specially Designated Nationals List Update',
})), 'OFAC tuple exact');

assertAbstain(
  planFor(makeObservation({ sourceCode: 'federalreserve', provider: 'ecb', sourceDomain: 'federalreserve.gov' })),
  'SOURCE_CONTRACT_MISMATCH', 'SOURCE_CONTRACT_MISMATCH', 'spoofed federalreserve sourceCode, wrong provider',
);
assertAbstain(
  planFor(makeObservation({ sourceCode: 'federalreserve', provider: 'federal_reserve', sourceDomain: 'evil-mirror.example.com' })),
  'SOURCE_CONTRACT_MISMATCH', 'SOURCE_CONTRACT_MISMATCH', 'spoofed official domain',
);
assertAbstain(
  planFor(makeObservation({ sourceCode: 'gdelt', provider: 'gdelt', sourceDomain: null })),
  'UNSUPPORTED_SOURCE', 'UNSUPPORTED_SOURCE', 'unknown source (gdelt)',
);

// ---------------------------------------------------------------------
// 2. Quality gate.
// ---------------------------------------------------------------------
assertProcess(planFor(makeObservation({ ingestQualityState: 'VALID', ingestQualityReasons: [] })), 'VALID + no reasons');
assertAbstain(
  planFor(makeObservation({ ingestQualityState: 'VALID', ingestQualityReasons: ['publication_timestamp_parse_failed'] })),
  'DATA_QUALITY_INSUFFICIENT', 'QUALITY_GATE_REJECTED', 'VALID + non-empty reasons (contradictory, fail closed)',
);
for (const reason of ['publication_timestamp_parse_failed', 'publication_date_parse_failed', 'publication_precision_unknown']) {
  assertProcess(planFor(makeObservation({ ingestQualityState: 'DEGRADED', ingestQualityReasons: [reason] })), `DEGRADED allowlisted (${reason})`);
}
assertAbstain(
  planFor(makeObservation({ ingestQualityState: 'DEGRADED', ingestQualityReasons: ['some_unknown_reason'] })),
  'DATA_QUALITY_INSUFFICIENT', 'QUALITY_GATE_REJECTED', 'DEGRADED with unknown reason',
);
assertAbstain(
  planFor(makeObservation({ ingestQualityState: 'DEGRADED', ingestQualityReasons: [] })),
  'DATA_QUALITY_INSUFFICIENT', 'QUALITY_GATE_REJECTED', 'DEGRADED + empty reasons (contradictory, fail closed)',
);
assertAbstain(
  planFor(makeObservation({ ingestQualityState: 'UNVERIFIED', ingestQualityReasons: [] })),
  'DATA_QUALITY_INSUFFICIENT', 'QUALITY_GATE_REJECTED', 'UNVERIFIED',
);

// ---------------------------------------------------------------------
// 3. Lineage + résolveur d'indépendance de source.
// ---------------------------------------------------------------------
{
  const plan1 = planFor(makeObservation({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
  const plan2 = planFor(makeObservation({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
  t('lineage officielle déterministe (même autorité -> même editorialOriginKey, jamais un ID d\'article)',
    plan1.lineage.editorialOriginKey === plan2.lineage.editorialOriginKey
    && plan1.lineage.editorialOriginKey === 'official:federal_reserve');
  t('wireLineageKey officielle toujours null', plan1.lineage.wireLineageKey === null);
  t('lineageResolutionMethod = DIRECT_OFFICIAL_SOURCE', plan1.lineage.lineageResolutionMethod === 'DIRECT_OFFICIAL_SOURCE');
  t('lineageResolutionConfidence = 1', plan1.lineage.lineageResolutionConfidence === 1);
}

{
  const single = Array.from({ length: 10 }, () => ({ editorialOriginKey: 'official:federal_reserve', wireLineageKey: null }));
  t('même source officielle répétée 10 fois reste SINGLE_EDITORIAL_ORIGIN (le compte est sans effet)',
    resolveSourceIndependence(single) === 'SINGLE_EDITORIAL_ORIGIN');
}
{
  const syndicated = [
    { editorialOriginKey: 'official:federal_reserve', wireLineageKey: 'wire:reuters:123' },
    { editorialOriginKey: 'official:ecb', wireLineageKey: 'wire:reuters:123' },
  ];
  t('deux origines distinctes partageant le même wireLineageKey non-null -> SYNDICATED_ONLY',
    resolveSourceIndependence(syndicated) === 'SYNDICATED_ONLY');
}
{
  const independent = [
    { editorialOriginKey: 'official:federal_reserve', wireLineageKey: null },
    { editorialOriginKey: 'official:ecb', wireLineageKey: null },
  ];
  t('deux origines distinctes sans lignage de dépêche commun -> INDEPENDENTLY_CORROBORATED',
    resolveSourceIndependence(independent) === 'INDEPENDENTLY_CORROBORATED');
}
{
  const unresolved = [
    { editorialOriginKey: 'official:federal_reserve', wireLineageKey: null },
    { editorialOriginKey: null, wireLineageKey: null },
  ];
  t('un lignage non résolu produit UNKNOWN', resolveSourceIndependence(unresolved) === 'UNKNOWN');
  t('un ensemble vide produit UNKNOWN', resolveSourceIndependence([]) === 'UNKNOWN');
}
{
  const manySameOrigin = Array.from({ length: 50 }, (_, i) => ({
    editorialOriginKey: 'official:federal_reserve', wireLineageKey: i % 2 === 0 ? null : `wire:${i}`,
  }));
  t('le nombre d\'articles seul ne crée jamais d\'indépendance (50 items, 1 origine -> toujours SINGLE_EDITORIAL_ORIGIN)',
    resolveSourceIndependence(manySameOrigin) === 'SINGLE_EDITORIAL_ORIGIN');
}

// ---------------------------------------------------------------------
// 4. Frontière d'identité forte — jamais dérivée des champs d'observation.
// ---------------------------------------------------------------------
{
  const obsA = makeObservation({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', providerItemId: 'SAME-ITEM-ID' });
  const obsB = makeObservation({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', providerItemId: 'SAME-ITEM-ID' });
  const planA = planFor(obsA);
  const planB = planFor(obsB);
  t('providerItemId identique sur deux observations ne crée jamais d\'identité forte partagée (CREATE_NEW_CLUSTER indépendant pour chacune)',
    planA.clusterDisposition === 'CREATE_NEW_CLUSTER' && planB.clusterDisposition === 'CREATE_NEW_CLUSTER'
    && planA.provisionalClusterKey !== planB.provisionalClusterKey);
}
{
  const obsA = makeObservation({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', canonicalUrl: 'https://www.federalreserve.gov/same-url.htm' });
  const obsB = makeObservation({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', canonicalUrl: 'https://www.federalreserve.gov/same-url.htm' });
  const planA = planFor(obsA);
  const planB = planFor(obsB);
  t('canonicalUrl identique ne crée jamais d\'identité forte partagée',
    planA.clusterDisposition === 'CREATE_NEW_CLUSTER' && planB.clusterDisposition === 'CREATE_NEW_CLUSTER'
    && planA.provisionalClusterKey !== planB.provisionalClusterKey);
}
{
  const obsA = makeObservation({ id: '10101010-1010-4010-8010-101010101010', title: 'Identical Title For Both' });
  const obsB = makeObservation({ id: '20202020-2020-4020-8020-202020202020', title: 'Identical Title For Both' });
  const planA = planFor(obsA);
  const planB = planFor(obsB);
  t('titre identique ne crée jamais d\'identité forte partagée',
    planA.clusterDisposition === 'CREATE_NEW_CLUSTER' && planB.clusterDisposition === 'CREATE_NEW_CLUSTER'
    && planA.provisionalClusterKey !== planB.provisionalClusterKey);
}
{
  const plan = planFor(makeObservation(), { kind: 'NONE' });
  t('kind=NONE => strongIdentityClaimProposal null', plan.strongIdentityClaimProposal === null);
}

// -------------------------------------------------------------------
// RÉVIEW-FIX-001-IDENTITY-PROPOSAL : le comportement diffère
// STRICTEMENT entre 0 candidat (le cluster n'existe pas encore -> une
// NOUVELLE proposition d'identity claim a du sens) et exactement 1
// candidat (l'identité curée RÉSOUT DÉJÀ un cluster existant -> la
// revendication active existante est précisément ce qui a produit ce
// candidat unique ; proposer une NOUVELLE assertion ferait rejouer
// fn_event_assert_identity_claim pour la MÊME clé/cluster actifs, que
// PR2C rejette à juste titre comme doublon actif — donc AUCUNE
// proposition n'est émise dans ce cas).
// -------------------------------------------------------------------
{
  // A) 0 candidat : CREATE_NEW_CLUSTER + proposition NON-NULLE, valeurs
  // curées préservées EXACTEMENT.
  const plan = assertProcess(planFor(makeObservation(), {
    kind: 'CURATED_STRONG_IDENTITY',
    authorityNamespace: 'test-authority', identityType: 'test-type', identityValue: 'test-value',
    candidateClusterIds: [],
  }), 'A) identité curée à 0 candidat');
  t('A) identité curée à 0 candidat => CREATE_NEW_CLUSTER, resolvedClusterId=null',
    plan.clusterDisposition === 'CREATE_NEW_CLUSTER' && plan.resolvedClusterId === null);
  t('A) identité curée à 0 candidat => strongIdentityClaimProposal NON-NULLE',
    plan.strongIdentityClaimProposal !== null);
  t('A) la proposition préserve EXACTEMENT authorityNamespace/identityType/identityValue curés',
    plan.strongIdentityClaimProposal?.authorityNamespace === 'test-authority'
    && plan.strongIdentityClaimProposal?.identityType === 'test-type'
    && plan.strongIdentityClaimProposal?.identityValue === 'test-value');
}
{
  // B) exactement 1 candidat : ASSIGN_EXISTING vers exactement ce
  // cluster, ET strongIdentityClaimProposal === null (jamais une
  // nouvelle assertion demandée pour une identité déjà résolue).
  const clusterId = '30303030-3030-4030-8030-303030303030';
  const plan = assertProcess(planFor(
    makeObservation(),
    { kind: 'CURATED_STRONG_IDENTITY', authorityNamespace: 'a', identityType: 't', identityValue: 'v', candidateClusterIds: [clusterId] },
    { clusterId, previousVersion: null, activeEvidenceLineages: [] },
  ), 'B) identité curée à 1 candidat');
  t('B) identité curée à 1 candidat => ASSIGN_EXISTING vers exactement ce cluster',
    plan.clusterDisposition === 'ASSIGN_EXISTING' && plan.resolvedClusterId === clusterId);
  t('B) identité curée à 1 candidat => strongIdentityClaimProposal === null (la revendication active existante a déjà produit ce candidat unique)',
    plan.strongIdentityClaimProposal === null);
}
{
  // C) >1 candidats : ABSTAIN SIGNAL_CONFLICT/IDENTITY_COLLISION, et
  // AUCUNE proposition de claim n'est jamais émise via un plan PROCESS.
  const plan = planFor(makeObservation(), {
    kind: 'CURATED_STRONG_IDENTITY', authorityNamespace: 'a', identityType: 't', identityValue: 'v',
    candidateClusterIds: ['40404040-4040-4040-8040-404040404040', '50505050-5050-4050-8050-505050505050'],
  });
  assertAbstain(plan, 'SIGNAL_CONFLICT', 'IDENTITY_COLLISION', 'C) identité curée à >1 candidats');
  t('C) >1 candidats : aucune proposition de claim n\'est jamais émise via un plan PROCESS (le plan est ABSTAIN, pas PROCESS)',
    plan.kind === 'ABSTAIN' && plan.strongIdentityClaimProposal === undefined);
}
{
  // Aucun candidat n'est jamais choisi par similarité de titre : deux
  // titres identiques (donc "similaires") avec >1 candidats produisent
  // TOUJOURS IDENTITY_COLLISION, jamais un choix silencieux.
  const plan = planFor(
    makeObservation({ title: 'Some Title' }),
    {
      kind: 'CURATED_STRONG_IDENTITY', authorityNamespace: 'a', identityType: 't', identityValue: 'v',
      candidateClusterIds: ['60606060-6060-4060-8060-606060606060', '70707070-7070-4070-8070-707070707070'],
    },
  );
  assertAbstain(plan, 'SIGNAL_CONFLICT', 'IDENTITY_COLLISION', 'aucun candidat choisi par similarité de titre');
}
{
  // Champs curés blancs => rejet explicite, jamais un identity claim
  // silencieusement vide.
  const plan = planFor(makeObservation(), {
    kind: 'CURATED_STRONG_IDENTITY', authorityNamespace: '   ', identityType: 't', identityValue: 'v', candidateClusterIds: [],
  });
  assertAbstain(plan, 'INVALID_INPUT', 'STRONG_IDENTITY_CONTEXT_INVALID', 'champ curé blanc rejeté');
}

// ---------------------------------------------------------------------
// 5. Disposition de cluster — précision d'abord.
// ---------------------------------------------------------------------
{
  const obs = makeObservation({ id: '80808080-8080-4080-8080-808080808080' });
  const plan = assertProcess(planFor(obs), 'clé de cluster provisoire');
  t('provisionalClusterKey dérive UNIQUEMENT de l\'UUID d\'observation persistée',
    plan.provisionalClusterKey === `provisional:${obs.id}`);
  t('aucune opération MERGE/SPLIT automatique dans le plan (aucune clé merge/split)',
    !Object.keys(plan).some((k) => /merge|split/i.test(k)));
}
{
  // Contexte de cluster manquant/mismatché pour ASSIGN_EXISTING.
  const clusterId = '90909090-9090-4090-8090-909090909090';
  const planMissing = planFor(
    makeObservation(),
    { kind: 'CURATED_STRONG_IDENTITY', authorityNamespace: 'a', identityType: 't', identityValue: 'v', candidateClusterIds: [clusterId] },
    null,
  );
  assertAbstain(planMissing, 'INVALID_CLUSTER_CONTEXT', 'INVALID_CLUSTER_CONTEXT', 'contexte de cluster manquant pour ASSIGN_EXISTING');

  const planMismatch = planFor(
    makeObservation(),
    { kind: 'CURATED_STRONG_IDENTITY', authorityNamespace: 'a', identityType: 't', identityValue: 'v', candidateClusterIds: [clusterId] },
    { clusterId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', previousVersion: null, activeEvidenceLineages: [] },
  );
  assertAbstain(planMismatch, 'INVALID_CLUSTER_CONTEXT', 'INVALID_CLUSTER_CONTEXT', 'contexte de cluster mismatché pour ASSIGN_EXISTING');
}
{
  const clusterId = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
  const plan = assertProcess(planFor(
    makeObservation(),
    { kind: 'CURATED_STRONG_IDENTITY', authorityNamespace: 'a', identityType: 't', identityValue: 'v', candidateClusterIds: [clusterId] },
    { clusterId, previousVersion: null, activeEvidenceLineages: [] },
  ), 'clusterCategory/clusterRegion');
  t('clusterRegion = null en PR4 (jamais inféré depuis l\'autorité)', plan.clusterRegion === null);
}

// ---------------------------------------------------------------------
// 6. Event Type v1 — mapping figé, catégories non supportées abstiennent.
// ---------------------------------------------------------------------
const EVENT_TYPE_CASES = [
  { provider: 'federal_reserve', sourceCode: 'federalreserve', sourceDomain: 'federalreserve.gov', category: 'monetary_policy_press_release', expected: 'MONETARY_POLICY_COMMUNICATION' },
  { provider: 'federal_reserve', sourceCode: 'federalreserve', sourceDomain: 'federalreserve.gov', category: 'speech', expected: 'OFFICIAL_SPEECH' },
  // ECB press_communication needs a §8bis-eligible canonicalUrl (a known
  // structurally-eligible path family) — the default fixture canonicalUrl
  // (Federal Reserve's own URL) would otherwise fail hostname
  // verification and ABSTAIN(EVENT_ELIGIBILITY_UNRESOLVED) instead of
  // PROCESS. This mapping test only cares about the event_type mapping
  // itself, not eligibility, so the simplest eligible evidence (a
  // /press/key/ speech path) is used.
  { provider: 'ecb', sourceCode: 'ecb', sourceDomain: 'ecb.europa.eu', category: 'press_communication', expected: 'CENTRAL_BANK_COMMUNICATION',
    canonicalUrl: 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp260901.en.html' },
  { provider: 'ecb', sourceCode: 'ecb', sourceDomain: 'ecb.europa.eu', category: 'statistical_press_release', expected: 'STATISTICAL_RELEASE' },
  { provider: 'us_treasury', sourceCode: 'us_treasury', sourceDomain: 'home.treasury.gov', category: 'press_release', expected: 'OFFICIAL_PRESS_RELEASE' },
  { provider: 'ofac', sourceCode: 'ofac', sourceDomain: 'ofac.treasury.gov', category: 'Some Dynamic OFAC Listing Category', expected: 'SANCTIONS_ACTION' },
];
for (const c of EVENT_TYPE_CASES) {
  const plan = assertProcess(planFor(makeObservation({
    provider: c.provider, sourceCode: c.sourceCode, sourceDomain: c.sourceDomain, providerCategory: c.category,
    ...(c.canonicalUrl ? { canonicalUrl: c.canonicalUrl } : {}),
  })), `mapping ${c.provider}/${c.category}`);
  t(`mapping ${c.provider}/${c.category} -> ${c.expected}`, plan.clusterCategory === c.expected && plan.canonicalEventState.event_type === c.expected);
}
for (const p of [
  { provider: 'federal_reserve', sourceCode: 'federalreserve', sourceDomain: 'federalreserve.gov', category: 'unheard_of_category' },
  { provider: 'ecb', sourceCode: 'ecb', sourceDomain: 'ecb.europa.eu', category: 'unheard_of_category' },
  { provider: 'us_treasury', sourceCode: 'us_treasury', sourceDomain: 'home.treasury.gov', category: 'unheard_of_category' },
]) {
  assertAbstain(
    planFor(makeObservation({ provider: p.provider, sourceCode: p.sourceCode, sourceDomain: p.sourceDomain, providerCategory: p.category })),
    'UNSUPPORTED_OFFICIAL_CATEGORY', 'UNSUPPORTED_OFFICIAL_CATEGORY', `catégorie non supportée ${p.provider}`,
  );
}
assertAbstain(
  planFor(makeObservation({ provider: 'ofac', sourceCode: 'ofac', sourceDomain: 'ofac.treasury.gov', providerCategory: null })),
  'UNSUPPORTED_OFFICIAL_CATEGORY', 'UNSUPPORTED_OFFICIAL_CATEGORY', 'catégorie OFAC NULL',
);
assertAbstain(
  planFor(makeObservation({ provider: 'ofac', sourceCode: 'ofac', sourceDomain: 'ofac.treasury.gov', providerCategory: '   ' })),
  'UNSUPPORTED_OFFICIAL_CATEGORY', 'UNSUPPORTED_OFFICIAL_CATEGORY', 'catégorie OFAC blanche',
);

// ---------------------------------------------------------------------
// 6bis. EVENT ELIGIBILITY PRECISION GATE — ECB broad press_communication
//   only (§8bis in deterministic_processor.ts). Proves the live defect is
//   closed (a generic "Europa Open Air concert" item no longer becomes a
//   CENTRAL_BANK_COMMUNICATION Event Version) while every legitimate
//   substantive-communication and recurring-release pattern still
//   PROCESSes, and statistical_press_release is entirely unaffected.
// ---------------------------------------------------------------------
function ecbObservation(overrides = {}) {
  return makeObservation({
    provider: 'ecb', providerItemId: 'ecb-eligibility-1', sourceCode: 'ecb', sourceDomain: 'ecb.europa.eu',
    providerCategory: 'press_communication',
    ...overrides,
  });
}

// A) The exact real live defect: a public-outreach item under the generic
//    /press/pr/ family must ABSTAIN, never PROCESS.
assertAbstain(
  planFor(ecbObservation({
    title: 'ECB and Frankfurt Radio Symphony invite the public to Europa Open Air concert on 20 August 2026',
    canonicalUrl: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr260801.en.html',
  })),
  'EVENT_ELIGIBILITY_UNRESOLVED',
  'ECB press_communication item matches neither a known structurally-eligible URL path family nor a narrowly-defined recurring macro/monetary release title pattern.',
  'A) concert générique /press/pr/',
);

// B) "Monetary policy decisions" recurring release title under generic
//    /press/pr/ -> eligible via title pattern.
assertProcess(planFor(ecbObservation({
  title: 'Monetary policy decisions',
  canonicalUrl: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp260901.en.html',
})), 'B) Monetary policy decisions');

// C) Monetary policy statement / press conference -> eligible via
//    structurally-eligible path family, irrespective of title wording.
assertProcess(planFor(ecbObservation({
  title: 'Monetary policy statement - press conference',
  canonicalUrl: 'https://www.ecb.europa.eu/press/press_conference/monetary-policy-statement/2026/html/ecb.is260901~abcdef.en.html',
})), 'C) Monetary policy statement / press conference');

// D) ECB speech under /press/key/ -> eligible via structural path.
assertProcess(planFor(ecbObservation({
  title: 'Some Governing Council member speech title, unrelated to any recurring-release keyword',
  canonicalUrl: 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp260901~123456.en.html',
})), 'D) discours /press/key/');

// E) ECB interview under /press/inter/ -> eligible via structural path.
assertProcess(planFor(ecbObservation({
  title: 'Interview with an unrelated newspaper, arbitrary wording',
  canonicalUrl: 'https://www.ecb.europa.eu/press/inter/date/2026/html/ecb.in260901~123456.en.html',
})), 'E) interview /press/inter/');

// F) ECB meeting account under /press/accounts/ -> eligible via structural
//    path.
assertProcess(planFor(ecbObservation({
  title: 'Account of the monetary policy meeting of the Governing Council',
  canonicalUrl: 'https://www.ecb.europa.eu/press/accounts/2026/html/ecb.mg260901~123456.en.html',
})), 'F) compte-rendu /press/accounts/');

// G) statistical_press_release remains PROCESS unconditionally — the gate
//    does not apply to it at all, any URL/title.
assertProcess(planFor(ecbObservation({
  providerCategory: 'statistical_press_release',
  title: 'Arbitrary statistical release title',
  canonicalUrl: 'https://www.ecb.europa.eu/press/pr/stats/date/2026/html/ecb.statspr260901.en.html',
})), 'G) statistical_press_release inchangé');

// H) ECB Consumer Expectations Survey -> eligible via recurring-release
//    title pattern under generic /press/pr/.
assertProcess(planFor(ecbObservation({
  title: 'ECB Consumer Expectations Survey results – August 2026',
  canonicalUrl: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.ces260901.en.html',
})), 'H) Consumer Expectations Survey');

// I) ECB wage tracker -> eligible via recurring-release title pattern.
assertProcess(planFor(ecbObservation({
  title: 'ECB wage tracker – September 2026 update',
  canonicalUrl: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.wagetracker260901.en.html',
})), 'I) wage tracker');

// J) ECB consolidated banking data -> eligible via recurring-release
//    title pattern.
assertProcess(planFor(ecbObservation({
  title: 'ECB publishes consolidated banking data for the second quarter of 2026',
  canonicalUrl: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.cbd260901.en.html',
})), 'J) consolidated banking data');

// K) A second, different generic /press/pr/ communication with no
//    matching evidence -> ABSTAIN (precision, not a one-off carve-out).
assertAbstain(
  planFor(ecbObservation({
    title: 'ECB President to receive an honorary degree from a European university',
    canonicalUrl: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr260915.en.html',
  })),
  'EVENT_ELIGIBILITY_UNRESOLVED',
  'ECB press_communication item matches neither a known structurally-eligible URL path family nor a narrowly-defined recurring macro/monetary release title pattern.',
  'K) autre communication générique /press/pr/',
);

// L) Spoofed/non-ECB hostname must NOT gain eligibility from an
//    ECB-looking path, even with an otherwise-eligible path AND title.
assertAbstain(
  planFor(ecbObservation({
    title: 'Monetary policy decisions',
    canonicalUrl: 'https://ecb.europa.eu.attacker.example/press/key/date/2026/html/ecb.sp260901.en.html',
  })),
  'EVENT_ELIGIBILITY_UNRESOLVED',
  'ECB press_communication item has no canonicalUrl verifiable against the expected ecb.europa.eu hostname.',
  'L) hostname usurpé rejeté malgré un chemin ECB apparent',
);
// A genuine *.ecb.europa.eu subdomain (the real production
// www.ecb.europa.eu shape) must still be accepted — the spoofing guard
// must not become a false-negative on legitimate ECB URLs.
assertProcess(planFor(ecbObservation({
  title: 'Monetary policy decisions',
  canonicalUrl: 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp260901.en.html',
})), 'L) sous-domaine ECB légitime (www.) toujours accepté');

// M) Deterministic replay: identical input produces a deep-equal result,
//    for both the eligible and the abstained case.
{
  const eligibleInput = ecbObservation({
    title: 'Monetary policy decisions',
    canonicalUrl: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp260901.en.html',
  });
  const planA = planFor(eligibleInput);
  const planB = planFor(eligibleInput);
  t('M) rejeu identique (éligible) -> résultat deep-equal', JSON.stringify(planA) === JSON.stringify(planB));

  const abstainInput = ecbObservation({
    title: 'ECB and Frankfurt Radio Symphony invite the public to Europa Open Air concert on 20 August 2026',
    canonicalUrl: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr260801.en.html',
  });
  const planC = planFor(abstainInput);
  const planD = planFor(abstainInput);
  t('M) rejeu identique (abstention) -> résultat deep-equal', JSON.stringify(planC) === JSON.stringify(planD));
}

// Defense in depth: canonicalUrl=null and a malformed canonicalUrl must
// both abstain (zero structural evidence), never throw, never PROCESS.
assertAbstain(
  planFor(ecbObservation({ title: 'Monetary policy decisions', canonicalUrl: null })),
  'EVENT_ELIGIBILITY_UNRESOLVED',
  'ECB press_communication item has no canonicalUrl verifiable against the expected ecb.europa.eu hostname.',
  'canonicalUrl null -> abstention (jamais un throw)',
);
assertAbstain(
  planFor(ecbObservation({ title: 'Monetary policy decisions', canonicalUrl: 'not a url at all' })),
  'EVENT_ELIGIBILITY_UNRESOLVED',
  'ECB press_communication item has no canonicalUrl verifiable against the expected ecb.europa.eu hostname.',
  'canonicalUrl malformée -> abstention (jamais un throw)',
);
// Non-https ECB-hostname URL must also fail closed (mirrors the RAW
// collector's own https-only requirement).
assertAbstain(
  planFor(ecbObservation({ title: 'Monetary policy decisions', canonicalUrl: 'http://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp260901.en.html' })),
  'EVENT_ELIGIBILITY_UNRESOLVED',
  'ECB press_communication item has no canonicalUrl verifiable against the expected ecb.europa.eu hostname.',
  'canonicalUrl http (non-https) -> abstention',
);

// FEDERAL_RESERVE/US_TREASURY/OFAC are entirely unaffected by this gate —
// no eligibility check runs for them at all.
{
  const combinedSourceForGateScope = source;
  t('le gate §8bis ne s\'applique textuellement qu\'à ECB (condition tuple.authority === \'ECB\')',
    /if \(tuple\.authority === 'ECB' && eventType === 'CENTRAL_BANK_COMMUNICATION'\)/.test(combinedSourceForGateScope));
}

// ---------------------------------------------------------------------
// 7. Canonical Event State v1 — normalisation, contenu interdit.
// ---------------------------------------------------------------------
{
  const plan = assertProcess(planFor(makeObservation({
    title: '  Federal   Reserve\t issues\n\n  FOMC   statement  ',
  })), 'normalisation whitespace');
  t('normalisation whitespace déterministe (collapse -> un seul espace ASCII, trim, casse préservée)',
    plan.canonicalEventState.subject === 'Federal Reserve issues FOMC statement');
}
{
  const withContent = assertProcess(planFor(makeObservation({ content: '  Full   text   here  ', summary: 'A summary' })), 'detail préfère content');
  t('detail préfère content non-vide', withContent.canonicalEventState.detail === 'Full text here');

  const withSummaryOnly = assertProcess(planFor(makeObservation({ content: null, summary: '  A   summary  ' })), 'detail retombe sur summary');
  t('detail retombe sur summary quand content est null', withSummaryOnly.canonicalEventState.detail === 'A summary');

  const withNeither = assertProcess(planFor(makeObservation({ content: null, summary: null })), 'detail null');
  t('detail null quand ni content ni summary', withNeither.canonicalEventState.detail === null);

  const blankContent = assertProcess(planFor(makeObservation({ content: '   ', summary: 'Fallback summary' })), 'content blanc retombe sur summary');
  t('content blanc (whitespace uniquement) retombe sur summary', blankContent.canonicalEventState.detail === 'Fallback summary');
}
{
  const plan = assertProcess(planFor(makeObservation({ title: 'MiXeD CaSe TiTlE Preserved' })), 'casse préservée');
  t('la casse du titre est préservée (jamais lowercased/uppercased)',
    plan.canonicalEventState.subject === 'MiXeD CaSe TiTlE Preserved');
}
{
  const plan = assertProcess(planFor(makeObservation()), 'contenu canonical_event_state');
  const keys = Object.keys(plan.canonicalEventState);
  t('canonical_event_state contient EXACTEMENT event_type/subject/detail',
    keys.length === 3 && keys.includes('event_type') && keys.includes('subject') && keys.includes('detail'));
  const serialized = JSON.stringify(plan.canonicalEventState);
  const forbiddenProvenance = ['provider', 'providerItemId', 'sourceCode', 'sourceDomain', 'canonicalUrl', 'observation', 'ingestRunId', 'publishedAt', 'publishedDate', 'observedAt', 'ingestedAt', 'editorialOriginKey', 'wireLineageKey'];
  t('canonical_event_state ne contient aucune donnée de provenance/ID/URL/timestamp',
    forbiddenProvenance.every((k) => !serialized.includes(k)));
  // Vérifié par FORME (clés de l'objet), jamais par une recherche de
  // sous-chaîne dans le texte libre : un communiqué FOMC réel contient
  // légitimement le mot anglais "target" (ex. "target range") dans son
  // detail/subject — ce n'est pas un champ Gold, seulement du texte
  // officiel normalisé. Le contrat porte sur l'ABSENCE de clé Gold, déjà
  // prouvée ci-dessus (canonical_event_state contient EXACTEMENT
  // event_type/subject/detail) — reconfirmé explicitement ici par nom.
  const forbiddenGoldFieldNames = ['direction', 'magnitude', 'confidence', 'horizon', 'pricing', 'pricing_state', 'regime', 'target', 'invalidation', 'probability'];
  t('canonical_event_state ne contient aucun champ analytique Gold (par nom de clé, jamais par sous-chaîne de texte libre)',
    forbiddenGoldFieldNames.every((k) => !Object.prototype.hasOwnProperty.call(plan.canonicalEventState, k)));
}

// ---------------------------------------------------------------------
// 8. Effective time — toujours null en PR4.
// ---------------------------------------------------------------------
{
  const plan = assertProcess(planFor(makeObservation({ publishedAt: '2026-09-01T18:00:00.000Z', publishedDate: null })), 'publishedAt ne devient jamais effectiveTime');
  t('effectiveTime reste null malgré publishedAt renseigné', plan.effectiveTime === null && plan.effectiveTimePrecision === null);
}
{
  const plan = assertProcess(planFor(makeObservation({ publishedAt: null, publishedDate: '2026-09-01' })), 'publishedDate ne devient jamais effectiveTime');
  t('effectiveTime reste null malgré publishedDate renseigné', plan.effectiveTime === null && plan.effectiveTimePrecision === null);
}

// ---------------------------------------------------------------------
// 9. Knowledge cutoff floor.
// ---------------------------------------------------------------------
{
  const plan = assertProcess(planFor(makeObservation({
    observedAt: '2026-09-01T18:05:00.000Z', ingestedAt: '2026-09-01T18:00:00.000Z',
  })), 'knowledgeCutoffFloor = max(observedAt, ingestedAt), observedAt plus tardif');
  t('knowledgeCutoffFloor = max quand observedAt > ingestedAt', plan.knowledgeCutoffFloor === '2026-09-01T18:05:00.000Z');
}
{
  const plan = assertProcess(planFor(makeObservation({
    observedAt: '2026-09-01T18:00:00.000Z', ingestedAt: '2026-09-01T18:07:00.000Z',
  })), 'knowledgeCutoffFloor = max(observedAt, ingestedAt), ingestedAt plus tardif');
  t('knowledgeCutoffFloor = max quand ingestedAt > observedAt', plan.knowledgeCutoffFloor === '2026-09-01T18:07:00.000Z');
}
{
  const planA = assertProcess(planFor(makeObservation({ publishedAt: '2020-01-01T00:00:00.000Z' })), 'publishedAt sans effet sur le cutoff (A)');
  const planB = assertProcess(planFor(makeObservation({ publishedAt: '2030-12-31T23:59:59.000Z' })), 'publishedAt sans effet sur le cutoff (B)');
  t('publishedAt n\'influence jamais knowledgeCutoffFloor', planA.knowledgeCutoffFloor === planB.knowledgeCutoffFloor);
}
assertAbstain(
  planFor(makeObservation({ observedAt: 'not-a-timestamp' })),
  'DATA_QUALITY_INSUFFICIENT', 'TEMPORAL_INPUT_INVALID', 'observedAt invalide',
);
assertAbstain(
  planFor(makeObservation({ ingestedAt: '2026-02-30T00:00:00.000Z' })),
  'DATA_QUALITY_INSUFFICIENT', 'TEMPORAL_INPUT_INVALID', 'ingestedAt invalide (30 février inexistant)',
);
{
  // Preuve indirecte de pureté temporelle : une entrée FIXE, ancienne,
  // produit TOUJOURS la même sortie exacte, peu importe l'horloge réelle
  // d'exécution du test.
  const fixed = makeObservation({ observedAt: '2019-01-01T00:00:00.000Z', ingestedAt: '2019-01-01T00:00:05.000Z' });
  const plan = assertProcess(planFor(fixed), 'aucune dépendance à l\'horloge courante');
  t('knowledgeCutoffFloor sur une entrée fixe ancienne est EXACTEMENT la valeur attendue (aucune dépendance à Date.now/horloge réelle)',
    plan.knowledgeCutoffFloor === '2019-01-01T00:00:05.000Z');
}

// ---------------------------------------------------------------------
// 10. Transition / matérialité.
// ---------------------------------------------------------------------
{
  const plan = assertProcess(planFor(makeObservation()), 'aucun prédécesseur -> NOVELTY');
  t('aucun prédécesseur -> NOVELTY, CREATE_VERSION, OFFICIALLY_CONFIRMED, previousEventVersionId=null',
    plan.transition === 'NOVELTY' && plan.versionDisposition === 'CREATE_VERSION'
    && plan.officialConfirmationState === 'OFFICIALLY_CONFIRMED' && plan.previousEventVersionId === null);
}

const CLUSTER_ID = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
function assignExistingIdentity(candidates = [CLUSTER_ID]) {
  return { kind: 'CURATED_STRONG_IDENTITY', authorityNamespace: 'a', identityType: 't', identityValue: 'v', candidateClusterIds: candidates };
}
const CANONICAL_A = { event_type: 'MONETARY_POLICY_COMMUNICATION', subject: 'Federal Reserve issues FOMC statement', detail: 'The Committee decided to maintain the target range.' };
const CANONICAL_B = { event_type: 'MONETARY_POLICY_COMMUNICATION', subject: 'Federal Reserve issues a DIFFERENT FOMC statement', detail: 'The Committee changed policy materially.' };

{
  // Faits identiques, aucune amélioration de confirmation/indépendance.
  const clusterContext = {
    clusterId: CLUSTER_ID,
    previousVersion: {
      eventVersionId: 'ev-1', canonicalEventState: CANONICAL_A, effectiveTime: null, effectiveTimePrecision: null,
      officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
    },
    activeEvidenceLineages: [{ editorialOriginKey: 'official:federal_reserve', wireLineageKey: null }],
  };
  const plan = assertProcess(planFor(makeObservation(), assignExistingIdentity(), clusterContext), 'faits identiques, sans amélioration');
  t('faits identiques + aucune amélioration -> NO_MATERIAL_CHANGE',
    plan.versionDisposition === 'NO_MATERIAL_CHANGE' && plan.transition === null && plan.previousEventVersionId === 'ev-1');
}
{
  // Faits identiques, amélioration de l'état de confirmation officielle.
  const clusterContext = {
    clusterId: CLUSTER_ID,
    previousVersion: {
      eventVersionId: 'ev-2', canonicalEventState: CANONICAL_A, effectiveTime: null, effectiveTimePrecision: null,
      officialConfirmationState: 'UNCONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
    },
    activeEvidenceLineages: [{ editorialOriginKey: 'official:federal_reserve', wireLineageKey: null }],
  };
  const plan = assertProcess(planFor(makeObservation(), assignExistingIdentity(), clusterContext), 'faits identiques + upgrade officiel');
  t('faits identiques + amélioration officielle -> CONFIRMATION, OFFICIALLY_CONFIRMED',
    plan.versionDisposition === 'CREATE_VERSION' && plan.transition === 'CONFIRMATION'
    && plan.officialConfirmationState === 'OFFICIALLY_CONFIRMED' && plan.previousEventVersionId === 'ev-2');
}
{
  // Faits identiques, nouvelle origine indépendante.
  const clusterContext = {
    clusterId: CLUSTER_ID,
    previousVersion: {
      eventVersionId: 'ev-3', canonicalEventState: CANONICAL_A, effectiveTime: null, effectiveTimePrecision: null,
      officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
    },
    activeEvidenceLineages: [{ editorialOriginKey: 'official:ecb', wireLineageKey: null }],
  };
  // La nouvelle observation (Fed) porte les MÊMES faits canoniques que la
  // version précédente (identiques du point de vue objectif), mais une
  // origine éditoriale DIFFÉRENTE.
  const plan = assertProcess(planFor(makeObservation({ title: CANONICAL_A.subject, summary: CANONICAL_A.detail }), assignExistingIdentity(), clusterContext), 'faits identiques + nouvelle origine indépendante');
  t('faits identiques + nouvelle origine indépendante -> CONFIRMATION + INDEPENDENTLY_CORROBORATED',
    plan.versionDisposition === 'CREATE_VERSION' && plan.transition === 'CONFIRMATION'
    && plan.sourceIndependenceState === 'INDEPENDENTLY_CORROBORATED' && plan.previousEventVersionId === 'ev-3');
}
{
  // Même origine unique + faits modifiés -> CORRECTION.
  const clusterContext = {
    clusterId: CLUSTER_ID,
    previousVersion: {
      eventVersionId: 'ev-4', canonicalEventState: CANONICAL_A, effectiveTime: null, effectiveTimePrecision: null,
      officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
    },
    activeEvidenceLineages: [{ editorialOriginKey: 'official:federal_reserve', wireLineageKey: null }],
  };
  const plan = assertProcess(planFor(makeObservation({ title: CANONICAL_B.subject, summary: CANONICAL_B.detail }), assignExistingIdentity(), clusterContext), 'même origine unique + faits modifiés');
  t('même origine unique + faits modifiés -> CORRECTION, OFFICIALLY_CORRECTED',
    plan.versionDisposition === 'CREATE_VERSION' && plan.transition === 'CORRECTION'
    && plan.officialConfirmationState === 'OFFICIALLY_CORRECTED' && plan.previousEventVersionId === 'ev-4');
}
{
  // Origine différente + faits modifiés -> SIGNAL_CONFLICT.
  const clusterContext = {
    clusterId: CLUSTER_ID,
    previousVersion: {
      eventVersionId: 'ev-5', canonicalEventState: CANONICAL_A, effectiveTime: null, effectiveTimePrecision: null,
      officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
    },
    activeEvidenceLineages: [{ editorialOriginKey: 'official:ecb', wireLineageKey: null }],
  };
  const plan = planFor(makeObservation({ title: CANONICAL_B.subject, summary: CANONICAL_B.detail }), assignExistingIdentity(), clusterContext);
  assertAbstain(plan, 'SIGNAL_CONFLICT', 'FACTUAL_CONFLICT', 'origine différente + faits modifiés');
}
{
  // Origines multiples préexistantes + une assertion officielle modifiée -> SIGNAL_CONFLICT.
  const clusterContext = {
    clusterId: CLUSTER_ID,
    previousVersion: {
      eventVersionId: 'ev-6', canonicalEventState: CANONICAL_A, effectiveTime: null, effectiveTimePrecision: null,
      officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'INDEPENDENTLY_CORROBORATED',
    },
    activeEvidenceLineages: [
      { editorialOriginKey: 'official:federal_reserve', wireLineageKey: null },
      { editorialOriginKey: 'official:ecb', wireLineageKey: null },
    ],
  };
  const plan = planFor(makeObservation({ title: CANONICAL_B.subject, summary: CANONICAL_B.detail }), assignExistingIdentity(), clusterContext);
  assertAbstain(plan, 'SIGNAL_CONFLICT', 'FACTUAL_CONFLICT', 'origines multiples préexistantes + faits modifiés');
}
{
  // Lignage préexistant non résolu + faits modifiés -> SIGNAL_CONFLICT.
  const clusterContext = {
    clusterId: CLUSTER_ID,
    previousVersion: {
      eventVersionId: 'ev-7', canonicalEventState: CANONICAL_A, effectiveTime: null, effectiveTimePrecision: null,
      officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'UNKNOWN',
    },
    activeEvidenceLineages: [{ editorialOriginKey: null, wireLineageKey: null }],
  };
  const plan = planFor(makeObservation({ title: CANONICAL_B.subject, summary: CANONICAL_B.detail }), assignExistingIdentity(), clusterContext);
  assertAbstain(plan, 'SIGNAL_CONFLICT', 'FACTUAL_CONFLICT', 'lignage préexistant non résolu + faits modifiés');
}

// ---------------------------------------------------------------------
// 11. Aucune inférence de REVERSAL.
// ---------------------------------------------------------------------
for (const word of ['reversed', 'cancelled', 'withdrawn', 'not']) {
  const clusterContext = {
    clusterId: CLUSTER_ID,
    previousVersion: {
      eventVersionId: 'ev-reversal', canonicalEventState: CANONICAL_A, effectiveTime: null, effectiveTimePrecision: null,
      officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
    },
    activeEvidenceLineages: [{ editorialOriginKey: 'official:federal_reserve', wireLineageKey: null }],
  };
  const plan = assertProcess(planFor(
    makeObservation({ title: `The Federal Reserve statement is now ${word}`, summary: `Policy has been ${word} effective immediately.` }),
    assignExistingIdentity(),
    clusterContext,
  ), `mot-clé "${word}" ne déclenche jamais REVERSAL`);
  t(`transition n'est JAMAIS 'REVERSAL' pour le mot-clé "${word}" (CORRECTION attendue, jamais une inférence lexicale)`,
    plan.transition !== 'REVERSAL' && plan.transition === 'CORRECTION');
}

// ---------------------------------------------------------------------
// 12. Déterminisme.
// ---------------------------------------------------------------------
{
  const observation = makeObservation({ id: 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0' });
  const strongIdentity = { kind: 'NONE' };
  const plan1 = planEventProcessing({ observation, strongIdentity, clusterContext: null });
  const plan2 = planEventProcessing({ observation, strongIdentity, clusterContext: null });
  t('un appel identique produit une sortie deep-equal (déterminisme)',
    JSON.stringify(plan1) === JSON.stringify(plan2));
}

// ---------------------------------------------------------------------
// 13. Garde-fous statiques (imports/tokens interdits, en complément des
//     tests comportementaux ci-dessus — jamais un substitut).
// ---------------------------------------------------------------------
const liveSource = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

t('OPS023_EVENT_PROCESSOR_VERSION exporté comme constante nommée dans le source',
  /export const OPS023_EVENT_PROCESSOR_VERSION\s*=\s*'ops023-deterministic-event-processor-v1'/.test(liveSource));

const FORBIDDEN_RUNTIME_TOKENS = [
  '@supabase', 'fetch(', 'Anthropic', 'OpenAI', 'Gemini',
  'backend/ingest', 'wrangler', 'news_events', 'notifications',
];
for (const token of FORBIDDEN_RUNTIME_TOKENS) {
  t(`aucune référence exécutable à "${token}"`, !liveSource.includes(token));
}
t('aucune référence exécutable à "worker" comme import/appel (seulement en prose de commentaire, déjà retirée)',
  !/\bworker\b/i.test(liveSource));
t('aucun Date.now( exécutable', !liveSource.includes('Date.now('));
t('aucun Math.random( exécutable', !liveSource.includes('Math.random('));
t('aucun crypto.randomUUID( exécutable', !liveSource.includes('crypto.randomUUID('));
t('aucun import depuis @supabase/*', !/from\s+['"]@supabase/.test(liveSource));
t('aucun import de backend/ingest.ts', !/from\s+['"].*ingest\.js['"]/.test(liveSource) && !/from\s+['"].*ingest\.ts['"]/.test(liveSource));
t('aucune chaîne SQL exécutable (SELECT/INSERT/RPC)', !/\b(SELECT|INSERT INTO|CALL\s+fn_)\b/.test(liveSource));
t('aucun appel à une Event RPC (fn_event_*)', !/fn_event_[a-z_]+\s*\(/.test(liveSource));

const FORBIDDEN_GOLD_FIELDS = ['direction', 'magnitude', 'confidence', 'horizon', 'pricing_state', 'regime', 'target', 'invalidation', 'probability'];
for (const field of FORBIDDEN_GOLD_FIELDS) {
  const re = new RegExp(`\\b${field}\\b`, 'i');
  t(`aucun champ analytique Gold "${field}" comme identifiant autonome dans le source exécutable`, !re.test(liveSource));
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
