# XAU V2 — DATA-3 : exigences d'une source bid / ask

Statut : **EXIGENCES, AUCUNE SOURCE RETENUE**. 2026-10-25, XAU V2 — LOCAL
DEVELOPMENT. Décision utilisateur : `bid` et `ask` restent exigés par le
contrat VERIFIED (G1). Rien n'a été acheté, ouvert ni appelé. Le DXY n'est
pas traité ici : DXY ICE reste la référence officielle, et le proxy BCE sert
uniquement à la recherche.

## 1. Ce que le code exige déjà (vérifié dans le dépôt)

| Exigence | Où |
| --- | --- |
| Instrument `XAUUSD`, unité `USD_PER_TROY_OUNCE`, types `BID` et `ASK` | `MARKET_EVIDENCE_FIELD_SPEC` (`evidence_archive.ts`) |
| Fraîcheur selon la règle `XAUUSD` existante (LIVE ≤ 360 s, au-delà de 3 j expiré) | `freshnessSymbol: 'XAUUSD'`, `SYMBOL_RULES` |
| Valeurs relues depuis les octets conservés : le parseur doit rendre `bid` / `ask` | `rawValue` (`evidence_archive.ts`) ; `RAW_PAYLOAD_MISMATCH` sinon |
| Carnet non inversé : `ask < bid` fait abstenir MP-1 | `BOOK_INVERTED` (`as_of_snapshot.ts`) |
| Une série de capture déclarée pour `bid` et `ask` | `CAPTURE_SERIES` : aucune aujourd'hui, d'où `CAPTURABLE_FIELDS` sans bid/ask |

Aucun parseur actuel ne fournit `bid` / `ask` : FRED et Twelve Data les
laissent `null` (`providers.ts`).

## 2. Exigences de provenance

1. Octets bruts de chaque réponse conservables tels quels (contrat de
   stockage brut, `XAU_V2_DATA_3_RAW_STORAGE_CONTRACT.md`).
2. Un horodatage de cotation fourni par la source, distinct de l'instant de
   réception ; bid et ask d'un même instant (sinon le carnet n'est pas
   cohérent au cutoff).
3. L'identité de la cotation : courtier ou place, instrument exact (or
   comptant contre USD, pas un contrat à terme), et nature de la cotation
   (indicative, exécutable, agrégée).
4. Les règles de révision ou de correction des cotations, s'il y en a.
5. Une fréquence de cotation documentée par la source, sans qu'aucun seuil
   ne soit déduit ici.

## 3. Exigences de licence (à revoir par un humain)

- Droit de conserver les réponses brutes et de les relire hors ligne.
- Droit d'usage interne pour l'analyse ; conditions de redistribution, y
  compris dans des rapports.
- Durée de conservation autorisée.
- Coût et compte requis ; aucun engagement sans décision.

## 4. Candidats (tous À VÉRIFIER, aucun fait vérifié ici)

| Candidat | Ce qu'il faudrait vérifier | Limite déjà connue |
| --- | --- | --- |
| OANDA v20 (déjà noté dans `XAU_V2_DATA_REAL.md`) | disponibilité de XAU_USD, horodatage bid/ask, conditions de conservation et de redistribution | cotations d'un courtier, pas un carnet de marché ; compte requis |
| Flux d'un courtier ou d'une banque (FIX, API) | contrat, nature exécutable ou indicative, licence | compte et contrat requis |
| Fournisseur de données de marché sous licence | couverture XAU comptant, horodatage, prix | payant |

Ne conviennent pas : le prix de l'or LBMA (une enchère quotidienne, sans bid
ni ask), et un prix « last » sans carnet (Twelve Data aujourd'hui).

## 5. Ce qui reste à décider

1. Le choix d'une source, avec la revue de sa licence (achat ou ouverture de
   compte : décision humaine).
2. Si la cotation est indicative, l'accepter ou non pour VERIFIED.
3. L'ajout d'une série dans `CAPTURE_SERIES` et d'un parseur, avec ses tests
   de relecture depuis les octets, une fois la source choisie.
