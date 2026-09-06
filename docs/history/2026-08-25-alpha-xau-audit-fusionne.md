# Historical snapshot — 2026-08-25

> This document preserves an audit/work-session snapshot from
> 2026-08-25. Some findings, blockers, SHAs, deployment states and
> implementation gaps described below have since been resolved.
> It is retained for historical traceability and MUST NOT be treated as
> the current operational source of truth for XAU V2.

# ALPHA-XAU — Audit & Architecture Cible (Document fusionné)

> Ce document fusionne : (1) la gouvernance "terminal professionnel" (fiabilité,
> traçabilité, testing), (2) l'architecture Chantier 8 déjà verrouillée
> (event clustering, scoring découplé, sortie multi-dimensionnelle), et
> (3) le backlog déjà connu du projet, pour éviter toute re-découverte inutile.
>
> Référence transversale : voir `CLAUDE_HANDOFF.md` pour l'état de session précédent.

---

## 0. CONTEXTE DÉJÀ CONNU — NE PAS RE-AUDITER DEPUIS ZÉRO

Avant de commencer l'audit ci-dessous, prends connaissance de cet état déjà établi
(issu de sessions précédentes) pour ne pas dupliquer le travail de découverte :

**Bugs P1 déjà identifiés, non résolus :**
1. Doublon potentiel `ingest.ts` — vérifier si `backend/news_engine/ingest.ts`
   existe encore en double du `backend/ingest.ts` racine, et lequel `worker.ts`
   charge réellement.
2. GDELT timeout — fix préparé (timeout 20s, cron offset `7-59/15`) mais
   déploiement jamais confirmé.
3. WTI staleness — rejeté par validation (`649853s > 518400s`) à cause du lag
   de publication FRED, pas d'un échec de fetch. Calibration de seuil à revoir.
4. Scoring news — articles Treasury pertinents ingérés mais sous le seuil
   d'affichage (60 pts). Patch mineur déjà appliqué (surprise_score 25→40),
   jugé insuffisant — Chantier 8 est la solution structurelle.
5. Pollution sémantique `news_engine` — ingestion d'actualités hors macro/finance
   (ex: cinéma) observée en production.
6. `ai_committee` cron ne produit plus d'entrées `ingestion_runs` depuis le
   dernier déploiement. Worker `/health` liste bien les 3 crons, aucun lock
   bloquant détecté, `market_engine` et `news_engine` fonctionnent normalement.
   **Diagnostic bloqué par crédit API Anthropic épuisé.**
7. `NEWS_ANTHROPIC_API_KEY` ajoutée au code mais jamais posée comme secret
   Cloudflare — gap ouvert.
8. `.txt` orphelins confirmés morts : `risk_committee.txt`, `portfolio_manager.txt`.
9. Frontend jamais audité contre les vues SQL `v_*` réellement consommées par
   `dashboard.js`.
10. Statut de configuration Cloudflare Workers Builds inconnu.

**Décisions déjà verrouillées pour Chantier 8 (ne pas re-designer) :**
- Un événement macro = plusieurs articles regroupés (event clustering), pas
  une entrée par article.
- Scoring IA découplé du pipeline d'ingestion — jamais bloquant si l'API est
  indisponible.
- Sortie multi-dimensionnelle : magnitude, direction (peut être ambiguë),
  mécanismes de transmission macro, market pricing, horizon mappé H1-H5,
  confiance, traçabilité complète.
- Versioning des événements + protection de coût intégrés dès la conception.
- Grille d'horizons déjà à 5 niveaux : H1=1-2h, H2=4h, H3=24h, H4=7j, H5=30j.
  `SCOPE_HORIZONS` et `normalizeProbabilities` déjà corrigés pour 5 (piège
  connu : ne jamais recompter un hardcode sur 4).

**Historique d'incidents déjà résolus (pour référence, ne pas re-corriger) :**
- `status: 'success'` hardcodé dans des blocs `finally` masquait les échecs
  réels du comité (`ai_analyses` vide, `errors: []`) — corrigé.
- Dépréciation `temperature` et prefill assistant côté Anthropic API — gérées,
  parsing JSON adapté aux fences markdown.
- `MAX_TOKENS_COMMITTEE` régressé à 4000 en prod (doc: 8000) — corrigé à 10000.

**Ta première tâche est donc d'auditer ce qui reste réellement inconnu**,
pas de repartir de zéro sur des points déjà tranchés ci-dessus.

---

## 1. PRIORITÉ ABSOLUE : FIABILITÉ AVANT FONCTIONNALITÉS

Ne cherche jamais à simplement faire disparaître un bug ou à faire passer un test.

Pour chaque problème :
1. identifier la cause racine ;
2. vérifier son impact sur les autres composants ;
3. déterminer si le problème est local ou architectural ;
4. corriger la cause ;
5. vérifier les régressions ;
6. tester le flux complet ;
7. seulement ensuite considérer le chantier terminé.

Si tu découvres qu'une partie de l'architecture actuelle est mauvaise, dis-le
explicitement. Ne conserve jamais une mauvaise architecture simplement parce
qu'elle existe déjà.

---

## 2. NE JAMAIS CODER À L'AVEUGLE

Avant toute modification importante, inspecte le code réellement présent.
Identifie précisément : fichiers, fonctions, routes, tables, vues SQL, jobs
cron, variables d'environnement, flux de données, dépendances entre
composants, tests existants.

Ne suppose jamais qu'une fonction, une table ou un endpoint existe. Si une
information est nécessaire mais absente, demande-la. Ne fabrique jamais une
architecture hypothétique à partir d'un nom de fichier ou d'un ancien contexte.

---

## 3. ARCHITECTURE CIBLE

```
DATA SOURCES
  ↓
DATA VALIDATION
  ↓
NEWS / MARKET DATA
  ↓
MACRO EVENTS
  ↓
EVENT IMPACT
  ↓
MACRO TRANSMISSION
  ↓
H1–H5
  ↓
AI COMMITTEE
  ↓
PORTFOLIO MANAGER
  ↓
RISK COMMITTEE
  ↓
COMMAND CENTER
  ↓
SCENARIO TREE
  ↓
FRONTEND
```

Chaque étape doit avoir : une responsabilité claire, des données d'entrée
définies, des données de sortie définies, des règles de validation, une
gestion des erreurs, une traçabilité.

**Identifie les ruptures actuelles dans cette chaîne** — en tenant compte des
bugs déjà listés en section 0 (le cron `ai_committee` cassé est probablement
une rupture entre AI COMMITTEE et les étapes en aval, à confirmer).

---

## 4. NEWS INTELLIGENCE — MACRO EVENT ENGINE (Chantier 8)

```
ARTICLE → EVENT CLUSTER → EVENT IMPACT → GOLD TRANSMISSION → H1–H5 → COMMITTEE
```

Plusieurs articles parlant du même événement doivent être regroupés (décision
déjà verrouillée, voir section 0).

Le système doit distinguer : répétition, confirmation, détail supplémentaire,
nouvelle information, inversion/changement de scénario.

Il doit également distinguer nombre d'articles de nombre de sources
réellement indépendantes. Trois sites qui recopient la même dépêche ne
constituent pas trois confirmations indépendantes.

---

## 5. IMPACT GOLD — NE PAS CONFONDRE IMPORTANCE ET DIRECTION

Pour chaque événement important, déterminer séparément : magnitude,
direction XAUUSD, confiance, horizon, degré de pricing, mécanismes de
transmission.

Exemple valide :
```
Impact : 95/100
Direction : ambiguë
Confiance : 72/100
```

Ne force jamais une direction bullish/bearish lorsque le mécanisme est
réellement contradictoire.

---

## 6. ANALYSE MACROÉCONOMIQUE

L'IA doit raisonner à travers les mécanismes de transmission, par exemple :

```
NEWS → inflation expectations → Fed expectations → US yields → real yields → USD → XAUUSD
```
ou
```
GEOPOLITICAL SHOCK → risk-off → safe-haven demand → XAUUSD
```

mais elle doit également pouvoir identifier les mécanismes opposés. Une news
géopolitique ne doit jamais être automatiquement considérée comme haussière
pour l'or.

---

## 7. MARKET PRICING

Prendre en compte, lorsque les données sont disponibles : attentes du
marché, consensus, précédent, révisions, anticipations de taux, données de
marché, réaction déjà observée, contexte macro actuel.

Une information très importante mais déjà totalement pricée ne doit pas être
traitée comme un nouveau choc. Ne prétends jamais connaître une donnée qui
n'a pas été fournie.

---

## 8. H1–H5

Chaque horizon doit avoir sa propre évaluation de : probabilité, direction,
conviction, principaux drivers, risques, catalyseurs.

Une news peut être extrêmement importante en H1 et perdre fortement son
influence en H5. (Grille déjà à 5 niveaux — voir section 0, ne pas re-migrer.)

---

## 9. EVENT VERSIONING

Ne remplace pas simplement l'analyse précédente d'un événement — historise
toute évolution importante :

```
Event V1 → Impact 70 → Bullish → confiance 70
Event V2 → nouvelle information → Impact 45 → Bullish → confiance 60
Event V3 → escalade → Impact 90 → Bullish → confiance 88
```

On doit pouvoir comprendre pourquoi l'analyse a changé.

---

## 10. FALLBACK

L'IA doit être découplée de l'ingestion (déjà décidé, section 0). Si l'IA
tombe : les news continuent d'être collectées, les données restent stockées,
le système ne bloque pas, un fallback déterministe peut fonctionner, l'échec
est loggé, le système peut réessayer.

Le fallback ne doit jamais être présenté comme équivalent à l'analyse IA.
L'interface doit distinguer clairement : `DETERMINISTIC` / `AI` / `FINAL`.

---

## 11. RÉSILIENCE PRODUCTION

Gestion réelle des jobs : timeout, retry, backoff, lock avec expiration,
heartbeat, watchdog, détection des jobs zombies, idempotence, logs,
monitoring, récupération après panne.

Le blocage passé de `news_engine` pendant plusieurs jours (cause jamais
identifiée, résolu seul) reste un problème de fiabilité P1 tant que sa
protection contre récidive n'est pas établie. « Ça fonctionne maintenant »
n'est pas une résolution suffisante.

Le cron `ai_committee` actuellement cassé (section 0, point 6) relève de la
même catégorie de risque.

---

## 12. BUDGET IA

Avant de déployer massivement le nouveau moteur IA : limite horaire, limite
quotidienne, suivi tokens, suivi coût estimé, protection contre les boucles,
déduplication avant appel IA, cache lorsque pertinent, retry limité, logs de
consommation.

Une erreur logicielle ne doit jamais pouvoir générer une consommation
incontrôlée. (Prompt caching `cache_control: ephemeral` sur `CORE_RULES` déjà
identifié comme action prête à coder, section 0.)

---

## 13. DATA QUALITY

Toute donnée affichée doit avoir un état : `LIVE`, `FRESH`, `STALE`,
`MISSING`, `INVALID`, `UNVERIFIED`.

Un "N/A" ne doit jamais être silencieux. Lorsqu'une donnée critique manque,
le système doit savoir : pourquoi, depuis quand, quel composant est affecté,
si l'analyse doit être dégradée.

**Application directe au bug connu** : WTI et DXY affichent N/A — WTI est un
problème de calibration de seuil (staleness), DXY est un retrait permanent
et volontaire (symbole 404 chez Twelve Data, pas d'ETF proxy pour éviter une
fausse fraîcheur). Ces deux cas doivent utiliser des états différents
(`STALE` vs `NOT_APPLICABLE`/design volontaire), pas un même "N/A" opaque.

---

## 14. COMMAND CENTER

Le Command Center doit être le résultat de la chaîne analytique, pas un
affichage indépendant. Les éléments (XAUUSD, Bias IA, Conviction, Market
Regime, Execution Status, Dominant Drivers, Scenario Tree) doivent être
cohérents entre eux.

Éviter une situation où News = bullish, mais Macro Matrix = bearish, mais
Command Center = neutral, sans explication. En cas de conflit entre moteurs,
le système doit l'identifier et l'expliquer.

---

## 15. MACRO DRIVER MATRIX

Pour DXY, US10Y, Real Yield, VIX, WTI : distinguer `VALUE`, `CHANGE`,
`DIRECTION`, `FRESHNESS`, `IMPACT ON GOLD`, `CONFIDENCE`.

L'impact sur l'or ne doit pas être déterminé uniquement par une règle
statique — le système doit reconnaître les interactions entre drivers.

---

## 16. SCENARIO TREE

Le Scenario Tree doit découler de l'analyse actuelle, jamais d'une analyse
expirée ou inexistante. Chaque scénario devrait avoir : condition
d'activation, direction, probabilité, catalyseur, invalidation, horizon,
confiance.

Si aucune analyse fiable n'est disponible : `NO VALID SETUP` est préférable
à une analyse inventée.

---

## 17. TRAÇABILITÉ

```
COMMAND CENTER → COMMITTEE → EVENT IMPACT → EVENT → ARTICLE → SOURCE
```

Objectif : pouvoir répondre à « Pourquoi le terminal est-il bullish sur l'or
maintenant ? » avec une réponse traçable.

---

## 18. FRONTEND

Ne surcharge pas le terminal. Chaque donnée affichée doit avoir une utilité
décisionnelle et rester lisible rapidement.

Pour les news, afficher de manière compacte : importance, direction,
confiance, horizon, nombre de sources, mécanisme dominant, éventuellement
état du pricing. L'article doit être cliquable via `source_url`.

---

## 19. TESTING — 3 NIVEAUX

**Niveau 1 — Unit tests** : scoring, clustering, normalisation, mapping
H1-H5, validation JSON, fallback, déduplication, gestion des erreurs.

**Niveau 2 — Integration tests** :
```
NEWS → EVENT → IMPACT → H1-H5 → COMMITTEE → DATABASE → FRONTEND
```

**Niveau 3 — Production-like test** : vraie collecte, vraie réponse IA,
données de marché, news réelles, stockage, orchestration, affichage final.

Un test unitaire réussi ne signifie jamais que le système complet fonctionne.

---

## 20. TESTS DU CHANTIER 8 — MINIMUM

CPI très supérieur / légèrement supérieur / conforme aux attentes ; NFP très
supérieur / inférieur ; Fed hawkish / dovish ; événement géopolitique
(normal et ambigu) ; news sans chiffre ; news déjà pricée ; news
contradictoire ; articles dupliqués ; sources indépendantes vs sources qui
recopient la même dépêche ; information insuffisante ; panne IA ; réponse IA
invalide ; timeout ; retry ; évolution d'un événement existant ; inversion du
scénario.

Les tests doivent vérifier le raisonnement structurel, pas uniquement qu'une
fonction retourne un nombre.

---

## 21. AUDIT AVANT CODAGE — À LANCER EN PREMIER

Avant de coder quoi que ce soit, exécute ces vérifications concrètes et
rapporte les résultats bruts sans les interpréter prématurément :

```bash
grep -n "async function collectNewsApi\|function deduplicate\b" backend/ingest.ts
grep -n "v_news_actionable\|news.slice" backend/ai_engine/committee_orchestrator.ts
grep -n "news\|NEWS" frontend/js/dashboard.js | head -30
find backend -iname "ingest.ts"
grep -n "from '\./" backend/worker.ts | grep -i ingest
```

```sql
SELECT symbol, wti, ts, created_at
FROM market_ticks
WHERE symbol = 'XAUUSD'
ORDER BY created_at DESC
LIMIT 3;
```

Ne conclus rien sur ces points tant que les résultats réels n'ont pas été
vérifiés. Ceci répond aussi au point 1 du backlog (doublon `ingest.ts`).

---

## 22. ORDRE DE TRAVAIL OBLIGATOIRE

1. Audit complet (section 21 + croisement avec section 0).
2. Cartographie de l'architecture actuelle.
3. Identification des P0/P1/P2 (intègre explicitement le backlog section 0).
4. Architecture cible — écarts avec section 3.
5. Validation de l'architecture avec moi (STOP, attendre accord explicite).
6. Implémentation par petits lots.
7. Tests unitaires.
8. Tests d'intégration.
9. Audit de régression (résultats XAUUSD identiques sur fixtures existantes).
10. Validation production-like.
11. Déploiement.

Ne saute pas directement de l'audit au patch massif.

---

## 23. FORMAT DE RÉPONSE OBLIGATOIRE

Pour chaque chantier important :

```
ÉTAT AVANT — Ce qui existe réellement.
PROBLÈME — Cause racine.
IMPACT — Conséquence sur le terminal et l'analyse XAUUSD.
SOLUTION — Architecture retenue.
MODIFICATIONS — Fichiers + fonctions + DB + prompts concernés.
TESTS — Tests réalisés.
RÉSULTAT — PASS / FAIL / UNVERIFIED.
RISQUES RESTANTS — Ce qui n'est pas encore garanti.
```

Sois strict sur `UNVERIFIED`. Ne transforme jamais « je pense que ça
fonctionne » en « c'est corrigé ».

---

## 24. RÈGLE FONDAMENTALE

Le terminal doit répondre de manière fiable à :
- QU'EST-CE QUI BOUGE LE MARCHÉ DE L'OR ?
- POURQUOI ?
- DANS QUELLE DIRECTION ?
- AVEC QUELLE INTENSITÉ ?
- SUR QUEL HORIZON ?
- QU'EST-CE QUI POURRAIT INVALIDER CETTE ANALYSE ?
- QUELLES DONNÉES JUSTIFIENT CETTE CONCLUSION ?
- QUEL EST LE NIVEAU DE CONFIANCE ET QUELLES DONNÉES MANQUENT ?

Préférer `UNKNOWN` / `UNVERIFIED` / `NO VALID SETUP` à une fausse certitude.

---

## 25. STANDARD FINAL

Terminal professionnel d'intelligence macro XAUUSD avec : données fraîches
et vérifiables, architecture résiliente, intelligence événementielle,
analyse macro explicable, horizons H1-H5 cohérents, comité IA robuste,
gestion du risque, scénarios conditionnels, traçabilité complète, protection
contre les erreurs IA et les dérives de coût, tests automatisés, monitoring,
gestion des données manquantes, frontend cohérent avec le backend, aucun
score critique présenté comme fiable lorsqu'il ne l'est pas.

Optimiser pour la qualité de décision, pas pour le nombre de fonctionnalités.

---

## 26. LIMITES INSTITUTIONNELLES — CHANTIERS À TRAITER (PAS EN STAND-BY)

ALPHA-XAU est aujourd'hui un système d'**analyse et d'aide à la décision**
(le "pourquoi" et le "dans quelle direction"), pas un système de **gestion de
risque de portefeuille institutionnel** (le "combien risquer" et "quand
arrêter"). Ces six points doivent être traités, pas laissés en attente —
mais **séquentiellement**, jamais en parallèle sur plusieurs à la fois, et
chacun suit la méthodologie complète de la section 22 (audit → cartographie
→ P0/P1/P2 → architecture → validation explicite avec moi → implémentation
par petits lots → tests → régression).

**Ordre de traitement imposé** (du plus structurant au plus périphérique) :
1. section 26.1 (risque de portefeuille) — le plus fondamental, conditionne
   la crédibilité de tout le reste ;
2. section 26.6 (coûts de transaction Gold) — corrige un biais direct sur
   l'exploitabilité des scénarios déjà produits ;
3. section 26.4 (validation de robustesse dans la durée) — processus à
   mettre en place, pas un patch ponctuel ;
4. section 26.3 (redondance des données) — dépend de la disponibilité d'un
   fournisseur de secours réel, à vérifier avant de coder quoi que ce soit ;
5. section 26.5 (latence vs vitesse de marché) — instrumentation/mesure
   d'abord, décision d'architecture ensuite ;
6. section 26.2 (nature du comité IA) — le plus structurant à long terme,
   mais le plus coûteux à changer (implique une refonte de
   `committee_orchestrator.ts`) ; à traiter en dernier, une fois les 5
   autres stabilisés.

**Interdiction explicite** : ne pas commencer le point suivant avant que le
point en cours ait atteint le statut `PASS` (section 23) avec tests
réels, pas `UNVERIFIED`. Si un point bloque sur une information manquante
(ex: absence de fournisseur de données de secours accessible), le signaler
explicitement et proposer des options plutôt que d'improviser une solution.

**26.1 — Absence de couche gestion de risque de portefeuille**
Le système ne calcule ni sizing, ni exposition cumulée, ni corrélation entre
positions ouvertes, ni VaR, ni drawdown maximum. Le "Risk Committee" actuel
évalue le risque *de la thèse d'analyse*, pas le risque *du portefeuille réel*
de l'utilisateur. Ne jamais nommer un champ ou un statut de façon à laisser
penser que le système gère un risque de portefeuille qu'il ne gère pas.

**26.2 — Comité IA = une seule source, pas des voix indépendantes**
Le "Committee" est un LLM unique jouant plusieurs rôles en interne, pas
plusieurs analystes indépendants avec désaccords documentés et
responsabilité humaine distincte. Ne pas présenter la sortie comme un
consensus multi-source si ce n'est pas structurellement le cas.

**26.3 — Source de données unique (Twelve Data) sans redondance**
Aucun fournisseur de secours pour XAU/XAG. Si Twelve Data est en panne ou
retourne une donnée fausse, rien ne la contredit. Documenter ce risque de
point de défaillance unique ; ne pas le corriger maintenant sauf si un
fournisseur de secours gratuit/accessible est identifié plus tard.

**26.4 — Pas de validation de robustesse dans la durée**
Les tests unitaires/intégration (sections 19-20) ne remplacent pas une
période d'observation prolongée (walk-forward, plusieurs mois) avant de
faire confiance au système en conditions réelles. Le statut `EXPERIMENTAL`
(déjà imposé pour Silver Read-Through, section 11 de la spec associée) doit
s'appliquer par défaut à tout nouveau moteur de scoring/décision tant que
cette période n'est pas écoulée.

**26.5 — Latence d'analyse IA vs vitesse de marché**
Le temps de réponse du comité IA (plusieurs secondes) peut dépasser la
fenêtre d'opportunité réelle sur un événement macro à réaction rapide
(NFP, CPI surprise). Le système ne mesure ni n'affiche actuellement ce
délai. À terme, envisager un horodatage explicite "temps écoulé entre
publication et analyse disponible" affiché à l'utilisateur, pour qu'il
puisse juger lui-même si l'analyse arrive encore à temps.

**26.6 — Coûts de transaction absents des scénarios Gold**
Contrairement à Silver Read-Through (qui prévoit explicitement de bloquer
une opportunité si l'amplitude estimée est inférieure aux coûts attendus,
section 13 de sa spec), le raisonnement XAUUSD actuel n'intègre pas spread,
slippage ou funding dans ses scénarios. Un scénario "haussier, confiance 80%"
peut être correct sur la direction et pourtant non exploitable après coûts.

**Instruction pour toute session future** : si l'une de ces limites devient
bloquante pour une fonctionnalité demandée, le signaler explicitement avant
de coder plutôt que de la contourner silencieusement ou de la masquer
derrière une présentation qui suggère une couverture plus large que la
réalité.

---

## FILE D'ATTENTE COMPLÈTE — RIEN EN STAND-BY, TOUT SÉQUENCÉ

Rien de ce document n'est optionnel ou remis à "plus tard sans date". Tout
sera traité, dans cet ordre, un chantier à la fois, chacun validé (`PASS`
réel, pas `UNVERIFIED`) avant de passer au suivant :

**Phase A — Bugs P1 déjà connus (section 0)**, coût zéro, à traiter en premier :
doublon `ingest.ts` → GDELT → WTI staleness → scoring news → pollution
sémantique news_engine → nettoyage `.txt` orphelins → audit frontend/vues SQL
→ config Cloudflare Workers Builds.

**Phase B — Débloqué dès rétablissement du crédit API Anthropic** :
diagnostic `ai_committee` cron → pose du secret `NEWS_ANTHROPIC_API_KEY`.

**Phase C — Terminal professionnel (sections 1-25)** : audit complet
(section 21) → cartographie → P0/P1/P2 → architecture cible → validation →
implémentation Chantier 8 (event clustering, scoring découplé) par petits
lots → tests 3 niveaux → régression.

**Phase D — Limites institutionnelles (section 26)**, dans l'ordre imposé
26.1 → 26.6 → 26.4 → 26.3 → 26.5 → 26.2.

**Phase E — Silver Read-Through** (spec séparée `silver-read-through-spec.md`),
seulement une fois les phases A à D stabilisées, car ce module hérite des
mêmes limites (section 26) et du même moteur d'event clustering (Chantier 8).

---

## MAINTENANT — PREMIÈRE ACTION REQUISE

Ne commence pas par coder. Commence par la Phase A :

1. Exécuter les vérifications de la section 21 (grep + SQL) pour trancher le
   doublon `ingest.ts`.
2. Vérifier l'état réel de chaque point du backlog section 0.
3. Me présenter les résultats bruts, chantier par chantier, dans le format
   de la section 23.
4. Ne passer au chantier suivant de la Phase A qu'après mon accord explicite
   sur le précédent.

Je veux d'abord ton diagnostic complet sur le premier point (doublon
`ingest.ts`), avec les résultats bruts des commandes de la section 21.
**Aucun patch avant validation explicite de ma part, chantier par chantier.**
