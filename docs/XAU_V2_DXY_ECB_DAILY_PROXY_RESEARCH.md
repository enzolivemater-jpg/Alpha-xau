# XAU V2 — DXY proxy BCE quotidien (recherche, OFFLINE)

Status: **RESEARCH_ONLY / NOT VERIFIED / NOT ICE OFFICIAL**. Module: `shared/dxy_ecb_daily_proxy.mjs`.

## Objectif et périmètre
Calculer **hors ligne** une approximation quotidienne indépendante de l'indice USDX à partir des six taux de référence BCE (unités de devise pour 1 EUR). Aucun accès réseau, scraping, compte ou fournisseur payant dans le module. Cette série **ne satisfait jamais** l'exigence `DXY_ICE_OFFICIAL` du contrat DATA-3 VERIFIED et **n'alimente pas MP-0**, les décisions, le terminal ou l'exécution. HOLD / FORBIDDEN inchangé.

## Acquisition manuelle, sans collecte automatisée
API BCE documentée : 
`https://data-api.ecb.europa.eu/service/data/EXR/D.USD+JPY+GBP+CAD+SEK+CHF.EUR.SP00.A?format=csvdata`.

1. Télécharger volontairement ce CSV auprès de la BCE et conserver les octets du fichier.
2. Calculer SHA-256 des octets **bruts** et consigner leur origine, date d'acquisition et conditions d'usage.
3. Charger le texte CSV avec `parseEcbDailyCsv(csvText, {sourceSha256: hash})`. Le parseur attend `TIME_PERIOD`, `CURRENCY`, `CURRENCY_DENOM`, `OBS_VALUE`; six observations distinctes par jour, toutes libellées contre EUR.
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
