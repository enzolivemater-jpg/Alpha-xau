# ALPHA-XAU — RUNBOOK DE DÉPLOIEMENT STAGING

Procédure à exécuter **sur votre machine** (réseau sortant ouvert, clés en main).
Chaque valeur ci-dessous a été **relue dans le code**, pas supposée.

**Comment procéder :** exécutez une étape, collez-moi la sortie réelle, je diagnostique
avant de passer à la suivante. Les étapes marquées ⏸ **STOP** exigent votre intervention.

**Convention de statut :** ✅ obtenu / ❌ écart → me le signaler sans corriger vous-même.

---

## 1. INVENTAIRE DES VARIABLES (dérivé du code)

### 1. Secrets Cloudflare Worker

| Variable | Lue par | Oblig. | Valeur attendue | Risque si absente |
|---|---|---|---|---|
| `SUPABASE_URL` | market, news, ai | **oui** | `https://<ref>.supabase.co` | Aucun moteur ne démarre |
| `SUPABASE_SERVICE_ROLE_KEY` | market, news, ai | **oui** | JWT `service_role` Supabase | Aucune écriture possible |
| `ANTHROPIC_API_KEY` | ai_engine | **oui** | `sk-ant-…` | Comité inopérant |
| `COMMITTEE_TOKEN` | ai_engine | **oui** | 64 hex générés | `/committee` refuse tout (401) |
| `INGEST_TOKEN` | news_engine | **oui** | 64 hex générés | `/news` refuse tout (401) |
| `FRED_API_KEY` | market_engine | **oui** | 32 car. FRED | US10Y, Real Yield, VIX, WTI → `UNAVAILABLE` |
| `TWELVE_DATA_KEY` | market_engine | **oui** | clé Twelve Data | DXY → `UNAVAILABLE` (aucune substitution) |
| `NEWSAPI_KEY` | news_engine | non | clé NewsAPI | Collecteur désactivé, GDELT seul |
| `AI_ENGINE_TOKEN` | news_engine | **oui** | **= `COMMITTEE_TOKEN`** | 401 sur chaque notification |

### 2. Credentials CI/CD

| Variable | Usage | Où |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `wrangler deploy` non interactif | environnement shell |
| `CLOUDFLARE_ACCOUNT_ID` | idem | environnement shell |

### 3. Variables publiques GitHub Pages

| Variable | Valeur | Où |
|---|---|---|
| `ALPHA_XAU_SUPABASE_URL` | `https://<ref>.supabase.co` | GitHub → Settings → **Variables** |
| `ALPHA_XAU_SUPABASE_ANON_KEY` | JWT **anon** uniquement | idem |

> Ce sont des **Variables**, pas des Secrets : elles finissent dans le HTML public.
> La clé `anon` est publique par conception, bornée par RLS.

### 4. Variables optionnelles

`LOG_LEVEL` (=`info`), `GDELT_TIMESPAN` (=`60min`) — dans `wrangler.toml [vars]`.
`MODEL_ANALYST`, `MODEL_COMMITTEE`, `STOOQ_BASE_URL`, `FRED_BASE_URL`,
`TWELVE_DATA_BASE_URL` — surcharges de test, valeurs par défaut dans le code.

### 5. Variable dérivée après déploiement

| Variable | Valeur exacte | Vérifié dans le code |
|---|---|---|
| `AI_ENGINE_URL` | `https://<URL_WORKER>/committee` | `ingest.ts:1727` appelle `fetch(env.AI_ENGINE_URL)` **sans ajouter de chemin** ; `worker.ts:120` route sur `path.startsWith('/committee')`. Le suffixe `/committee` est donc **obligatoire dans la variable**. |

---

## 2. PRÉREQUIS — à préparer avant de commencer

| Élément | Action | Source |
|---|---|---|
| Compte Cloudflare | créer | cloudflare.com |
| `CLOUDFLARE_API_TOKEN` | **copier** — modèle « Edit Cloudflare Workers » | dash → My Profile → API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | **copier** | dash → Workers & Pages (colonne droite) |
| Projet Supabase | créer (région proche) | supabase.com |
| `SUPABASE_URL` + `SERVICE_ROLE_KEY` + `ANON_KEY` | **copier** | Project Settings → API |
| `ANTHROPIC_API_KEY` | **copier** | console.anthropic.com |
| `FRED_API_KEY` | **copier** (gratuit) | fred.stlouisfed.org/docs/api/api_key.html |
| `TWELVE_DATA_KEY` | **copier** (gratuit, 800 req/j) | twelvedata.com |
| `NEWSAPI_KEY` | **copier** (optionnel) | newsapi.org |
| Compte + dépôt GitHub | créer, **public** (Pages gratuit) | github.com |

**Tokens à générer localement :**

```bash
openssl rand -hex 32   # -> COMMITTEE_TOKEN
```

- `INGEST_TOKEN` : générer une **seconde** valeur, **différente** de `COMMITTEE_TOKEN`.
- `AI_ENGINE_TOKEN` : **strictement identique** à `COMMITTEE_TOKEN` — ce sont les deux
  extrémités du même canal (`ingest.ts` émet `Bearer <AI_ENGINE_TOKEN>`,
  `committee_orchestrator.ts:1924` compare à `COMMITTEE_TOKEN`).

Conservez ces valeurs dans un gestionnaire de mots de passe. **Ne les collez jamais
dans un fichier du dépôt ni dans une conversation.**

---

## 3. VÉRIFICATION DE L'ENVIRONNEMENT LOCAL

```bash
cd <chemin-vers-alpha-xau>
node --version      # attendu >= 20
npm --version
git --version
npx wrangler --version
pwd && ls wrangler.toml backend/worker.ts database/schema.sql
```

⏸ **STOP si** `ls` échoue : vous n'êtes pas dans le dépôt ALPHA-XAU. Ne continuez pas.

---

## 4. GIT / GITHUB

```bash
# 1. Créer le dépôt sur github.com (public, SANS README ni .gitignore)

# 2. Initialiser si nécessaire
git init -b main

# 3. VÉRIFIER que .gitignore protège les secrets AVANT tout add
cat .gitignore | head -20

# 4. Garde anti-fuite AVANT le push
bash tests/test_pages_secret_guard.sh   # attendu : 8 lignes OK, exit 0

# 5. Vérifier qu'aucun secret n'est indexé
git add -A && git status --short | grep -E "\.env$|\.dev\.vars" && echo "STOP" || echo "OK"

# 6. Commit et push
git commit -m "ALPHA-XAU Institutional Terminal — staging"
git remote add origin https://github.com/<user>/<repo>.git
git remote -v
git push -u origin main
```

⏸ **STOP si** l'étape 4 ou 5 signale quoi que ce soit.

---

## 5. SUPABASE — MIGRATIONS

**Ordre réel des fichiers du dépôt** (vérifié : il n'y a **pas** de `0001`,
`schema.sql` en tient lieu) :

| # | Fichier | Objectif |
|---|---|---|
| 0 | `database/schema.sql` | 21 tables, enums, fonctions, triggers, RLS, vues de base |
| 1 | `0002_align_news_scoring.sql` | Formule §22, 3 tiers, `ingestion_runs` |
| 2 | `0003_news_notification_tracking.sql` | Suivi des notifications + sweep |
| 3 | `0004_job_concurrency_guard.sql` | Verrou anti-concurrence + `fn_reclaim_stale_runs` |
| 4 | `0005_committee_events.sql` | `ai_events` (idempotence) |
| 5 | `0006_committee_contract.sql` | Verdicts, `activation_condition`, `overall_bias`, `v_ai_latest` |
| 6 | `0007_legacy_scenarios_non_tradable.sql` | `is_tradable` + vue finale |

**Procédure** — Supabase → SQL Editor → New query. Coller **un fichier à la fois**,
dans cet ordre, exécuter, vérifier « Success ». **Ne jamais sauter un fichier.**

⏸ **STOP en cas d'erreur SQL** : copiez le message exact et le nom du fichier.

### Requêtes de contrôle post-migration

```sql
-- 1. Tables (attendu : 21+)
SELECT count(*) FROM information_schema.tables
 WHERE table_schema='public' AND table_type='BASE TABLE';

-- 2. Tables clés présentes
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public'
   AND table_name IN ('market_ticks','news_events','ai_events','ai_analyses',
                      'ai_scenarios','ai_analysis_news','ingestion_runs','alerts')
 ORDER BY 1;   -- attendu : 8 lignes

-- 3. Enums du contrat
SELECT t.typname, string_agg(e.enumlabel,',' ORDER BY e.enumsortorder)
  FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
 WHERE t.typname IN ('risk_verdict_t','execution_status_t','committee_event_t')
 GROUP BY 1;
-- attendu risk_verdict_t : APPROVED,APPROVED_WITH_CONDITIONS,REJECTED,
--                          DATA_INSUFFICIENT,CONFLICT

-- 4. Fonctions
SELECT proname FROM pg_proc
 WHERE proname IN ('fn_news_score','fn_reclaim_stale_runs') ORDER BY 1;

-- 5. Parité de la formule (attendu exactement 71.00)
SELECT fn_news_score(80,60,90,70,50) AS doit_valoir_71;

-- 6. Verrou anti-concurrence
SELECT indexname FROM pg_indexes WHERE indexname='uq_ingestion_runs_active';

-- 7. CONTRAT FRONTEND : 19 colonnes exactement
SELECT count(*) AS doit_valoir_19 FROM information_schema.columns
 WHERE table_name='v_ai_latest';

-- 8. RLS actif
SELECT relname, relrowsecurity FROM pg_class
 WHERE relname IN ('market_ticks','news_events','ai_events','ai_analyses','ai_scenarios');
-- attendu : relrowsecurity = true partout

-- 9. Permissions anon
SELECT c.relname, has_table_privilege('anon', c.oid, 'SELECT') AS anon_peut_lire
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('v_ai_latest','v_market_latest',
       'v_news_high_impact','ai_events','v_news_actionable')
 ORDER BY 1;
-- ATTENDU : v_ai_latest=true, v_market_latest=true, v_news_high_impact=true
--           ai_events=FALSE, v_news_actionable=FALSE
```

⏸ **STOP si** le contrôle 9 montre `ai_events = true` → fuite de données privées.

---

## 6. CLOUDFLARE — PREMIER DÉPLOIEMENT RÉEL

```bash
npx wrangler login          # interactif ; sinon : export CLOUDFLARE_API_TOKEN=...
npx wrangler whoami         # doit afficher votre compte
npx wrangler deploy         # LE VRAI déploiement (pas --dry-run)
```

**Attendu :**
```
Total Upload: ~153 KiB / gzip: ~44 KiB
Uploaded alpha-xau (X sec)
Deployed alpha-xau triggers (Y sec)
  https://alpha-xau.<votre-sous-domaine>.workers.dev
  schedule: */2 * * * *
  schedule: */15 * * * *
  schedule: 0 * * * *
Current Version ID: <uuid>
```

⏸ **STOP — notez l'URL exacte.** Collez-moi la sortie complète.

---

## 7. SECRETS WORKER

Chaque commande demande la valeur **de façon interactive** — ne la mettez jamais
sur la ligne de commande (elle resterait dans l'historique shell).

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put COMMITTEE_TOKEN
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put FRED_API_KEY
npx wrangler secret put TWELVE_DATA_KEY
npx wrangler secret put NEWSAPI_KEY          # si vous en avez une

npx wrangler secret list                      # vérifie les NOMS, jamais les valeurs
```

---

## 8. SECONDE PASSE — `AI_ENGINE_URL`

```bash
npx wrangler secret put AI_ENGINE_URL
# valeur EXACTE : https://alpha-xau.<sous-domaine>.workers.dev/committee
#                                                            ^^^^^^^^^^ obligatoire

npx wrangler secret put AI_ENGINE_TOKEN
# valeur : STRICTEMENT la même que COMMITTEE_TOKEN

npx wrangler deploy          # second déploiement pour charger les secrets
```

---

## 9. HEALTH CHECK

```bash
export W=https://alpha-xau.<sous-domaine>.workers.dev
curl -i $W/health
```

**Attendu :** `HTTP/2 200`, corps :
```json
{"status":"ok","jobs":["*/2 * * * *","*/15 * * * *","0 * * * *"]}
```

---

## 10. AUTHENTIFICATION DES ENDPOINTS

```bash
curl -s -o /dev/null -w "GET  /committee    -> %{http_code}\n" $W/committee
curl -s -o /dev/null -w "POST /committee    -> %{http_code}\n" -X POST $W/committee
curl -s -o /dev/null -w "POST /news         -> %{http_code}\n" -X POST $W/news
curl -s -o /dev/null -w "route inconnue     -> %{http_code}\n" $W/inconnu

# Mauvais token (doit rester 401)
curl -s -o /dev/null -w "POST mauvais token -> %{http_code}\n" \
     -X POST $W/committee -H "x-committee-token: mauvais"
```

**Attendu :** `405`, `401`, `401`, `404`, `401`.
Aucun appel LLM n'est émis avant authentification (vérifié dans le code).

---

## 11. INGESTION MARCHÉ RÉELLE

```bash
# Déclenchement manuel du news engine (le market tourne au cron */2)
curl -i -X POST $W/news -H "x-ingest-token: <INGEST_TOKEN>"
```

Puis attendez **2 minutes** (premier cron marché) et vérifiez dans Supabase.
⚠️ La colonne temporelle s'appelle **`ts`**, pas `time` :

```sql
SELECT symbol, close, bid, ask, spread, dxy_value, us10y_yield,
       real_yield, vix, wti, source, ts
  FROM market_ticks ORDER BY ts DESC LIMIT 20;

-- Vue lue par le comité
SELECT symbol, close, real_yield, dxy_value, staleness_seconds FROM v_market_latest;

-- Contrôles d'intégrité
SELECT count(*) AS zeros_suspects FROM market_ticks WHERE close = 0;          -- 0
SELECT count(*) AS futurs FROM market_ticks WHERE ts > now() + interval '5 min'; -- 0
SELECT status, persisted_count, rejected_count, providers, errors
  FROM ingestion_runs WHERE engine='market_engine' ORDER BY started_at DESC LIMIT 3;
```

**Symboles réellement configurés dans le code** (à confronter au réel) :

| Instrument | Provider | Identifiant | Statut actuel |
|---|---|---|---|
| XAUUSD | Stooq | `xauusd` | **UNVERIFIED** |
| DXY | Twelve Data | `DXY` | **UNVERIFIED** |
| US10Y | FRED | `DGS10` | **UNVERIFIED** |
| Real Yield | FRED | `DFII10` | **UNVERIFIED** |
| VIX | FRED | `VIXCLS` | **UNVERIFIED** |
| WTI | FRED | `DCOILWTICO` | **UNVERIFIED** |

⏸ **C'est ici que le premier vrai FAIL est probable.** Si un instrument est absent
de `v_market_latest`, collez-moi la ligne `providers` de `ingestion_runs` : elle
contient le motif exact de rejet. Ne modifiez pas le code vous-même.

---

## 12. NEWS RÉELLES

```sql
SELECT title, source, news_score, classification, gold_direction_impact, ts
  FROM news_events ORDER BY ts DESC LIMIT 20;

-- Répartition selon les seuils RÉELS du code (>=80 critical, >=60 major, <60 noise)
SELECT classification, count(*), round(min(news_score),2), round(max(news_score),2)
  FROM news_events GROUP BY 1;

-- Doublons (doit renvoyer 0 ligne)
SELECT dedup_key, count(*) FROM news_events GROUP BY 1 HAVING count(*) > 1;
```

---

## 13. EVENT-DRIVEN + COMITÉ RÉEL

Le comité tourne au cron horaire, et immédiatement sur événement CATALYST.
Pour forcer un cycle :

```bash
curl -i -X POST $W/committee -H "x-committee-token: <COMMITTEE_TOKEN>"
```

**Ce cycle appelle réellement les 5 agents** (`macro_analyst`,
`geopolitical_analyst`, `technical_analyst`, `risk_committee`,
`portfolio_manager`) et consomme des tokens Anthropic.

```sql
-- Décision produite
SELECT id, risk_verdict, execution_status, overall_bias, regime_confidence,
       model_version, analysis_ts, valid_until
  FROM ai_analyses ORDER BY analysis_ts DESC LIMIT 3;

-- Scénarios : les 4 horizons, activation et tradabilité
SELECT horizon, direction, probability, target, invalidation,
       left(activation_condition, 60) AS activation, is_tradable, confidence
  FROM ai_scenarios
 WHERE analysis_id = (SELECT id FROM ai_analyses ORDER BY analysis_ts DESC LIMIT 1)
 ORDER BY horizon;
-- ATTENDU : 4 lignes, somme(probability) = 1.0000, activation_condition non vide

-- Événements event-driven
SELECT event_id, event_type, status, news_score, analysis_id, duration_ms
  FROM ai_events ORDER BY received_at DESC LIMIT 5;
```

**Test d'idempotence** — relancez la même commande `curl` immédiatement :
un second comité doit renvoyer `ALREADY_RUNNING` (verrou), et un événement
déjà traité `ALREADY_PROCESSED`, **sans second appel LLM**.

---

## 14. GITHUB PAGES

1. GitHub → repo → Settings → **Pages** → Source : **GitHub Actions**
2. Settings → Secrets and variables → Actions → onglet **Variables** → New :
   - `ALPHA_XAU_SUPABASE_URL`
   - `ALPHA_XAU_SUPABASE_ANON_KEY` ← **clé anon uniquement**
3. Actions → « Deploy terminal to GitHub Pages » → Run workflow

**Vérifier dans les logs :** `Configuration injectée.` puis
`Aucun secret détecté dans le contenu publiable de frontend/.`

⏸ **STOP si** le job échoue sur le garde : une clé serveur a failli être publiée.
Collez-moi le message `::error::`.

### Scan du build réellement publié

```bash
export P=https://<user>.github.io/<repo>
curl -s $P/ -o /tmp/pub.html
curl -s $P/js/dashboard.js -o /tmp/pub.js

# 1. Aucun JWT de rôle autre qu'anon
python3 - <<'PY'
import base64,json,re
for f in ['/tmp/pub.html','/tmp/pub.js']:
    for t in re.findall(r'eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{5,}', open(f).read()):
        p=t.split('.')[1]; p+='='*(-len(p)%4)
        try: role=json.loads(base64.urlsafe_b64decode(p)).get('role')
        except Exception: role='INDECODABLE'
        print(f, 'role =', role, '<-- FUITE' if role!='anon' else 'OK')
PY

# 2. Autres secrets
grep -c "sk-ant-\|SERVICE_ROLE\|COMMITTEE_TOKEN\|INGEST_TOKEN\|FRED_API_KEY" /tmp/pub.html /tmp/pub.js
```

**Attendu :** `role = anon` uniquement, et `0` partout au grep.
⏸ **STOP IMMÉDIAT si** un autre rôle apparaît → **révoquez la clé sur-le-champ**
(Supabase → Settings → API → Reset service_role key) avant toute autre action.

---

## 15. TEST UTILISATEUR

Ouvrez `$P` et vérifiez :

| Panneau | Attendu |
|---|---|
| Command Center | XAUUSD réel, biais IA, conviction + grade, régime, statut exécution |
| Macro Matrix | DXY, US10Y, Real Yield, VIX, WTI — `N/A` si indisponible, **jamais 0** |
| News Stream | titres réels, score /100, classification, impact or |
| Scenario Tree | H1–H4, direction, probabilité, target, **HARD STOP**, **ACTIVATION**, R:R |
| Barre haute | `LIVE` (vert) et non `DÉMO` |
| Pied | verdict de risque en clair |

**Contrôle critique :** si `execution_status` est NULL en base, l'écran doit
afficher **STATUT INCONNU** — jamais `SETUP VALIDE`.

Si le bandeau `MODE DÉMO` apparaît : les GitHub Variables ne sont pas injectées.

---

## 16. CRONS

Cloudflare dash → Workers & Pages → `alpha-xau` → Settings → **Triggers** :
les 3 expressions doivent apparaître.

```bash
npx wrangler tail --format pretty     # laisser tourner ~3 min
```

Attendu : un log JSON `{"level":"info","job":"market_engine","message":"STARTED"}`
puis `SUCCESS` ou `PARTIAL`, toutes les 2 minutes.

```sql
SELECT engine, status, started_at, finished_at, duration_ms, persisted_count
  FROM ingestion_runs ORDER BY started_at DESC LIMIT 10;
SELECT count(*) AS verrous_bloques FROM ingestion_runs WHERE status='running'
   AND started_at < now() - interval '20 minutes';   -- attendu : 0
```

---

## 17. DÉGRADATION

| Test | Manipulation | Attendu |
|---|---|---|
| Provider indisponible | `npx wrangler secret delete TWELVE_DATA_KEY` puis attendre 2 min | `dxy_value` NULL, terminal `N/A`, **jamais 0** |
| Anthropic indisponible | poser une `ANTHROPIC_API_KEY` invalide, forcer `/committee` | `ai_events.status='FAILED'`, verrou libéré |
| Token invalide | `curl -X POST $W/committee -H "x-committee-token: faux"` | 401, aucun événement en base |
| Event invalide | `curl -X POST $W/committee -H "x-committee-token: <TOKEN>" -H "content-type: application/json" -d '{"event_type":"INCONNU"}'` | 400 `INVALID_EVENT`, aucun appel LLM |
| PostgREST indisponible | couper le réseau du navigateur | bandeau incident, `FLUX ROMPU`, **pas de mode démo** |

**Restaurez les secrets après ces tests.**

---

## 18. TRAÇABILITÉ

```sql
SELECT n.id AS news_id, n.title, n.news_score, n.classification,
       e.event_id, e.event_type, e.status AS event_status,
       a.id AS analysis_id, a.risk_verdict, a.overall_bias,
       count(s.id) AS scenarios
  FROM news_events n
  LEFT JOIN ai_events e   ON e.news_event_id = n.id
  LEFT JOIN ai_analyses a ON a.id = e.analysis_id
  LEFT JOIN ai_scenarios s ON s.analysis_id = a.id
 WHERE n.classification IN ('critical','major')
 GROUP BY n.id, n.title, n.news_score, n.classification,
          e.event_id, e.event_type, e.status, a.id, a.risk_verdict, a.overall_bias
 ORDER BY n.ts DESC LIMIT 5;
```

Lacune connue et **non corrigée** (P2 assumé) : aucun lien
`ingestion_runs.id → ai_analyses.id`. La corrélation passe par le `run_id`
présent dans les logs `wrangler tail`.

---

## 19. RÉGRESSION FINALE

```bash
npx tsc --strict --noEmit                     # attendu : aucune sortie
bash tests/test_pages_secret_guard.sh         # attendu : 8 OK, exit 0
npx wrangler deploy --dry-run                 # bundle intact
```

---

## 20. GRILLE À ME RETOURNER

| # | Contrôle | Résultat |
|---|---|---|
| 1 | Migrations 0002→0007 appliquées | |
| 2 | `v_ai_latest` = 19 colonnes | |
| 3 | `anon` : `v_ai_latest` oui / `ai_events` non | |
| 4 | `fn_news_score(80,60,90,70,50)` = 71.00 | |
| 5 | `wrangler deploy` : URL + Version ID | |
| 6 | `/health` = 200 | |
| 7 | 405 / 401 / 401 / 404 | |
| 8 | XAUUSD présent dans `market_ticks` | |
| 9 | DXY, US10Y, Real Yield, VIX, WTI présents ou motif de rejet | |
| 10 | News réelles avec score + classification | |
| 11 | Cycle comité réel : verdict + `overall_bias` | |
| 12 | 4 scénarios, somme probabilités = 1.0000 | |
| 13 | `activation_condition` non vide sur les 4 | |
| 14 | Idempotence : `ALREADY_PROCESSED` | |
| 15 | Pages publié, URL accessible | |
| 16 | Scan du build : `role = anon` uniquement | |
| 17 | Terminal affiche données réelles (pas démo) | |
| 18 | Crons déclenchés (`wrangler tail`) | |
| 19 | Verrous libérés (0 bloqué) | |
| 20 | Modes dégradés distincts | |

**20/20 → STAGING VERIFIED.** Toute case en échec : collez-moi la sortie brute,
je diagnostique et corrige au minimum, avec régression complète.

---

## COÛT ET SÉCURITÉ

- Anthropic : 5 appels LLM par cycle de comité. Cron horaire = 120 appels/jour,
  plus les CATALYST. **Posez une limite de dépense** sur la console Anthropic avant
  de lancer.
- FRED et Twelve Data : gratuits (Twelve Data : 800 req/jour, le cron `*/2` en
  consomme ~720 — surveillez le quota).
- En cas de doute sur une fuite de clé : **révoquez d'abord, diagnostiquez ensuite.**
