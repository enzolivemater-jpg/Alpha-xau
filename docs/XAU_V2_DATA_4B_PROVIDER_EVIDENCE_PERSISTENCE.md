# XAU V2 — DATA-4B : stockage des preuves de collecte (proposition non déployée)

Statut : **DRAFT PR / CI POSTGRESQL ÉPHÉMÈRE / NO MAIN / NO PRODUCTION**.

## Décision architecturale proposée

Conserver DATA-1 (archives), DATA-2/3 (capture et fusion), DATA-4A
(audit de tentatives) et MP-2 (observations as-of) comme contrats canoniques.
La preuve des requêtes fournisseurs nécessite une extension de persistance,
sans modifier \`official_source_artifacts\`, dédiée à BLS CPI.

Un brouillon SQL figure dans
\`database/migrations/20261015225000_market_provider_capture_evidence.sql\`.
**La présence du fichier en migration ne signifie ni approbation ni application.**
La CI l'exécute seulement sur PostgreSQL 17.6 éphémère.

Deux tables sont proposées :

1. \`market_provider_responses\` : réponse brute \`BYTEA\`, paire source
   fournisseur/série/symbole, SHA-256 généré par PostgreSQL, heure de
   réception déclarée et heure de première connaissance en base.
   La déduplication des octets est limitée à la même identité source.
2. \`market_capture_attempt_receipts\` : plan/slot déclaré, série,
   \`CAPTURED\` ou \`FAILED\`, réponse liée seulement en cas de succès,
   code d'échec fermé (sans URL ou texte libre), heure du collecteur
   et heure de première connaissance en base.

L'identité \`plan_id + slot_id\` est unique et les deux tables sont en
ajout seul. Une clé composite garantit que la réponse référencée
appartient à la série annoncée. Une fonction d'écriture invoker insère
réponse et reçu en une seule transaction ; un rejeu identique restitue
le même reçu, une divergence échoue. Les reçus sont lisibles **as-of**
par une RPC à borne explicite, complète-ou-erreur, ordonnée.

## Sécurité et limites

- RLS activé sans policy client ; aucun SELECT/INSERT par \`anon\`
  ou \`authenticated\`. \`service_role\` limité à SELECT et INSERT par
  colonnes ; UPDATE/DELETE interdits par privilèges et triggers.
- Fonctions \`SECURITY INVOKER\` avec \`search_path\` vide.
- \`recorded_at\` est généré par PostgreSQL, non écrit par l'appelant ;
  il gouverne le cutoff historique. \`source_received_at\` est un fait
  revendiqué par le collecteur, jamais assimilé à la date de publication.
- Aucun secret, URL avec clé ou corps d'erreur libre n'est prévu dans
  la structure. **Le contenu brut lui-même peut contenir une donnée sensible** :
  une étape de collecte doit refuser tout corps contenant un secret
  avant stockage ; le schéma ne peut l'attester à lui seul.
- La contrainte sur les cinq couples source/série/symbole doit être
  synchronisée explicitement avec \`CAPTURE_SERIES\`.
- Un reçu \`CAPTURED\` signifie qu'un corps est lié, **pas** qu'il est
  correctement parsé ou authentifié par un tiers.
- Une RPC atomique réussie ne prouve ni plan exhaustif, ni collecte
  continue, ni couverture DATA-1 \`VERIFIED\`. Le fournisseur peut
  renvoyer les mêmes anciennes observations lors de multiples appels.
- Rétention, sauvegarde chiffrée, surveillance de quota, prix/licences,
  droits contractuels, gestion des secrets et suppression conforme
  devront être approuvés avant toute activation réelle.

## Preuves requises et frontières restantes

La CI prouve sur une base PostgreSQL jetable :
exactitude des octets, SHA-256, idempotence, révisions d'identité,
échecs explicites, slot divergent, série incompatible, horodatages,
rejet des updates/deletes, RLS/grants, RPC invoker et lecture bornée.

Les **données FRED/Twelve Data déjà capturées restent locales** et ne
sont jamais embarquées dans le dépôt GitHub ni la CI.

La couche d'adaptation DATA-4A vers la RPC et la collecte régulière
ne sont **pas implémentées**. Ni \`main\`, ni Supabase en production,
ni le runtime de collecte, ni MP-0/CHAIN-0 ne sont modifiés.

**Human Gates** : droits fournisseur et conservation, plan/quotas,
accès aux secrets, migration en environnement autorisé, raccordement
runtime, preuve de couverture, levée du gel de production et méthodes
métier. Toutes restent séparément bloquées.

Décision sûre tant que ces gates ne sont pas levées :
**HOLD / FORBIDDEN**.
