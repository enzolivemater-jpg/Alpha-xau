# XAU V2 — DATA-4 : continuité de collecte et preuve de couverture

Statut : **PREPARATION LOCALE / CI UNIQUEMENT / NON CONNECTE AU RUNTIME**.
Aucune collecte réseau, migration, activation de méthode, connexion courtier ou
action production n'est autorisée par cette étape.

## Versions gelées (DATA-4A)

- `CAPTURE_CONTINUITY_SCHEMA_VERSION` : `xau.capture-continuity.v1`.
- `CAPTURE_CONTINUITY_ALGORITHM_VERSION` : `capture-continuity-receipt-audit-1.0.0`.

## Contexte et autorité

- DATA-1 \`evidence_archive.ts\` reste **l'unique contrat d'archive et de rejeu**.
- DATA-2 / DATA-3 \`evidence_capture.ts\` restent **l'unique logique de capture et fusion**.
- MP-2 \`market_pricing_observations\` reste le contrat de persistance des
  valeurs/revisions ; son RPC est complet-ou-erreur mais **ne prouve pas**
  à lui seul la présence de toutes les réponses fournisseur attendues.
- ARCH-CLOSE-2 #140 rassemble les contrats TIME-0 / EVIDENCE-0 / UI-0 /
  TR-0 / OBS-0 sans remplacement de la chaîne CHAIN-0.
- Les cinq séries déjà capturées localement ne prouvent pas un journal
  continu. Les données hors dépôt ne sont pas incluses dans les tests CI.

## Règle centrale : trois preuves différentes

1. **Reponse authentique** : attribution à FRED ou Twelve Data, réponse
   brute non modifiée et identifiant de série vérifiable. Un SHA-256 seul
   détecte une altération mais n'authentifie pas le producteur.
2. **Complétude des tentatives** : un plan gouverné décrit chaque créneau
   prévu et un journal immuable rend compte de *chaque* tentative, réussite
   comme échec. Une absence, un retard, un quota HTTP 429 ou un timeout
   n'est jamais masqué par la dernière valeur disponible.
3. **Couverture des donnees marche** : dépend de la fraîcheur des observations
   et de l'absence de lacunes pertinentes dans **chaque champ requis**,
   pas de la simple réussite HTTP ou de la présence de cinq flux.

Aucune de ces preuves n'implique automatiquement les deux autres.

## DATA-4A — audit pur des créneaux déclarés

\`backend/market_engine/capture_continuity.ts\` reçoit un **plan explicite**
(\`planId\`, \`windowStart\`, \`windowEnd\`, \`slots\`) et des **reçus explicites**
(\`slotId\`, \`receivedAt\`, \`outcome\`, \`rawPayloadDigest\`).

Chaque slot spécifie sa série depuis le registre DATA-2 \`CAPTURE_SERIES\`,
sa première heure permise et son échéance. L'audit ne choisit **jamais**
lui-même une cadence et ne lit ni horloge, ni réseau, ni base de données.
Il refuse les horaires non valides, les identités inconnues et les
doublons de reçus. Il ignore toute réponse reçue après le cutoff pour le
rejeu as-of, puis détecte les tentatives manquantes, tardives et échouées.

Son état \`ATTEMPTS_RECORDED\` signifie **uniquement** que tous les slots
déclarés de la fenêtre clôturée ont été enregistrés avant leur échéance.
Ce n'est **pas** une attestation de l'exhaustivité du plan : le plan peut
avoir omis des créneaux, des jours ou un fournisseur. Tous les résultats
exposent donc inconditionnellement :

- \`providerAuthenticity: NOT_PROVEN\` ;
- \`archiveCoverage: NOT_ESTABLISHED\` ;
- \`decision: HOLD\`, \`execution: FORBIDDEN\`.

Le module n'est pas relié au runtime, à MP-0, au terminal ou à un scheduler.

## DATA-4B — collecteur continu (non implémenté / Human Gate)

Une fois l'accès fournisseur, les quotas, les droits de conservation et
le calendrier approuvés :

- Déclarer et figer une **politique par série**, calendrier de jours fériés,
  créneaux et échéances. Les quatre séries FRED sont quotidiennes :
  ne pas extrapoler leur date d'observation minuit UTC en heure réelle de
  publication. Le spot Twelve Data suit un calendrier et une cadence
  distincts. Ne jamais inférer une observation de la réussite HTTP.
- Pour chaque slot, consigner même les échecs. Capturer la réponse brute
  exactement une fois et la lier à une identité fournisseur/série, une heure
  de réception attestée et une empreinte ; garder les révisions en ajout seul.
- Empêcher la divulgation des clés dans les URLs, erreurs, journaux et
  archives ; imposer confidentialité, permissions minimales, chiffrement
  au repos, sauvegarde et règles de conservation contractuelles.
- Différencier le calendrier *prévu*, le résultat de la requête, la validité
  des octets, l'observation source et sa fraîcheur au cutoff.
- Rejouer à partir de reçus persistés et d'archives complètes-ou-erreur,
  avec comparaison des entrées sources et des manifestes.
- Tester désynchronisation d'horloge, trous réseau, doublons, corrections
  tardives, HTTP 429, changement de format et arrêt/reprise du collecteur.

Aucun appel fournisseur ni stockage production n'est lancé par DATA-4A.

## DATA-4C — stockage futur (étude, non migré)

Préférence architecturale : **table dédiée** d'artefacts de prix et reçus
append-only, reliée aux sources et aux observations MP-2, plutôt que
d'élargir \`official_source_artifacts\` dont le contrat est limité à
l'événement BLS CPI. C'est une **recommandation**, pas un schéma approuvé.

La conception doit encore expliciter : identités/idempotence, séparation
corps brut/métadonnées, horodatage serveur, relations référentielles,
RLS, grants, indices, quotas, contrôle d'accès, rétention et purge
contractuelle compatible avec l'immuabilité logique. Un brouillon SQL
et des tests PostgreSQL éphémères pourront être préparés, **sans apply**.

## Obstacles institutionnels et gates

- Une capture manuelle marquée \`CAPTURED\` est une attestation d'opérateur,
  pas une preuve cryptographique du transport ou de la source.
- Le statut DATA-1 \`VERIFIED\` exige actuellement la couverture de **tous**
  les champs \`spot/bid/ask/dxy/us10y/realYield/vix/wti\`. Le fournisseur
  Twelve Data utilisé ne fournit pas bid/ask et DXY n'a pas de source
  opérationnelle approuvée. On **ne doit pas** renseigner les champs
  manquants fictivement ou changer discrètement la sémantique de VERIFIED.
  Toute définition future d'une couverture *par périmètre* exige un
  contrat versionné distinct et ses tests.
- Aucun changement MP-0, aucune élévation de \`HISTORICAL_UNVERIFIED\`,
  aucune autorisation BUY/SELL et aucun effet sur REC-1.
- Préparation de schéma, autorisation réseau, fournisseur/plan, migration,
  déploiement et levée du gel de main demeurent des décisions distinctes.

## Acceptation DATA-4A

1. CI/test/typecheck sur le **même commit**, y compris inventaire de tests.
2. Cas de non-régression : plan vide, mauvaise série, duplicata, fenêtre
   inachevée, trou de réception, échec, retard, horodatage futur et
   cutoff antérieur à une correction.
3. Aucun chemin de code réseau/secret/horloge/DB ou d'exécution trading.
4. Les statuts d'audit ne peuvent pas produire la confiance \`VERIFIED\`
   ou \`LIVE\` du marché, ni autoriser un ordre ou une alerte directionnelle.
