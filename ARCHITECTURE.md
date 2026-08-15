# ALPHA-XAU INSTITUTIONAL TERMINAL — Architecture repository

Monorepo. Frontend statique (GitHub Pages) + backend serverless (Workers/Vercel) + PostgreSQL managé (Supabase).
Règle structurante : **le frontend ne parle jamais à un provider externe**. Toute donnée transite par un moteur backend qui normalise, score et persiste. Le terminal ne lit que la base.

```
alpha-xau/
│
├── frontend/                        # Déployé tel quel sur GitHub Pages (branche gh-pages)
│   ├── index.html                   # Shell du terminal, une seule page
│   ├── assets/
│   │   ├── css/
│   │   │   ├── tokens.css           # Design tokens (couleurs, échelles typo, densité)
│   │   │   ├── layout.css           # Grille du terminal (panneaux redimensionnables)
│   │   │   └── components.css
│   │   ├── fonts/
│   │   └── icons/
│   ├── js/
│   │   ├── core/
│   │   │   ├── api.js               # Client REST unique (Supabase PostgREST + Workers)
│   │   │   ├── store.js             # État applicatif observable, sans framework
│   │   │   ├── realtime.js          # WebSocket Supabase Realtime + fallback polling
│   │   │   ├── router.js            # Routage par hash (compatible GitHub Pages)
│   │   │   └── formatters.js        # Formatage prix/pips/heures, une seule source
│   │   ├── modules/
│   │   │   ├── market-panel.js
│   │   │   ├── news-feed.js
│   │   │   ├── ai-scenarios.js      # Rendu H1..H4
│   │   │   ├── risk-panel.js
│   │   │   ├── scorecard.js
│   │   │   └── alerts-panel.js
│   │   └── charts/
│   │       └── candlestick.js       # Canvas 2D, aucune dépendance externe
│   ├── sw.js                        # Service Worker : PWA, cache offline du dernier état
│   └── manifest.webmanifest
│
├── backend/                         # TypeScript, cible Cloudflare Workers / Vercel Functions
│   ├── src/
│   │   ├── api/                     # Handlers HTTP (une route = un fichier)
│   │   │   ├── market.ts
│   │   │   ├── news.ts
│   │   │   ├── analysis.ts
│   │   │   ├── alerts.ts
│   │   │   └── health.ts
│   │   ├── jobs/                    # Cron triggers (ingestion, scoring, évaluation)
│   │   │   ├── ingest-market.ts
│   │   │   ├── ingest-news.ts
│   │   │   ├── run-analysis.ts
│   │   │   ├── evaluate-model.ts
│   │   │   └── rotate-partitions.ts
│   │   ├── lib/
│   │   │   ├── db.ts                # Pool Postgres / client Supabase (service_role)
│   │   │   ├── cache.ts             # KV / Edge Cache, TTL par type de donnée
│   │   │   ├── rate-limiter.ts      # Token bucket par provider
│   │   │   ├── circuit-breaker.ts   # Coupe un provider dégradé, bascule sur fallback
│   │   │   ├── logger.ts            # Logs structurés JSON
│   │   │   └── errors.ts
│   │   ├── middleware/              # CORS, auth, validation de payload, idempotence
│   │   └── types/                   # Types partagés, générés depuis le schéma SQL
│   ├── wrangler.toml
│   ├── vercel.json
│   └── tsconfig.json
│
├── database/                        # Source de vérité du modèle de données
│   ├── schema.sql                   # DDL complet (ce fichier)
│   ├── migrations/                  # Migrations versionnées, jamais d'édition rétroactive
│   │   └── 0001_init.sql
│   ├── seeds/                       # Référentiels instruments et sources
│   ├── policies/                    # RLS isolées pour revue de sécurité indépendante
│   ├── functions/                   # Fonctions PL/pgSQL et RPC exposées via PostgREST
│   └── maintenance/                 # Rotation de partitions, VACUUM, rétention
│
├── ai_engine/                       # Couche de décision — isolée du transport HTTP
│   ├── src/
│   │   ├── regime/                  # Classification du régime de marché
│   │   ├── scenarios/               # Génération H1..H4 (direction, cible, invalidation)
│   │   ├── calibration/             # Calibration des probabilités (Platt / isotonique)
│   │   ├── prompts/                 # Prompts versionnés = artefacts reproductibles
│   │   ├── features/                # Feature engineering depuis market_ticks + news
│   │   └── evaluation/              # Backtest et alimentation de performance_scorecard
│   └── models/                      # Registre des versions de modèle (model_version)
│
├── news_engine/                     # Ingestion et scoring éditorial
│   ├── src/
│   │   ├── collectors/              # Un connecteur par source (GDELT, Finnhub, RSS…)
│   │   ├── normalizers/             # Formats hétérogènes → schéma news_events unique
│   │   ├── dedup/                   # Déduplication inter-agrégateurs
│   │   ├── scoring/                 # macro / volatilité / surprise / fiabilité / durée
│   │   ├── sentiment/               # NLP → sentiment [-1..+1]
│   │   └── classifier/              # Impact directionnel sur XAUUSD
│   └── config/
│       └── sources.json             # Sources, poids, quotas
│
├── market_engine/                   # Prix et contexte macro
│   ├── src/
│   │   ├── providers/               # Adaptateurs providers derrière une interface commune
│   │   ├── aggregator/              # Consensus multi-sources, arbitrage de divergence
│   │   ├── validators/              # Anti-spike, contrôle de fraîcheur, garde OHLC
│   │   ├── macro/                   # DXY, US10Y, rendement réel, VIX, WTI
│   │   └── indicators/              # ATR, pivots, VWAP, volatilité réalisée
│   └── config/
│       └── providers.json           # Priorité et ordre de fallback
│
├── risk_engine/                     # Traduction d'un signal en risque exploitable
│   ├── src/
│   │   ├── position-sizing/         # Sizing par risque fixe et par volatilité
│   │   ├── volatility/              # ATR, régimes de volatilité, stops adaptatifs
│   │   ├── correlation/             # Corrélations XAU vs DXY / rendements réels / VIX
│   │   ├── exposure/                # Exposition agrégée, plafonds
│   │   └── stress/                  # Scénarios de choc, drawdown théorique
│   └── config/
│       └── risk-limits.json         # Limites dures, hors code
│
├── alerts/                          # Détection, déduplication, routage des notifications
│   ├── src/
│   │   ├── rules/                   # Règles déclaratives → colonne alerts.trigger
│   │   ├── evaluator/               # Évaluation continue des règles
│   │   ├── dispatcher/              # Cycle de vie pending → triggered → resolved
│   │   ├── channels/                # Web Push, e-mail, webhook
│   │   └── throttling/              # Anti-spam, fenêtres de silence
│   └── config/
│       └── rules.json
│
├── tests/
│   ├── unit/                        # Scoring, sizing, formules — déterministe
│   ├── integration/                 # Moteurs contre une base éphémère
│   ├── database/                    # Contraintes, triggers, policies RLS
│   ├── e2e/                         # Parcours terminal complet
│   ├── fixtures/                    # Jeux de données figés
│   └── load/                        # Charge d'ingestion, latence de lecture
│
├── documentation/
│   ├── architecture/                # ADR : décisions et alternatives écartées
│   ├── api/                         # Contrat OpenAPI
│   ├── database/                    # Dictionnaire de données, diagramme ER
│   ├── engines/                     # Spécification de chaque moteur et de ses formules
│   ├── runbooks/                    # Procédures d'incident (source morte, drift modèle)
│   └── security/                    # Modèle RLS, gestion des secrets
│
├── .github/workflows/               # CI : lint, tests, migration, déploiement Pages
├── scripts/                         # Outils locaux (génération de types, backfill)
├── .env.example                     # Noms de variables uniquement, jamais de valeurs
└── README.md
```

## Justification par dossier

| Dossier | Raison technique |
|---|---|
| `frontend/` | Artefact 100 % statique, sans build : contrainte GitHub Pages. Aucun secret, aucune clé provider — uniquement la clé `anon` Supabase protégée par RLS. |
| `backend/` | Frontière HTTP unique. Détient les secrets, le rate limiting et le cache. Les moteurs restent des bibliothèques pures, testables hors runtime serverless. |
| `database/` | Le schéma est la source de vérité, pas un ORM. Contraintes, scoring et RLS en base : un bug applicatif ne peut pas corrompre l'historique. |
| `ai_engine/` | Isolé pour être versionnable et backtestable. `model_version` est stocké sur chaque analyse : toute prédiction reste rattachable à son code. |
| `news_engine/` | Ingestion hétérogène et instable (quotas GDELT, RSS morts). L'isolement empêche qu'une source défaillante n'affecte les prix ou l'IA. |
| `market_engine/` | Priorité absolue à la fraîcheur et à la validité du prix. Multi-provider avec fallback : aucune source unique n'est un point de défaillance. |
| `risk_engine/` | Un signal directionnel sans dimensionnement n'est pas exploitable. Séparé de l'IA car ses règles sont déterministes et auditables. |
| `alerts/` | La logique de déduplication et de throttling est transverse à tous les moteurs ; la centraliser évite le bruit et les notifications dupliquées. |
| `tests/` | Un terminal financier qui ment est pire qu'un terminal en panne. Les tests base de données valident les contraintes qui protègent l'intégrité. |
| `documentation/` | Les ADR et runbooks conservent le raisonnement derrière les pondérations et les procédures d'incident, hors de la mémoire du développeur. |
