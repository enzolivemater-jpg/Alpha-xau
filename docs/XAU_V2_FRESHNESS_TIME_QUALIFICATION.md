# XAU V2 — Qualification temporelle de la fraîcheur (A-C2, A-C3)

Statut : correctifs locaux, non publiés, non intégrés. Aucune migration n'est
appliquée à un environnement existant. HOLD / FORBIDDEN partout ; VERIFIED
n'est pas assoupli ; REC-1 gelé.

## 1. Audit des calculs avant correction (tête `9bf0df8`, comme `1e483ee`)

La règle de seuil est commune : `classifyFreshness(ageSeconds, rule)` rend
`UNAVAILABLE` si `age > staleMaxAgeS`, `STALE` si `age > liveMaxAgeS`, sinon
`LIVE`. L'égalité reste dans la classe inférieure. Seuils inchangés
(`SYMBOL_RULES`) : XAUUSD 360 s / 3 j ; US10Y, US10YR, VIX, WTI 36 h / 6 j.
Ce qui diffère, c'est l'âge qu'on lui donne.

| Chemin | Instants lus | Conversion | Unité, arrondi | Seuil franchi à |
| --- | --- | --- | --- | --- |
| MP-1 (`as_of_snapshot.ts`) puis replay DATA-1 (`evidence_archive.ts`) et CHAIN-0 (`dry_run.ts`) | `observedAt`, cutoff (ISO strict, ns) | `Date.parse` (ms), `Math.floor(Δms / 1000)` | secondes, plancher | seuil + 1 000 ms |
| Ingestion (`validate.ts`, `validatePoint`) | `observedAt` (ns), horloge `now` (ms) | `Math.round(Δms / 1000)` | secondes, arrondi au plus proche (0,5 vers +∞) | seuil + 500 ms |
| Lecture runtime (`context.ts`) via `v_market_latest` | `ts` (µs), `now()` de la transaction | `EXTRACT(EPOCH FROM (now() - ts))::INTEGER` | secondes, arrondi au plus proche (0,5 loin de zéro) | seuil + 500 ms |
| Garde anti-futur, ingestion | idem ingestion | `Math.round` puis `< -300` | secondes arrondies | rejet à partir de -300,5 s, plus loin d'1 ms |
| Garde anti-futur, SQL (`chk_market_ticks_no_future`) | `ts`, `created_at` (µs) | `ts <= created_at + 5 min` | exacte | 5 min + 1 µs |
| Badge du terminal V1 (`dashboard.js`) | `staleness_seconds` | `<= STALE_THRESHOLD_S` (60 s) | secondes arrondies par la vue | affichage seul, règle propre au badge |

Conséquences mesurées (tests de ce lot, PostgreSQL 17.6 compris) :

- entre seuil + 500 ms et seuil + 999 ms, le runtime retirait une valeur que
  le replay servait encore (A-C3) ;
- entre seuil + 1 ms et seuil + 499 ms, les deux la servaient à tort (A-C2) ;
- une observation 300,4 s dans le futur passait la garde applicative, puis la
  contrainte SQL la refusait à l'insertion ;
- la vue arrondissait `-0,4 s` à `0`, que MP-0 acceptait comme âge cohérent.

## 2. Correction

Les horodatages restent la seule source de vérité. Toute décision compare la
durée exacte avant tout arrondi ; l'arrondi ne sert plus qu'à l'affichage.

- `classifyFreshnessExact(ageNanos, rule)` : même règle et mêmes seuils, sur
  l'âge exact en nanosecondes (BigInt).
- **A-C2**, `fix/a-c2-millisecond-freshness` = `9073acd7ae8f61f0df702c23d0b3eccf1f662297`.
  Replay 1.3.0 et CHAIN-0 1.1.0 : âge = cutoff − `observedAt`, en
  nanosecondes. MP-1 est inchangé.
- **A-C3**, `fix/a-c3-exact-runtime-staleness`, sur A-C2 :
  - ingestion : âge = `now` (ms) − `observedAt` (ns), exact ; la garde
    anti-futur devient le miroir exact de la contrainte SQL (égalité acceptée) ;
  - vue : la migration `20261026120000_market_latest_exact_staleness` ajoute
    `staleness_us BIGINT`, calculé exactement à partir de `ts` et `now()` ;
  - lecture runtime : la décision se fait sur `staleness_us` seulement. Une
    valeur absente, non entière ou mal formée rend le champ `UNAVAILABLE`, sans
    jamais se rabattre sur `staleness_seconds` ni lire 0.
- Âge entier rapporté par tous les chemins : secondes entières écoulées
  (plancher). Un âge négatif reste négatif.

## 3. Compatibilité des consommateurs d'âges entiers

| Consommateur | Attend | Après correction | Compatibilité |
| --- | --- | --- | --- |
| `v_market_latest.staleness_seconds` (navigateur, runbook, tests DB) | entier arrondi | inchangé : même nom, type, position et expression | préservée |
| `v_market_latest` : colonnes, droits, `security_invoker` | — | une colonne ajoutée en dernier ; droits et options identiques (prouvé sur PG 17.6) | additive |
| Badge V1 `dashboard.js` | `staleness_seconds` | inchangé ; sa règle de 60 s est un affichage, pas une décision | préservée, hors périmètre |
| `MarketField.ageSeconds` (MP-0, comité `stalenessSeconds`) | entier ≥ 0 pour être cohérent | entier, plancher de l'âge exact (avant : arrondi). Une valeur peut avoir 1 s de moins, jamais une classe plus fraîche | entier préservé ; écart d'affichage d'au plus 1 s |
| MP-0 `fieldIsCoherent` (âge ≥ 0) | refuse un âge négatif | une ligne datée après l'horloge de la base, même de 1 µs, a un âge négatif, donc `INVALID_FIELD_CONTRACT`. Avant : seulement au-delà de -0,5 s | **durcissement**, jamais un assouplissement |
| `ValidatedDataPoint.ageSeconds` (ingestion) | entier ≥ 0 | plancher de l'âge exact, borné à 0 ; non persisté | préservé |
| `buildField(value, ageSeconds, …)` exporté | âge entier | inchangé (API entière, utilisé par le test d'égalité runtime) ; `buildSnapshot` utilise `buildFieldExact` | préservé |
| `ageSecondsAtCutoff` du replay, `ageSeconds` de CHAIN-0 | entier | inchangés (plancher) | préservés |
| Messages de rejet d'ingestion | texte libre | âge en ms exactes ; « trop ancienne » et « futur » conservés | préservés pour les tests existants |

Changements versionnés explicitement :

- replay `market-evidence-replay-1.3.0` (A-C2) ;
- CHAIN-0 `decision-chain-dry-run-1.1.0` (A-C2) : le condensat de référence
  passe de `9bbd9cac…` à `919b602e…`, uniquement à cause de la version ;
- contrat de lecture `v_market_latest` : migration horodatée additive (A-C3).

La lecture runtime exige `staleness_us`. **Ordre de déploiement** : migration,
puis code. **Retour arrière** : code, puis
`database/rollbacks/20261026120000_market_latest_exact_staleness.down.sql`.

Un code A-C3 lisant une base non migrée échoue fermé : PostgREST refuse la
colonne inconnue, donc `DATA_UNAVAILABLE`, sans valeur servie. Le script de
retour arrière recrée la vue (on ne peut pas retirer une colonne d'une vue).
Il restaure les droits un par un, options de transmission comprises, ainsi que
le commentaire et `security_invoker`. Il s'interrompt sans rien changer si un
objet dépend de la vue. L'OID de la vue change, et son propriétaire devient le
rôle qui exécute le script (le même que pour le schéma).

## 4. Preuves (reproductibles)

```
node node_modules/typescript/bin/tsc --noEmit
node scripts/run_ci_tests.mjs                      # inclut tests/test_freshness_edge_matrix.mjs
node tests/test_freshness_edge_matrix.mjs           # 240 cellules : 5 symboles × 2 seuils × 6 décalages × 4 chemins
PGDATABASE=xau_market_rls_test node tests/test_market_latest_exact_staleness_postgres.mjs   # PG 17.6 jetable
```

Décalages autour de chaque seuil : -1 ms, égalité, +1 ms, +499 ms, +500 ms et
+999 ms. S'y ajoutent +1 ns (ingestion, replay, CHAIN-0) et +1 µs (vue SQL).

Autres contrôles :

- fuseaux horaires `Z`, `+02:00`, `-05:00` et quatre fuseaux de session SQL ;
- horodatages invalides : date impossible, sans zone, `-00:00`, plus de 9
  décimales, `NULL` ;
- `staleness_us` illisible (null, vide, décimal, hexadécimal, exposant, NaN,
  Infinity) ;
- garde anti-futur exacte (5 min accepté, 5 min + 1 ns ou 1 µs refusé) ;
- aucune anticipation : une observation 1 ms après le cutoff n'est jamais
  utilisée ;
- migration additive, rejouable et réversible, sur une vue reconstituée et sur
  le `schema.sql` déployé.

## 5. Risques restants

- La migration n'est appliquée nulle part. Son effet sur PostgREST en
  production n'est pas testé (rechargement du cache de schéma, latence).
- `now()` est l'instant de début de transaction côté base, et l'horloge
  d'ingestion est celle du Worker. Les deux âges restent exacts, mais par
  rapport à deux horloges différentes : aucune synchronisation n'est démontrée.
- Le badge V1 garde sa règle de 60 s sur l'entier arrondi : c'est un affichage,
  pas une décision.
- `test_market_cycle_live` et `test_assembly_http` (exemptés : ils exigent
  `su postgres` et un serveur sur le port 5433) ont été mis à jour, mais pas
  exécutés ici.
- MP-0 refuse désormais toute ligne datée après l'horloge de la base, même de
  quelques microsecondes. Si l'horloge du fournisseur avance réellement, MP-0
  s'abstiendra plus souvent. C'est un durcissement à surveiller.
