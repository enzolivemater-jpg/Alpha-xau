# XAU V2 — DXY proxy BCE quotidien (recherche, OFFLINE)

Status: **RESEARCH_ONLY / NOT VERIFIED / NOT ICE OFFICIAL**. Module: `shared/dxy_ecb_daily_proxy.mjs`.

## Objectif et périmètre
Calculer **hors ligne** une approximation quotidienne indépendante de l'indice USDX à partir des six taux de référence BCE (unités de devise pour 1 EUR). Aucun accès réseau, scraping, compte ou fournisseur payant dans le module. Cette série **ne satisfait jamais** l'exigence `DXY_ICE_OFFICIAL` du contrat DATA-3 VERIFIED et **n'alimente pas MP-0**, les décisions, le terminal ou l'exécution. HOLD / FORBIDDEN inchangé.

## Acquisition manuelle, sans collecte automatisée
API BCE documentée : 
`https://data-api.ecb.europa.eu/service/data/EXR/D.USD+JPY+GBP+CAD+SEK+CHF.EUR.SP00.A?format=csvdata`.

1. Télécharger volontairement ce CSV auprès de la BCE et conserver les octets du fichier.
2. Calculer SHA-256 des octets **bruts** et consigner leur origine, date d'acquisition et conditions d'usage.
3. Charger le texte CSV avec `parseEcbDailyCsv(csvText, {sourceSha256: hash})`. Le parseur attend `KEY`, `TIME_PERIOD`, `CURRENCY`, `CURRENCY_DENOM`, `OBS_VALUE`; six observations distinctes par jour, toutes libellées contre EUR.
   Seule la série de référence quotidienne est acceptée : `KEY` doit valoir `EXR.D.<devise>.EUR.SP00.A`, et `FREQ`, `EXR_TYPE`, `EXR_SUFFIX`, s'ils sont présents, doivent la confirmer (`D`, `SP00`, `A`), sinon `ECB_SERIES_KEY_INVALID`. Si `OBS_STATUS` est présent, toute valeur autre que `A` (valeur normale) rejette le fichier (`ECB_OBS_STATUS_NOT_NORMAL`).
4. Une date manquante ou incomplète produit `UNAVAILABLE` (aucun remplissage); les observations invalides ou contradictoires sont rejetées.

## Construction
Pour un jour unique, on désigne `R_C` le nombre d'unités de la devise C pour 1 EUR. Alors `EURUSD = R_USD`, `USDJPY = R_JPY / R_USD`, `GBPUSD = R_USD / R_GBP`, `USDCAD = R_CAD / R_USD`, et analogues pour SEK/CHF.

Appliquer :
`50.14348112 * EURUSD^(-0.576) * USDJPY^(0.136) * GBPUSD^(-0.119) * USDCAD^(0.091) * USDSEK^(0.042) * USDCHF^(0.036)`.

Formule et pondérations : ICE USDX methodology, https://www.ice.com/publicdocs/futures_us/ICE_Dollar_Index_FAQ.pdf .

## Restrictions d'interprétation
- Le résultat est `DXY_PROXY_RECONSTRUCTED_ECB_DAILY`, **jamais** une observation ICE ou un prix de marché à la minute.
- Les taux BCE sont des références quotidiennes, pas des transactions FX synchronisées avec les timestamps ICE. Écarts attendus ; comparaison quantitative à établir ultérieurement.
- `TIME_PERIOD` est la **date économique**, pas le timestamp de publication. Sans preuve datée du moment de disponibilité et de réception, `lookaheadSafeForReplay=false`. Le proxy ne peut pas être rejoué comme une valeur connue à un cutoff intrajournalier.
- L'empreinte fournie est déclarée par l'appelant ; elle doit être calculée et vérifiée sur les octets bruts avant l'appel. Le module ne prétend pas effectuer cette vérification lui-même.
- Les droits BCE doivent être respectés avec attribution. Aucun téléchargement automatique ni rediffusion par ce module.

## Tests
`node --test tests/test_dxy_ecb_daily_proxy.mjs`.

L'intégration DATA-3 n'est **pas** activée. Pour autoriser un scénario de recherche explicitement séparé, il faudra définir un contrat de provenance/release-time propre, des tests de cutoff et des contrôles d'interface avant toute connexion au pipeline existant.

## Commande locale de vérification

Après téléchargement manuel du CSV BCE, depuis la racine du dépôt :

```bash
node scripts/dxy_ecb_proxy_check.mjs /chemin/vers/ecb.csv
```

La commande lit le fichier sans requête réseau, calcule elle-même le SHA-256 des octets lus, et écrit sur stdout un rapport JSON comportant dates, valeurs reconstruites et indisponibilités. Code de sortie : `0` pour toutes les dates complètes, `1` en présence de dates incomplètes ou de données invalides, `64` en cas d'usage incorrect. Ne rien importer automatiquement dans DATA-3, MP-0 ou le terminal.

Tests ciblés (à exécuter localement) :
```bash
node --test tests/test_dxy_ecb_daily_proxy.mjs tests/test_dxy_ecb_proxy_cli.mjs
```

Les deux fichiers sont enregistrés dans `scripts/run_ci_tests.mjs` (sans cela, `tests/test_ci_inventory.mjs` échouait et les tests ne tournaient jamais en CI). Exécutés localement par XAU V2 — LOCAL DEVELOPMENT (Node 22) : voir `docs/XAU_V2_RC_CONSOLIDATION_QUALIFICATION.md`.

Couverture vérifiée par mutation : inversion de chaque paire, signe et poids, constante, contrôle de clé de série, statut d'observation, drapeaux `officialIceDxy` / `lookaheadSafeForReplay`, jour incomplet, doublon, nombre de colonnes, jeu de devises, `kind` remplacé par `DXY_ICE_OFFICIAL` : chaque mutation fait échouer au moins un test.

## Contrôle sur un véritable CSV BCE
Un CSV téléchargé depuis l'API documentée ci-dessus (`startPeriod=2026-09-01&endPeriod=2026-10-23`, 235 lignes, 32 colonnes `csvdata`) a été lu par la commande locale : 39 jours, 39 `CALCULATED`, 0 `UNAVAILABLE`, sortie 0. Le fichier n'est pas versionné. Ce contrôle prouve la lecture du format réel, pas l'exactitude du proxy face à l'ICE : aucune valeur ICE officielle n'est disponible localement pour comparer (service payant).
