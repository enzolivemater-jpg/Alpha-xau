# XAU V2 — Consolidation institutionnelle RC OFFLINE : rapport de qualification

Date : 2026-10-24. Agent : XAU V2 — LOCAL DEVELOPMENT (WSL, Node 22.23.3,
TypeScript du dépôt). Base commune : `c817c85` (tête de la PR #161,
Quality Gate GitHub 11/11 au 2026-10-20).

Aucun push, merge, déploiement, migration, transaction ni accès production.
Aucun service payant. REC-1 gelé ; HOLD / FORBIDDEN maintenu partout. Un test
au vert n'est pas une validation financière.

Accès réseau utilisés, tous en lecture seule : `git ls-remote` et
`git fetch` de `origin` vers les seules références de suivi
(`refs/remotes/origin/*`, `refs/remotes/origin-pr/*`), sans toucher
aucune branche locale ni `main` ; un téléchargement du CSV public de l'API
BCE (données libres de réutilisation avec mention de la source).

## 1. Branches produites (locales, non poussées)

| Branche | Tête | Au-dessus de `c817c85` | Responsabilité | Worktree |
| --- | --- | --- | --- | --- |
| `fix/cftc-contract-code-null` | `2b71290` | 1 commit | CFTC : code marché null | `.claude/worktrees/xau-cftc-null` |
| `feat/dxy-ecb-daily-proxy-offline` | `9cf926e` | 8 commits distants (`33ade80`) + 2 locaux | proxy DXY BCE (recherche) | `.claude/worktrees/xau-dxy` |
| `docs/data-3-verified-gaps` | `dae07da` | 2 commits de doc | DATA-3 et ce rapport (base de la suivante) | `.claude/worktrees/xau-data3-gaps` |
| `fix/data-3-l1-coverage` | voir `git log` | `dae07da` + correctif L1 + cette mise à jour | DATA-3 : branche de la PR | `.claude/worktrees/xau-data3-l1` |

Les trois branches sont indépendantes et partent de `c817c85`. Elles ne se
recouvrent sur aucun fichier, à une exception près : la doc DXY renvoie à ce
rapport, qui vit sur la branche DATA-3 (`fix/data-3-l1-coverage`).

Worktrees et branches existants : non modifiés. `main` : non modifiée.

## 2. Priorité 1 — CFTC

### Patch Cloud `10083cc` : **BLOCKED (inaccessible)**
`10083cc` n'existe dans aucune branche de `origin` (389 références listées,
toutes récupérées en suivi) ni dans aucune référence `refs/pull/*/head`.
Le patch n'a **pas** été récupéré. Il peut être un commit local à la session
Cloud jamais poussé, ou avoir été réécrit. Pour le récupérer, il faut que la
session XAU V2 — CLOUD DEVELOPMENT le pousse sur une branche (ou fournisse un
`git format-patch`).

### Défaut `contractMarketCode` null : **corrigé localement, indépendamment du patch Cloud**
Constat à `c817c85` : `request.contractMarketCode ?? GOLD` dans l'adaptateur.
Une déclaration `"contractMarketCode": null` passait la validation du
terminal, puis était convertie **silencieusement comme de l'or** (088691).
De même, `cot_declare --contract ""` retombait sur l'or.

Correctif `2b71290` (adaptateur 1.4.1) :
- adaptateur : seul un code **absent** signifie l'or ; `null`, `''` ou un
  nombre renvoient `INVALID_REQUEST` ;
- terminal : une déclaration dont `contractMarketCode` n'est pas une chaîne
  est `DECLARATION_INVALID` ;
- `cot_declare` : `--contract` doit être un code CFTC de 6 caractères.

La déclaration réelle locale n'a pas de `contractMarketCode` : elle n'était
pas touchée par ce défaut et reste lue comme avant.

| Preuve | Résultat |
| --- | --- |
| Nouveaux tests contre le code de `c817c85` (RED) | FAIL attendu : adaptateur, `cot_declare`, catalogue |
| Mêmes tests après correctif (GREEN) | PASS : adaptateur, `cot_declare`, catalogue, `terminal_positioning_cot`, `terminal_data_check` |
| Mutants : `??` rétabli ; `\|\|` ; contrôle de type de déclaration retiré ; `--contract` libre | 4/4 tués |
| Suite complète `npm test` (runner CI) | 158/158 PASS |
| `tsc --noEmit` | PASS |

Les tests de mutation du patch Cloud ne peuvent pas être vérifiés (patch
inaccessible) : **NOT TESTED**. Ceux ci-dessus sont les miens.

## 3. Priorité 2 — DXY BCE

Branche distante `feat/dxy-ecb-daily-proxy-offline` = `33ade80`, 8 commits
au-dessus de `c817c85` (ancêtre vérifié), 5 fichiers.

| Contrôle | Résultat |
| --- | --- |
| Tests du calculateur et du lecteur CSV, tels que livrés | 7/7 PASS |
| `tests/test_ci_inventory.mjs` sur la branche livrée | **FAIL** : les deux fichiers de test n'étaient pas enregistrés, donc jamais exécutés en CI |
| Conversions EUR → six paires | vérifiées sur valeurs exactes : EURUSD = R_USD, USDJPY = R_JPY/R_USD, GBPUSD = R_USD/R_GBP, USDCAD, USDSEK, USDCHF = R_x/R_USD |
| Formule ICE (constante 50.14348112, poids −0.576, 0.136, −0.119, 0.091, 0.042, 0.036) | vérifiée indépendamment de la construction croisée (paires à 1, puis une seule paire à 2) |
| Véritable CSV BCE (`csvdata`, 2026-09-01 → 2026-10-23, sha256 `27302bdd…ffae18`, non versionné) | lecture OK : 39 jours, 39 `CALCULATED`, 0 `UNAVAILABLE`, sortie 0 ; résultats identiques avant et après correctifs |
| Exactitude du proxy face à l'ICE | **NOT TESTED** : aucune valeur ICE officielle accessible sans licence payante |

Défauts corrigés :
- `6eb5b21` : enregistrement des deux tests dans `scripts/run_ci_tests.mjs` ;
- `9cf926e` : seule la série de référence quotidienne est lue (`KEY` =
  `EXR.D.<devise>.EUR.SP00.A`, `FREQ`/`EXR_TYPE`/`EXR_SUFFIX` cohérents),
  et `OBS_STATUS` différent de `A` rejette le fichier. Auparavant, une série
  mensuelle ou de fin de période, ou une valeur provisoire, pouvait passer.
  Ajout de `ecbRatesToUsdxPairs` et d'un test statique qui garde le module
  hors du runtime (`backend`, `frontend`, `shared`), avec un `kind` sans
  `ICE` ni `OFFICIAL`.

Mutation : 15 mutants, dont 2 survivants au premier passage (contrôle de clé
seul, nombre de colonnes). Deux tests ajoutés les tuent : **15/15**.

Séparation `DXY_PROXY_RECONSTRUCTED` / `DXY_ICE_OFFICIAL` : maintenue. Le
proxy porte `kind: DXY_PROXY_RECONSTRUCTED_ECB_DAILY`,
`officialIceDxy: false`, `lookaheadSafeForReplay: false` ; aucun module
runtime ne l'importe (test). Le champ `dxy` du contrat marché reste
`instrument: 'DXY'` et n'est pas alimenté.

## 4. Priorité 3 — DATA-3

Voir `docs/XAU_V2_DATA_3_VERIFIED_GAPS.md`. En résumé :
- validateur DATA-3 sur les captures réelles locales à `c817c85` :
  **115/115 PASS**, sources inchangées, tous les replays `INCOMPLETE` ;
- manques qui empêchent VERIFIED : G1 aucune source `dxy`/`bid`/`ask`,
  G2 aucune règle de fraîcheur DXY, G3 couverture auto-déclarée, G4 stockage
  brut runtime ;
- **faille L1** : un journal `CAPTURED` qui déclare les huit champs rend
  `VERIFIED` / `HISTORICAL_VERIFIED` avec `dxy`, `bid`, `ask` indisponibles,
  et `market_evidence_capture.mjs init` déclare les huit champs. **Corrigée**
  le 2026-10-24 à la demande de l'opérateur (§10) ;
- prérequis MP-0 et règles anti-lookahead : préparés, **non approuvés**.

## 5. Matrice

| Élément | Statut |
| --- | --- |
| Récupération du patch Cloud `10083cc` | BLOCKED |
| Tests de mutation du patch Cloud | NOT TESTED |
| Correctif local `contractMarketCode` null (RED → GREEN, 4/4 mutants) | PASS |
| Tests DXY livrés | PASS (7/7) |
| Inventaire CI sur la branche DXY livrée | FAIL → corrigé, PASS |
| Conversions EUR → paires et formule | PASS |
| Lecture d'un véritable CSV BCE | PASS |
| Proxy BCE ≈ DXY ICE | NOT TESTED (licence payante) |
| Mutation DXY | PASS (15/15) |
| Suite complète, branche DXY (`9cf926e`) | PASS 160/160 ; `tsc` PASS |
| Suite complète, branche CFTC (`2b71290`) | PASS 158/158 ; `tsc` PASS |
| Validateur DATA-3, captures réelles | PASS 115/115 |
| Correctif L1 (replay 1.1.0) : RED → GREEN, 7/7 mutants, anciens manifestes réels 115/115 | PASS |
| Replay réel VERIFIED | BLOCKED (G1 à G4) |
| MP-0 confiance dans un replay | NOT TESTED, non approuvé |
| GitHub Quality Gate sur ces trois têtes | NOT TESTED (aucun push autorisé) |
| Lanceur Windows `.cmd`, navigateurs autres que Chromium | NOT TESTED (pas d'interop Windows) |

## 6. Suites complètes

Runner CI local (`node scripts/run_ci_tests.mjs`, Node 22), chaque branche
dans son propre worktree :

| Branche | Tête | Fichiers de test | `tsc --noEmit` |
| --- | --- | --- | --- |
| `fix/cftc-contract-code-null` | `2b71290` | 158/158 PASS | PASS |
| `feat/dxy-ecb-daily-proxy-offline` | `9cf926e` | 160/160 PASS (158 + 2 DXY) | PASS |
| `docs/data-3-verified-gaps` | `dae07da` | 158/158 PASS (avec ce rapport) | non concerné (doc seule) |
| `fix/data-3-l1-coverage` | `6a224d7` | 158/158 PASS | PASS |
| intégration des trois (HEAD détachée jetable, non conservée) | `b9fe5be` | 160/160 PASS | PASS |

Les suites PostgreSQL (`*_postgres.mjs`) n'ont pas été relancées : aucune
des trois branches ne touche le SQL ni ces modules. NOT TESTED sur ces têtes.

## 7. PR préparées (non ouvertes, non fusionnées)

Chacune vers `verify/terminal-demo-offline` ou empilée sur la PR #161
(`c817c85`) ; le CI ne tourne que pour `main` ou
`verify/terminal-demo-offline`.

1. **`fix/cftc-contract-code-null`** — « CFTC adapter 1.4.1 : a declared null
   market code never falls back to gold ». Indépendante, la plus urgente.
2. **`feat/dxy-ecb-daily-proxy-offline`** — branche distante plus 2 commits
   locaux. La pousser **met à jour une branche distante existante**
   (avance rapide, `33ade80` → `9cf926e`).
3. **`fix/data-3-l1-coverage`** — correctif L1, analyse DATA-3 et ce rapport
   (contient `docs/data-3-verified-gaps`, qui n'a pas besoin de PR propre).

Dépendances : aucune entre les trois. Aucun fichier commun ; fusions deux à
deux propres (`git merge-tree`) ; les trois ensemble : 160/160. Seul lien :
la doc DXY renvoie à ce rapport (référence documentaire).

Avant tout push : rechercher des valeurs CFTC ou de marché réelles dans les
lignes ajoutées et retirées ainsi que dans les messages. Fait localement sur
les trois branches : seuls des codes de contrat et des valeurs synthétiques y
figurent.

## 8. Décisions humaines bloquantes

1. **Patch Cloud `10083cc`** : demander à XAU V2 — CLOUD DEVELOPMENT de le
   pousser, ou accepter le correctif local `2b71290` à sa place.
2. **Push** des trois branches et ouverture des PR (aucune autorisation à ce
   jour).
3. ~~Faille L1~~ : tranchée par l'opérateur (options a et b), corrigée en
   `6a224d7`. Reste à valider le changement visible : la démo synthétique
   affiche désormais « REJEU INCOMPLET ».
4. **DXY** : licence ICE (payante) ou redéfinition de VERIFIED sans `dxy`.
   Le proxy BCE reste de la recherche et ne remplace pas l'ICE.
5. **bid / ask** : source avec carnet (compte OANDA ou autre) ou exclusion
   contractuelle.
6. **Règle de fraîcheur DXY** (G2), une fois la source choisie.
7. **Décisions DATA-3 n° 1 à 3** (déjà ouvertes) : autorisation de capture,
   stockage brut (migration), confiance MP-0.

## 9. Observations

- Deux fichiers vides en lecture seule, `.bash_profile` et `.bashrc`, sont
  apparus non suivis à la racine du dépôt principal (2026-10-24 18:55). Ce
  sont des artefacts du bac à sable, pas des fichiers créés par cette
  mission. Ils ont été laissés en place.

## 10. Mise à jour — correctif L1 (2026-10-24, suite)

Branche `fix/data-3-l1-coverage`, commit `6a224d7`, sur `dae07da`.

- `createEvidenceArchive` refuse une couverture qu'aucune série de capture ne
  peut remplir (`COVERAGE_FIELD_NOT_CAPTURABLE`) ; `init` ne déclare que
  `CAPTURABLE_FIELDS` (spot, us10y, realYield, vix, wti).
- Replay 1.1.0 : un champ couvert sans valeur détenue au cutoff donne
  `DECLARED_FIELD_NOT_OBSERVED`, donc `INCOMPLETE`, non reproductible.
- Aucun changement de format, aucune migration. Les anciens journaux se lisent,
  s'étendent et se rejouent, en `INCOMPLETE`. Les captures réelles locales :
  115/115, sources inchangées, aucune `VERIFIED`.
- Effets visibles : la fixture synthétique DATA-1 (dxy déclaré, aucune valeur)
  passe en `INCOMPLETE` et le terminal affiche « REJEU INCOMPLET · non
  reproductible ». La fixture n'a pas été modifiée. Lui ajouter une fausse
  valeur DXY aurait fait passer MP-1 de `DEGRADED` à `AS_OF_AVAILABLE` pour une
  valeur fictive ; les chemins VERIFIED sont donc testés sur une copie
  complétée dans le test.
- `HISTORICAL_VERIFIED` est hors d'atteinte tant qu'aucune source DXY ni
  règle de fraîcheur DXY n'existe (G1, G2). C'est l'état honnête.

| Preuve | Résultat |
| --- | --- |
| Nouveaux tests contre le moteur de `dae07da` | RED : replay, capture, terminal |
| Après correctif | GREEN ; `tsc` PASS ; suite 158/158 |
| Mutants (règle de replay retirée, code non compté, `some`→`every`, test de nullité, contrôle de création retiré, dxy rendu capturable, `init` à 8 champs) | 7/7 tués |
| Validateur DATA-3 sur les journaux réels anciens | 115/115, sources inchangées |

## 11. Défaut suivant — contrôle vide du validateur DATA-3

`scripts/validate_evidence_captures.mjs` comptait parmi ses « 115/115 » le
contrôle « never reproducible without complete coverage », écrit
`status !== 'VERIFIED' || reproducible`. Le replay pose
`reproducible = (status === 'VERIFIED')` : ce contrôle ne pouvait jamais
échouer, et il aurait laissé passer un replay VERIFIED sans DXY (le cas L1).

Remplacé par `verifiedClaimProblems` : VERIFIED seulement si chaque champ MP-0
est détenu au cutoff ; `reproducible` égal à VERIFIED ; `HISTORICAL_VERIFIED`
seulement sur un replay VERIFIED. Tests unitaires, dont la preuve que l'ancienne
expression acceptait le cas L1 ; 4/4 mutants tués ; suite complète 158/158 ;
`tsc` PASS. Captures réelles : toujours 115/115, sources inchangées. Ce
contrôle passe désormais parce qu'aucune source ne se dit VERIFIED, et non plus
par construction.

Écarté après vérification : `raw_news.ts` `ingestQualityState ?? 'VALID'`
n'est pas atteignable avec `null` (rejeté plus haut, ligne 365).
