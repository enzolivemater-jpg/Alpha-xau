/* ===========================================================================
   ALPHA-XAU INSTITUTIONAL TERMINAL
   frontend/js/dashboard.js

   JavaScript ES6 natif. Aucun framework, aucune dépendance, aucun build.
   Déployable tel quel sur GitHub Pages.

   ARCHITECTURE DE TRANSPORT :
     1. WebSocket Supabase Realtime — pousse les nouveaux ticks et news ;
     2. repli automatique en polling PostgREST si le WebSocket échoue ou si
        le navigateur ne le supporte pas ;
     3. bascule inverse dès qu'une reconnexion aboutit.

   Le terminal ne doit JAMAIS afficher une donnée périmée sans le signaler.
   Un écran figé qui a l'air vivant est plus dangereux qu'un écran vide :
   c'est le rôle du badge de fraîcheur et de l'indicateur de connexion.

   SÉCURITÉ (SPEC §60) : seule la clé anon Supabase circule ici, protégée
   par les policies RLS côté base. Aucun secret, aucun appel à un fournisseur
   externe, aucun calcul sensible côté client.
   =========================================================================== */

'use strict';

(() => {

  /* ======================================================================
     1. CONFIGURATION
     ====================================================================== */

  const CONFIG = Object.assign({
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    POLL_INTERVAL_MS: 5000,
    ANALYSIS_INTERVAL_MS: 60000,
    STALE_THRESHOLD_S: 60,
    V2_VIEW_URL: '',
    V2_SCENARIOS_URL: '',
  }, window.ALPHA_XAU_CONFIG || {});

  const RUNTIME = {
    /* Backoff de reconnexion WebSocket : 1s, 2s, 4s… plafonné à 30s. */
    WS_BACKOFF_BASE_MS: 1000,
    WS_BACKOFF_MAX_MS: 30000,
    WS_HEARTBEAT_MS: 25000,
    /* Au-delà, on cesse d'insister et on reste en polling. */
    WS_MAX_ATTEMPTS: 6,
    FETCH_TIMEOUT_MS: 10000,
    MAX_NEWS_ROWS: 60,
    TICK_FLASH_MS: 500,
    /* Nombre d'échecs consécutifs avant d'afficher le bandeau d'incident. */
    ERROR_TOLERANCE: 2,
  };

  /* Fenêtres des horizons — miroir de CONFIG.HORIZON_WINDOWS du backend. */
  const HORIZON_LABELS = {
    H1: '1-2H INTRADAY',
    H2: '4H',
    H3: '24H',
    H4: 'HEBDOMADAIRE',
    H5: 'STRUCTUREL',
  };
  const HORIZONS = ['H1', 'H2', 'H3', 'H4', 'H5'];

  /* P1-3 : les trois verdicts bloquants restent DISTINCTS à l'affichage.
     Les replier sur « rejeté » masquerait la cause réelle du blocage. */
  const BLOCKING_VERDICTS = ['REJECTED', 'DATA_INSUFFICIENT', 'CONFLICT'];

  const BLOCKING_TITLES = {
    REJECTED: 'NO VALID SETUP — ANALYSE REJETÉE',
    DATA_INSUFFICIENT: 'NO VALID SETUP — DONNÉES INSUFFISANTES',
    CONFLICT: 'NO VALID SETUP — CONFLIT ENTRE AGENTS',
  };

  const EXECUTION_LABELS = {
    VALID_SETUP: 'SETUP VALIDE',
    NO_VALID_SETUP: 'NO VALID SETUP',
    NO_DATA: 'AUCUNE ANALYSE',
  };

  const VERDICT_LABELS = {
    APPROVED: 'APPROUVÉ',
    APPROVED_WITH_CONDITIONS: 'APPROUVÉ SOUS CONDITIONS',
    REJECTED: 'REJETÉ',
    DATA_INSUFFICIENT: 'DONNÉES INSUFFISANTES',
    CONFLICT: 'CONFLIT',
  };

  const DEMO_MODE = !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY;

  /* ======================================================================
     2. ÉTAT
     ====================================================================== */

  const state = {
    spot: null,
    previousSpot: null,
    sessionOpen: null,      // premier prix observé, base du calcul de variation
    macro: {},
    previousMacro: {},
    news: [],
    seenNewsIds: new Set(),
    analysis: null,
    transport: 'init',      // init | websocket | polling | offline
    consecutiveErrors: 0,
    wsAttempts: 0,
  };

  /* ======================================================================
     3. UTILITAIRES DOM
     ====================================================================== */

  const $ = (id) => document.getElementById(id);

  const el = {
    connIndicator: $('conn-indicator'),
    connLabel: $('conn-label'),
    transportMode: $('transport-mode'),
    clock: $('clock-utc'),
    sessionLabel: $('session-label'),
    errorBanner: $('error-banner'),
    errorMessage: $('error-message'),
    errorRetry: $('error-retry'),

    spotPrice: $('spot-price'),
    spotChange: $('spot-change'),
    spotBid: $('spot-bid'),
    spotAsk: $('spot-ask'),
    spotSpread: $('spot-spread'),
    priceFreshness: $('price-freshness'),
    commandUpdated: $('command-updated'),

    aiBias: $('ai-bias'),
    convictionValue: $('conviction-value'),
    convictionGrade: $('conviction-grade'),
    convictionBar: $('conviction-bar'),
    marketRegime: $('market-regime'),
    executionStatus: $('execution-status'),
    driversList: $('drivers-list'),

    macroRows: $('macro-rows'),
    macroMeta: $('macro-meta'),

    newsStream: $('news-stream'),
    newsCount: $('news-count'),

    scenarioTree: $('scenario-tree'),
    scenarioMeta: $('scenario-meta'),
    noSetup: $('no-setup'),
    noSetupTitle: $('no-setup-title'),
    noSetupReason: $('no-setup-reason'),
    invalidationsList: $('invalidations-list'),

    modelVersion: $('model-version'),
    riskVerdict: $('risk-verdict'),
    analysisTime: $('analysis-time'),
    demoFlag: $('demo-flag'),

    tplNews: $('tpl-news-item'),
    tplScenario: $('tpl-scenario'),

    tabMarket: $('tab-market'),
    tabChain: $('tab-chain'),
    tabChainState: $('tab-chain-state'),
    wsMarket: $('ws-market'),
    wsChain: $('ws-chain'),
    modeV1: $('mode-v1'),
    modeV1Val: $('mode-v1-val'),
    modeV2: $('mode-v2'),
    modeV2Val: $('mode-v2-val'),

    v2Origin: $('v2-origin'),
    v2ScenarioWrap: $('v2-scenario-wrap'),
    v2Scenario: $('v2-scenario'),
    v2Status: $('v2-status'),
    v2State: $('v2-state'),
    v2Detail: $('v2-detail'),
    v2NavNature: $('v2-nav-nature'),
    v2Summary: $('v2-sec-summary'),
    v2SummaryHeadline: $('v2-summary-headline'),
    v2SummaryReasons: $('v2-summary-reasons'),
    v2SummaryMissing: $('v2-summary-missing'),
    v2SummaryDeps: $('v2-summary-deps'),
    v2StagesToggle: $('v2-stages-toggle'),
    v2Why: $('v2-why'),
    v2WhyLead: $('v2-why-lead'),
    v2WhyLift: $('v2-why-lift'),
    v2WhyList: $('v2-why-list'),
    v2ChainState: $('v2-chain-state'),
    v2Execution: $('v2-execution'),
    v2Integrity: $('v2-integrity'),
    v2Cutoff: $('v2-cutoff'),
    v2CutoffAge: $('v2-cutoff-age'),
    v2Digest: $('v2-digest'),
    v2Generated: $('v2-generated'),
    v2Stages: $('v2-stages'),
    v2Market: $('v2-market'),
    v2MarketState: $('v2-market-state'),
    v2Replay: $('v2-replay'),
    v2Positioning: $('v2-positioning'),
    v2PositioningThrough: $('v2-positioning-through'),
    v2PositioningSources: $('v2-positioning-sources'),
    v2Capabilities: $('v2-capabilities'),
    v2Mev: $('v2-mev'),
    v2MevStatus: $('v2-mev-status'),
    v2MevArchive: $('v2-mev-archive'),
    v2MevCoverage: $('v2-mev-coverage'),
    v2MevDigest: $('v2-mev-digest'),
    v2MevReplay: $('v2-mev-replay'),
    v2MevReasons: $('v2-mev-reasons'),
    v2MevAudit: $('v2-mev-audit'),
    v2MevObs: $('v2-mev-obs'),
    v2Horizons: $('v2-horizons'),
    v2Evidence: $('v2-evidence'),
    v2AcceptanceState: $('v2-acceptance-state'),
    v2Observability: $('v2-observability'),
    v2CapabilityCount: $('v2-capability-count'),
  };

  /** Écrit du texte sans jamais interpréter de HTML : les titres de news
   *  proviennent de sources externes et ne sont pas de confiance. */
  const setText = (node, value) => {
    if (node) node.textContent = value == null || value === '' ? '—' : String(value);
  };

  const setAttr = (node, name, value) => {
    if (!node) return;
    if (value == null) node.removeAttribute(name);
    else node.setAttribute(name, String(value));
  };

  /* ======================================================================
     4. FORMATAGE
     ====================================================================== */

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  const fmt = (value, decimals = 2) =>
    isNum(value) ? value.toFixed(decimals) : 'N/A';

  const fmtSigned = (value, decimals = 2) => {
    if (!isNum(value)) return 'N/A';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(decimals)}`;
  };

  const dirOf = (value) => {
    if (!isNum(value) || Math.abs(value) < 1e-9) return 'flat';
    return value > 0 ? 'up' : 'down';
  };

  const arrowOf = (value) => {
    const d = dirOf(value);
    return d === 'up' ? '▲' : d === 'down' ? '▼' : '—';
  };

  const fmtTimeUTC = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--';
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };

  /** Session de marché courante (SPEC §42), calculée en UTC. */
  const currentSession = (date = new Date()) => {
    const h = date.getUTCHours();
    if (h >= 0 && h < 7) return 'ASIE';
    if (h >= 7 && h < 12) return 'LONDRES';
    if (h >= 12 && h < 17) return 'LONDRES / NEW YORK';
    if (h >= 17 && h < 21) return 'NEW YORK';
    return 'HORS SESSION';
  };

  /** Classification de conviction — SPEC §34. */
  const convictionGrade = (score) => {
    if (!isNum(score)) return '—';
    if (score >= 85) return 'FORTE';
    if (score >= 65) return 'MOYENNE';
    if (score >= 40) return 'FAIBLE';
    return 'NO TRADE';
  };

  /* Impact directionnel d'un driver macro sur l'or. Ces relations sont le
     modèle de valorisation, pas une préférence d'affichage : un dollar qui
     monte et des taux réels qui montent pèsent sur l'or ; un VIX qui monte
     le soutient par la demande refuge. */
  const MACRO_IMPACT = {
    dxy:        { up: 'bearish', down: 'bullish', label: { bullish: 'Soutien', bearish: 'Pression' } },
    us10y:      { up: 'bearish', down: 'bullish', label: { bullish: 'Soutien', bearish: 'Pression' } },
    real_yield: { up: 'bearish', down: 'bullish', label: { bullish: 'Soutien fort', bearish: 'Pression forte' } },
    vix:        { up: 'bullish', down: 'bearish', label: { bullish: 'Demande refuge', bearish: 'Appétit risque' } },
    wti:        { up: 'bullish', down: 'bearish', label: { bullish: 'Canal inflation', bearish: 'Désinflation' } },
  };

  /* ======================================================================
     5. COUCHE RÉSEAU
     ====================================================================== */

  const restUrl = (path) => `${CONFIG.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${path}`;

  /** GET PostgREST avec timeout. Toute erreur remonte : la gestion se fait
   *  au niveau du cycle de rafraîchissement, pas ici. */
  async function fetchJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUNTIME.FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(restUrl(path), {
        headers: {
          apikey: CONFIG.SUPABASE_ANON_KEY,
          authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} sur ${path.split('?')[0]}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ======================================================================
     6. RENDU — COMMAND CENTER
     ====================================================================== */

  function renderQuote(tick) {
    if (!tick) return;

    const price = tick.close;
    if (!isNum(price)) return;

    state.previousSpot = state.spot;
    state.spot = price;
    if (state.sessionOpen === null) state.sessionOpen = price;

    setText(el.spotPrice, fmt(price, 2));

    /* Flash directionnel : signale le sens du tick sans détourner l'œil. */
    if (isNum(state.previousSpot) && state.previousSpot !== price) {
      const cls = price > state.previousSpot ? 'tick-up' : 'tick-down';
      el.spotPrice.classList.remove('tick-up', 'tick-down');
      /* Reflow forcé : sans lui, deux ticks consécutifs dans le même sens
         ne rejoueraient pas la transition. */
      void el.spotPrice.offsetWidth;
      el.spotPrice.classList.add(cls);
      setTimeout(() => el.spotPrice.classList.remove(cls), RUNTIME.TICK_FLASH_MS);
    }

    const change = price - state.sessionOpen;
    const changePct = state.sessionOpen ? (change / state.sessionOpen) * 100 : 0;
    setText(el.spotChange, `${fmtSigned(change, 2)}  ${fmtSigned(changePct, 2)}%`);
    setAttr(el.spotChange, 'data-dir', dirOf(change));

    setText(el.spotBid, fmt(tick.bid, 2));
    setText(el.spotAsk, fmt(tick.ask, 2));
    setText(el.spotSpread, isNum(tick.spread) ? fmt(tick.spread, 2)
      : (isNum(tick.ask) && isNum(tick.bid) ? fmt(tick.ask - tick.bid, 2) : 'N/A'));

    /* Fraîcheur : staleness_seconds vient de la vue v_market_latest. */
    const staleness = isNum(tick.staleness_seconds) ? tick.staleness_seconds : null;
    if (DEMO_MODE) {
      // Un prix de démonstration n'a pas de fraîcheur : il n'est jamais LIVE.
      setAttr(el.priceFreshness, 'data-state', 'demo');
      setText(el.priceFreshness, 'DÉMO');
      setMarketMode('demo');
    } else if (staleness === null) {
      setAttr(el.priceFreshness, 'data-state', 'unknown');
      setText(el.priceFreshness, 'FRAÎCHEUR N/A');
      setMarketMode('unknown');
    } else if (staleness <= CONFIG.STALE_THRESHOLD_S) {
      setAttr(el.priceFreshness, 'data-state', 'live');
      setText(el.priceFreshness, `LIVE ${staleness}s`);
      setMarketMode('live', staleness);
    } else {
      setAttr(el.priceFreshness, 'data-state', 'stale');
      setText(el.priceFreshness, `STALE ${staleness}s`);
      setMarketMode('stale', staleness);
    }

    setText(el.commandUpdated, fmtTimeUTC(tick.ts) + ' UTC');
  }

  function renderMacro(ticks) {
    const bySymbol = {};
    for (const t of ticks) bySymbol[t.symbol] = t;

    const gold = bySymbol['XAUUSD'];

    /* Provenance de la matrice : jamais une valeur sans dire d'où et de quand. */
    setText(el.macroMeta, DEMO_MODE ? 'DÉMO — VALEURS SYNTHÉTIQUES'
      : gold && gold.ts ? `TICK ${fmtTimeUTC(gold.ts)} UTC${isNum(gold.staleness_seconds) ? ` · ${gold.staleness_seconds}s` : ''}`
        : 'HORODATAGE N/A');

    /* Les drivers macro sont estampillés sur le tick de l'or (colonnes
       dxy_value, real_yield…). On retombe sur les instruments dédiés
       lorsqu'ils sont disponibles et plus frais. */
    const values = {
      dxy:        pick(gold && gold.dxy_value, bySymbol['DXY']),
      us10y:      pick(gold && gold.us10y_yield, bySymbol['US10Y']),
      real_yield: pick(gold && gold.real_yield, bySymbol['US10YR']),
      vix:        pick(gold && gold.vix, bySymbol['VIX']),
      wti:        pick(gold && gold.wti, bySymbol['WTI']),
    };

    for (const [key, value] of Object.entries(values)) {
      const row = el.macroRows.querySelector(`tr[data-driver="${key}"]`);
      if (!row) continue;

      const prev = state.previousMacro[key];
      const change = isNum(value) && isNum(prev) ? value - prev : null;
      const decimals = key === 'dxy' ? 3 : (key === 'us10y' || key === 'real_yield' ? 3 : 2);

      setText(row.querySelector('[data-field="value"]'), fmt(value, decimals));

      const changeCell = row.querySelector('[data-field="change"]');
      setText(changeCell, change === null ? '—' : fmtSigned(change, decimals));
      setAttr(changeCell, 'data-dir', change === null ? null : dirOf(change));

      const dirCell = row.querySelector('[data-field="dir"]');
      setText(dirCell, change === null ? '—' : arrowOf(change));
      setAttr(dirCell, 'data-dir', change === null ? null : dirOf(change));

      const impactCell = row.querySelector('[data-field="impact"]');
      const rule = MACRO_IMPACT[key];
      const movement = dirOf(change);
      if (change === null || movement === 'flat' || !rule) {
        setText(impactCell, isNum(value) ? 'Stable' : 'N/A');
        setAttr(impactCell, 'data-impact', 'neutral');
      } else {
        const impact = rule[movement];
        setText(impactCell, rule.label[impact]);
        setAttr(impactCell, 'data-impact', impact);
      }

      if (isNum(value)) state.previousMacro[key] = value;
    }

    function pick(stamped, instrument) {
      if (isNum(stamped)) return stamped;
      if (instrument && isNum(instrument.close)) return instrument.close;
      return null;
    }
  }

  /* ======================================================================
     7. RENDU — NEWS STREAM
     ====================================================================== */

  function renderNews(rows) {
    if (!Array.isArray(rows)) return;

    setText(el.newsCount, rows.length);

    if (rows.length === 0) {
      el.newsStream.replaceChildren(emptyLi('stream__empty', 'Aucun événement sur la fenêtre courante.'));
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const row of rows.slice(0, RUNTIME.MAX_NEWS_ROWS)) {
      const node = el.tplNews.content.firstElementChild.cloneNode(true);
      const klass = String(row.classification || 'noise').toLowerCase();

      node.setAttribute('data-class', klass);
      /* Signale visuellement uniquement ce qui n'avait jamais été affiché. */
      if (!state.seenNewsIds.has(row.id)) {
        node.classList.add('stream__item--new');
        state.seenNewsIds.add(row.id);
      }

      const chip = node.querySelector('[data-field="classification"]');
      setText(chip, klass === 'critical' ? 'CATALYST' : klass === 'major' ? 'MAJOR' : 'NOISE');
      setAttr(chip, 'data-class', klass);

      setText(node.querySelector('[data-field="score"]'),
        isNum(row.news_score) ? `${row.news_score.toFixed(1)}/100` : 'N/A');
      setText(node.querySelector('[data-field="time"]'), fmtTimeUTC(row.ts));
      setText(node.querySelector('[data-field="title"]'), row.title);
      setText(node.querySelector('[data-field="region"]'), row.region);
      setText(node.querySelector('[data-field="category"]'),
        String(row.category || '').replace(/_/g, ' ').toUpperCase());

      const impact = node.querySelector('[data-field="impact"]');
      const dir = String(row.gold_direction_impact || 'neutral');
      setText(impact, `OR ${dir === 'bullish' ? '▲ HAUSSIER' : dir === 'bearish' ? '▼ BAISSIER' : '— NEUTRE'}`);
      setAttr(impact, 'data-dir', dir);

      fragment.appendChild(node);
    }

    el.newsStream.replaceChildren(fragment);

    /* Le Set de news vues croîtrait indéfiniment sur une session longue. */
    if (state.seenNewsIds.size > 500) {
      state.seenNewsIds = new Set(rows.map((r) => r.id));
    }
  }

  function emptyLi(className, text) {
    const li = document.createElement('li');
    li.className = className;
    li.textContent = text;
    return li;
  }

  /* ======================================================================
     8. RENDU — ANALYSE IA ET SCENARIO TREE
     ====================================================================== */

  function renderAnalysis(analysis) {
    if (!analysis || typeof analysis !== 'object') return;
    state.analysis = analysis;

    const bias = String(analysis.overall_bias || 'neutral');
    setText(el.aiBias, bias === 'bullish' ? 'HAUSSIER'
      : bias === 'bearish' ? 'BAISSIER' : 'NEUTRE');
    setAttr(el.aiBias, 'data-dir', bias);

    const confidence = isNum(analysis.confidence) ? analysis.confidence : null;
    setText(el.convictionValue, confidence === null ? 'N/A' : `${confidence}/100`);
    setText(el.convictionGrade, convictionGrade(confidence));
    el.convictionBar.style.width = `${Math.max(0, Math.min(100, confidence || 0))}%`;

    setText(el.marketRegime,
      String(analysis.market_regime || '—').replace(/_/g, ' ').toUpperCase());

    const meta = analysis.meta || {};
    const verdict = meta.risk_verdict || null;
    // P1-1 : le statut vient de la base. En son absence on affiche
    // INCONNU — jamais VALID_SETUP par défaut.
    const status = meta.execution_status
      || (verdict && BLOCKING_VERDICTS.includes(verdict) ? 'NO_VALID_SETUP' : null);

    setText(el.executionStatus, EXECUTION_LABELS[status] || 'STATUT INCONNU');
    setAttr(el.executionStatus, 'data-status', status || 'unknown');

    /* Drivers */
    const drivers = Array.isArray(analysis.drivers) ? analysis.drivers : [];
    el.driversList.replaceChildren(
      drivers.length === 0
        ? emptyLi('drivers__empty', 'Aucun driver dominant identifié.')
        : fragmentOf(drivers.slice(0, 6), (d) => {
          const li = document.createElement('li');
          li.textContent = d;
          return li;
        }),
    );

    /* Bandeau de blocage — SPEC §39 + P1-3.
       DATA_INSUFFICIENT et CONFLICT sont affichés pour ce qu'ils sont :
       les confondre avec un rejet masquerait la cause réelle. */
    const invalid = status === 'NO_VALID_SETUP'
      || (verdict !== null && BLOCKING_VERDICTS.includes(verdict));
    el.noSetup.hidden = !invalid;
    if (invalid) {
      setText(el.noSetupTitle, BLOCKING_TITLES[verdict] || 'NO VALID SETUP');
      const reasons = []
        .concat(Array.isArray(meta.validation_errors) ? meta.validation_errors : [])
        .concat(Array.isArray(meta.data_quality_issues) ? meta.data_quality_issues : [])
        .concat(Array.isArray(analysis.risks) ? analysis.risks : []);
      setText(el.noSetupReason, reasons.length
        ? reasons.slice(0, 3).join(' · ')
        : `Analyse bloquée par le comité de risque (${verdict || 'motif non transmis'}).`);
    }

    renderScenarios(analysis.scenarios, meta.spot_reference);

    /* Invalidations */
    const invalidations = Array.isArray(analysis.invalidations) ? analysis.invalidations : [];
    el.invalidationsList.replaceChildren(
      invalidations.length === 0
        ? emptyLi('invalidations__empty', '—')
        : fragmentOf(invalidations.slice(0, 6), (t) => {
          const li = document.createElement('li');
          li.textContent = t;
          return li;
        }),
    );

    /* Pied de page */
    setText(el.modelVersion, meta.model_version);
    setText(el.riskVerdict, VERDICT_LABELS[meta.risk_verdict] || 'N/A');
    setAttr(el.riskVerdict, 'data-verdict', meta.risk_verdict || 'unknown');
    setText(el.analysisTime, meta.generated_at ? `${fmtTimeUTC(meta.generated_at)} UTC` : '—');
    setText(el.scenarioMeta, `SPOT RÉF ${fmt(meta.spot_reference, 2)}`);
  }

  function renderScenarios(scenarios, spotReference) {
    if (!scenarios || typeof scenarios !== 'object') {
      el.scenarioTree.replaceChildren(divOf('tree__empty', 'Aucun scénario disponible.'));
      return;
    }

    const spot = isNum(spotReference) ? spotReference : state.spot;
    const fragment = document.createDocumentFragment();
    let rendered = 0;

    for (const horizon of HORIZONS) {
      const s = scenarios[horizon];
      if (!s || typeof s !== 'object') continue;

      /* Garde-fou client : la règle absolue interdit d'afficher un scénario
         sans invalidation chiffrée. Le backend la fait déjà respecter, mais
         le terminal ne doit pas pouvoir afficher un scénario non conforme
         si un jour une réponse malformée passe. */
      // P1-4 : un scénario sans condition d'activation exploitable n'est
      // pas affichable — il ne dit pas QUAND il devient actif.
      const activation = typeof s.activation_condition === 'string'
        ? s.activation_condition.trim() : '';
      if (!isNum(s.invalidation) || !isNum(s.target) || !isNum(s.probability)) continue;
      if (activation.length < 15) continue;

      // PHASE 12 : un scénario dont la condition d'activation n'a jamais été
      // enregistrée reste visible pour l'audit, mais ne doit JAMAIS être
      // présenté comme un plan exploitable. `is_tradable` est une colonne
      // générée en base : le frontend ne la recalcule pas, il la respecte.
      // Un marqueur LEGACY fait 88 caractères et franchirait sinon le
      // garde-fou de longueur ci-dessus.
      const tradable = s.is_tradable !== false && !/^LEGACY:/.test(activation);

      const node = el.tplScenario.content.firstElementChild.cloneNode(true);
      const dir = String(s.direction || 'neutral');

      setText(node.querySelector('[data-field="horizon"]'), horizon);
      setText(node.querySelector('[data-field="window"]'), HORIZON_LABELS[horizon]);

      const dirNode = node.querySelector('[data-field="direction"]');
      setText(dirNode, dir === 'bullish' ? 'HAUSSIER' : dir === 'bearish' ? 'BAISSIER' : 'NEUTRE');
      setAttr(dirNode, 'data-dir', dir);

      setText(node.querySelector('[data-field="probability"]'), `${s.probability}%`);
      const bar = node.querySelector('[data-field="bar"]');
      bar.style.width = `${Math.max(0, Math.min(100, s.probability))}%`;
      setAttr(bar, 'data-dir', dir);

      setText(node.querySelector('[data-field="target"]'), fmt(s.target, 2));
      setText(node.querySelector('[data-field="invalidation"]'), fmt(s.invalidation, 2));

      /* R:R recalculé côté client à partir des niveaux affichés : le chiffre
         montré et les prix montrés ne peuvent pas diverger. */
      const risk = isNum(spot) ? Math.abs(spot - s.invalidation) : null;
      const rr = risk && risk > 1e-9 ? Math.abs(s.target - spot) / risk : null;
      setText(node.querySelector('[data-field="rr"]'), rr === null ? 'N/A' : `${rr.toFixed(2)}`);

      setText(node.querySelector('[data-field="confidence"]'),
        isNum(s.confidence) ? `${s.confidence}%` : 'N/A');
      setText(node.querySelector('[data-field="activation"]'), activation);

      if (!tradable) {
        node.setAttribute('data-tradable', 'false');
        setText(node.querySelector('[data-field="activation"]'),
          'NON TRADABLE — condition d\'activation non enregistrée (analyse historique).');
        // La direction n'est pas actionnable : ne pas la colorer comme un
        // signal. Le scénario est conservé pour l'audit, pas pour l'exécution.
        setAttr(dirNode, 'data-dir', 'neutral');
        setText(dirNode, 'NON TRADABLE');
      }
      setText(node.querySelector('[data-field="reasoning"]'), s.reasoning);

      fragment.appendChild(node);
      rendered++;
    }

    el.scenarioTree.replaceChildren(
      rendered === 0 ? divOf('tree__empty', 'Aucun scénario conforme à afficher.') : fragment,
    );
  }

  function fragmentOf(items, build) {
    const frag = document.createDocumentFragment();
    for (const item of items) frag.appendChild(build(item));
    return frag;
  }

  function divOf(className, text) {
    const div = document.createElement('div');
    div.className = className;
    div.textContent = text;
    return div;
  }

  /* ======================================================================
     9. ÉTAT DE CONNEXION ET ERREURS
     ====================================================================== */

  function setTransport(mode, label) {
    state.transport = mode;
    const map = {
      websocket: { state: 'live', label: 'LIVE', transport: 'WEBSOCKET' },
      polling: { state: 'polling', label: 'POLLING', transport: `HTTP ${CONFIG.POLL_INTERVAL_MS / 1000}s` },
      connecting: { state: 'connecting', label: 'CONNEXION…', transport: '—' },
      offline: { state: 'offline', label: 'HORS LIGNE', transport: '—' },
      demo: { state: 'polling', label: 'DÉMO', transport: 'LOCAL' },
    };
    const cfg = map[mode] || map.offline;
    setAttr(el.connIndicator, 'data-state', cfg.state);
    setText(el.connLabel, label || cfg.label);
    setText(el.transportMode, cfg.transport);
  }

  function reportError(message) {
    state.consecutiveErrors++;
    /* Une erreur isolée ne doit pas faire clignoter un bandeau rouge :
       un réseau mobile perd des requêtes en permanence. */
    if (state.consecutiveErrors < RUNTIME.ERROR_TOLERANCE) return;

    setText(el.errorMessage, message);
    el.errorBanner.hidden = false;
    if (state.transport !== 'websocket') setTransport('offline');

    /* La donnée affichée devient suspecte dès que le flux est rompu. */
    setAttr(el.priceFreshness, 'data-state', 'offline');
    setText(el.priceFreshness, 'FLUX ROMPU');
    setMarketMode('offline');
  }

  /**
   * Nature des données marché, toujours visible. LIVE n'est affiché que pour
   * un flux réel dont la fraîcheur est dans le seuil ; tout le reste le dit.
   */
  const MARKET_MODES = {
    demo: 'DÉMO — VALEURS SYNTHÉTIQUES',
    live: 'LIVE',
    stale: 'PÉRIMÉ',
    offline: 'FLUX ROMPU',
    unknown: 'FRAÎCHEUR INCONNUE',
    connecting: 'CONNEXION…',
  };

  function setMarketMode(mode, staleness) {
    setAttr(el.modeV1, 'data-mode', mode);
    setText(el.modeV1Val, isNum(staleness) ? `${MARKET_MODES[mode]} ${staleness}s` : MARKET_MODES[mode]);
  }

  function clearError() {
    state.consecutiveErrors = 0;
    el.errorBanner.hidden = true;
  }

  /* ======================================================================
     10. CYCLE DE RAFRAÎCHISSEMENT (POLLING)
     ====================================================================== */

  async function refreshMarket() {
    const ticks = await fetchJson(
      'v_market_latest?select=symbol,bid,ask,spread,close,dxy_value,us10y_yield,real_yield,vix,wti,ts,staleness_seconds',
    );
    const gold = ticks.find((t) => t.symbol === 'XAUUSD');
    if (gold) renderQuote(gold);
    renderMacro(ticks);
  }

  async function refreshNews() {
    const rows = await fetchJson(
      'v_news_high_impact?select=id,title,news_score,classification,gold_direction_impact,region,category,ts'
      + `&order=ts.desc&limit=${RUNTIME.MAX_NEWS_ROWS}`,
    );
    state.news = rows;
    renderNews(rows);
  }

  /**
   * L'analyse est reconstruite depuis la vue v_ai_latest, qui agrège les
   * scénarios en JSON. Les probabilités sont stockées en [0,1] en base et
   * affichées en 0-100 : la conversion se fait ici, à la frontière.
   */
  async function refreshAnalysis() {
    const rows = await fetchJson(
      'v_ai_latest?select=id,symbol,model_version,market_regime,regime_confidence,spot_reference,'
      + 'summary,analysis_ts,valid_until,risk_verdict,execution_status,overall_bias,confidence_cap,'
      + 'data_quality,rejection_reasons,drivers,risks,invalidations,scenarios'
      + '&symbol=eq.XAUUSD&limit=1',
    );

    // Aucune analyse courante : état NO_DATA explicite, jamais un état
    // optimiste par défaut.
    if (!rows.length) {
      renderNoAnalysis('NO_DATA', 'Aucune analyse courante. La dernière analyse a expiré ou aucune n\'a encore été produite.');
      return;
    }

    const row = rows[0];
    const scenarios = {};
    for (const horizon of HORIZONS) {
      const s = (row.scenarios || {})[horizon];
      if (!s) continue;
      scenarios[horizon] = {
        direction: s.direction,
        // La base stocke [0,1], le contrat frontend 0-100.
        probability: Math.round(Number(s.probability) * 100),
        target: Number(s.target),
        invalidation: Number(s.invalidation),
        activation_condition: s.activation_condition,
        confidence: Math.round(Number(s.confidence) * 100),
        reasoning: s.reasoning,
      };
    }

    renderAnalysis({
      market_regime: row.market_regime,
      // P1-6 : le biais vient du Portfolio Manager. Le frontend ne le
      // recalcule plus. Un overall_bias 'neutral' avec un H1 haussier est
      // une position cohérente et doit s'afficher telle quelle.
      overall_bias: row.overall_bias,
      confidence: Math.round(Number(row.regime_confidence) * 100),
      scenarios,
      drivers: asList(row.drivers),
      risks: asList(row.risks),
      invalidations: asList(row.invalidations),
      meta: {
        analysis_id: row.id,
        model_version: row.model_version,
        // P1-1 : lus en base, jamais inventés.
        execution_status: row.execution_status,
        risk_verdict: row.risk_verdict,
        confidence_cap: row.confidence_cap,
        data_quality_issues: asList(row.data_quality),
        spot_reference: Number(row.spot_reference),
        generated_at: row.analysis_ts,
        valid_until: row.valid_until,
        validation_errors: asList(row.rejection_reasons),
      },
    });
  }

  /** Normalise une colonne JSONB en tableau de chaînes. */
  function asList(value) {
    if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.length > 0);
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
      } catch { return []; }
    }
    return [];
  }

  /**
   * État affiché lorsqu'aucune analyse exploitable n'est disponible.
   * Interdit d'afficher un statut optimiste : sans analyse, le terminal
   * dit qu'il n'a pas d'analyse.
   */
  function renderNoAnalysis(state, message) {
    setText(el.aiBias, 'N/A');
    setAttr(el.aiBias, 'data-dir', 'neutral');
    setText(el.convictionValue, 'N/A');
    el.convictionGrade.textContent = '';
    el.convictionBar.style.width = '0%';
    setText(el.marketRegime, 'N/A');
    setText(el.executionStatus, state === 'NO_DATA' ? 'AUCUNE ANALYSE' : state);
    setAttr(el.executionStatus, 'data-status', state);
    el.driversList.replaceChildren(emptyLi('drivers__empty', 'Aucune analyse disponible.'));
    el.noSetup.hidden = false;
    setText(el.noSetupReason, message);
    el.scenarioTree.replaceChildren(divOf('tree__empty', 'Aucun scénario : aucune analyse courante.'));
    el.invalidationsList.replaceChildren(emptyLi('invalidations__empty', '—'));
    setText(el.riskVerdict, 'N/A');
    setText(el.modelVersion, 'N/A');
    setText(el.analysisTime, 'N/A');
  }

let pollTimer = null;
  let analysisTimer = null;

  async function pollCycle() {
    try {
      await Promise.all([refreshMarket(), refreshNews()]);
      clearError();
      if (state.transport !== 'websocket') setTransport('polling');
    } catch (err) {
      reportError(`Flux de marché indisponible — ${err.message}`);
    }
  }

  async function analysisCycle() {
    try {
      await refreshAnalysis();
    } catch (err) {
      /* L'analyse est moins critique que le prix : on n'escalade pas en
         bandeau d'incident, on journalise seulement. */
      console.warn('[alpha-xau] analyse indisponible', err.message);
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollCycle();
    pollTimer = setInterval(pollCycle, CONFIG.POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /* ======================================================================
     11. WEBSOCKET (SUPABASE REALTIME)
     ====================================================================== */

  let socket = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let messageRef = 0;

  /**
   * Supabase Realtime parle le protocole Phoenix Channels : on rejoint un
   * topic par table, puis on reçoit des messages `postgres_changes`.
   *
   * Le WebSocket ne remplace pas le polling, il le complète : un INSERT
   * poussé met à jour le prix immédiatement, tandis que le polling continue
   * à une cadence réduite pour rattraper tout message perdu. Un terminal
   * qui dépend d'un seul canal affiche un écran figé dès que ce canal tombe.
   */
  function connectWebSocket() {
    if (DEMO_MODE || typeof WebSocket === 'undefined') {
      startPolling();
      return;
    }
    if (state.wsAttempts >= RUNTIME.WS_MAX_ATTEMPTS) {
      console.warn('[alpha-xau] WebSocket abandonné, polling définitif');
      startPolling();
      return;
    }

    setTransport('connecting');

    let url;
    try {
      const base = new URL(CONFIG.SUPABASE_URL);
      base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      base.pathname = '/realtime/v1/websocket';
      base.searchParams.set('apikey', CONFIG.SUPABASE_ANON_KEY);
      base.searchParams.set('vsn', '1.0.0');
      url = base.toString();
    } catch (err) {
      console.warn('[alpha-xau] SUPABASE_URL invalide, polling seul', err.message);
      startPolling();
      return;
    }

    try {
      socket = new WebSocket(url);
    } catch (err) {
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      state.wsAttempts = 0;
      setTransport('websocket');
      clearError();

      joinTopic('realtime:public:market_ticks');
      joinTopic('realtime:public:news_events');

      heartbeatTimer = setInterval(() => {
        send('phoenix', 'heartbeat', {});
      }, RUNTIME.WS_HEARTBEAT_MS);

      /* Cadence réduite mais maintenue : filet contre les messages perdus
         et source des données macro non poussées. */
      stopPolling();
      pollCycle();
      pollTimer = setInterval(pollCycle, CONFIG.POLL_INTERVAL_MS * 4);
    });

    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return; // message non JSON : ignoré sans casser la boucle
      }
      handleRealtimeMessage(payload);
    });

    socket.addEventListener('error', () => {
      /* L'événement error ne porte aucun détail exploitable côté navigateur ;
         la logique de repli est traitée dans le handler close, toujours émis. */
    });

    socket.addEventListener('close', () => {
      cleanupSocket();
      /* Repli immédiat en polling : l'écran ne doit jamais se figer pendant
         la tentative de reconnexion. */
      startPolling();
      setTransport('polling');
      scheduleReconnect();
    });
  }

  function joinTopic(topic) {
    send(topic, 'phx_join', {
      config: {
        postgres_changes: [
          { event: 'INSERT', schema: 'public', table: topic.split(':').pop() },
        ],
      },
    });
  }

  function send(topic, event, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    messageRef++;
    socket.send(JSON.stringify({ topic, event, payload, ref: String(messageRef) }));
  }

  function handleRealtimeMessage(message) {
    if (!message || message.event !== 'postgres_changes') return;
    const data = message.payload && message.payload.data;
    if (!data || data.type !== 'INSERT' || !data.record) return;

    const record = data.record;

    if (data.table === 'market_ticks' && record.symbol === 'XAUUSD') {
      renderQuote({
        close: Number(record.close),
        bid: record.bid === null ? null : Number(record.bid),
        ask: record.ask === null ? null : Number(record.ask),
        spread: record.spread === null ? null : Number(record.spread),
        ts: record.ts,
        /* Le tick vient d'être poussé : sa fraîcheur est celle du transport. */
        staleness_seconds: 0,
      });
      clearError();
    }

    if (data.table === 'news_events') {
      const klass = String(record.classification || 'noise');
      if (klass !== 'critical' && klass !== 'major') return;

      state.news = [{
        id: record.id,
        title: record.title,
        news_score: Number(record.news_score),
        classification: klass,
        gold_direction_impact: record.gold_direction_impact,
        region: record.region,
        category: record.category,
        ts: record.ts,
      }].concat(state.news).slice(0, RUNTIME.MAX_NEWS_ROWS);

      renderNews(state.news);
    }
  }

  function cleanupSocket() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    state.wsAttempts++;
    const delay = Math.min(
      RUNTIME.WS_BACKOFF_BASE_MS * 2 ** state.wsAttempts,
      RUNTIME.WS_BACKOFF_MAX_MS,
    );
    /* Jitter : évite que tous les postes ouverts sur le terminal ne se
       reconnectent à la même milliseconde après une coupure. */
    const jittered = Math.floor(delay * (0.5 + Math.random() * 0.5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, jittered);
  }

  /* ======================================================================
     11 bis. ESPACES DE TRAVAIL
     ====================================================================== */

  const WORKSPACE_KEY = 'alpha-xau.workspace';

  /** Onglets accessibles : flèches gauche/droite, Début/Fin, ancre #chaine. */
  function selectWorkspace(name, focus) {
    const chain = name === 'chain';
    el.wsMarket.hidden = chain;
    el.wsChain.hidden = !chain;
    for (const [tab, selected] of [[el.tabMarket, !chain], [el.tabChain, chain]]) {
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    if (focus) (chain ? el.tabChain : el.tabMarket).focus();
    try { window.localStorage.setItem(WORKSPACE_KEY, chain ? 'chain' : 'market'); } catch { /* stockage indisponible */ }
  }

  function initWorkspaces() {
    let initial = window.location.hash === '#chaine' ? 'chain' : 'market';
    if (initial === 'market' && window.location.hash !== '#marche') {
      try { if (window.localStorage.getItem(WORKSPACE_KEY) === 'chain') initial = 'chain'; } catch { /* idem */ }
    }
    selectWorkspace(initial, false);
    el.tabMarket.addEventListener('click', () => selectWorkspace('market', false));
    el.tabChain.addEventListener('click', () => selectWorkspace('chain', false));
    for (const tab of [el.tabMarket, el.tabChain]) {
      tab.addEventListener('keydown', (event) => {
        const key = event.key;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
        event.preventDefault();
        const toChain = key === 'End' || ((key === 'ArrowRight' || key === 'ArrowLeft') && tab === el.tabMarket);
        selectWorkspace(toChain ? 'chain' : 'market', true);
      });
    }
  }

  /* ======================================================================
     11 ter. CHAÎNE DÉCISIONNELLE V2 (VUE LOCALE CHAIN-0)
     ====================================================================== */

  const V2_SCHEMA_VERSION = 'xau.terminal-local-view.v4';

  const V2_CAPABILITY_LABELS = {
    OPERATIONAL_LOCAL: 'OPÉRATIONNEL LOCAL',
    SIMULATED: 'SIMULÉ',
    BLOCKED: 'BLOQUÉ',
    NOT_VALIDATED: 'NON VALIDÉ',
  };

  const V2_BLOCKER_LABELS = {
    DATA: 'DONNÉES',
    UPSTREAM: 'AMONT',
    INTEGRITY: 'INTÉGRITÉ',
    BUSINESS_DECISION: 'DÉCISION MÉTIER',
    AUTHORIZATION: 'AUTORISATION',
    ENVIRONMENT: 'ENVIRONNEMENT',
  };

  /* Ce qu'il faut pour lever chaque type de blocage. */
  const V2_BLOCKER_ACTIONS = {
    INTEGRITY: 'défaut technique à corriger',
    DATA: 'données à fournir ou à corriger',
    BUSINESS_DECISION: 'méthode ou politique à approuver',
    AUTHORIZATION: 'autorisation explicite requise',
    ENVIRONMENT: 'runtime, déploiement ou connexion inexistants',
  };

  /* Dépendances bloquantes, regroupées par ce qu'il faut obtenir. */
  const V2_DEPENDENCY_LABELS = {
    BUSINESS_DECISION: 'APPROBATIONS MÉTIER',
    AUTHORIZATION: 'AUTORISATIONS',
    ENVIRONMENT: 'ENVIRONNEMENT',
  };

  /* Verbe de la phrase « pour lever le HOLD, il faudrait … ». */
  const V2_LIFT_VERBS = {
    INTEGRITY: (n) => `corriger ${n} incohérence(s) interne(s)`,
    DATA: (n) => `fournir ou corriger ${n} donnée(s)`,
    BUSINESS_DECISION: (n) => `approuver ${n} méthode(s) ou politique(s)`,
    AUTHORIZATION: (n) => `accorder ${n} autorisation(s)`,
    ENVIRONMENT: (n) => `mettre en place ${n} élément(s) d'environnement (runtime, déploiement, connexion)`,
  };

  const V2_SUMMARY_STATUS = ['BLOCKED', 'INPUT_REJECTED', 'INTEGRITY_VIOLATED'];
  const V2_MISSING_KINDS = ['MARKET_FIELD', 'DATA_REASON', 'INPUT_ERROR'];

  const V2_ORIGIN_LABELS = {
    GOLDEN_FIXTURE: 'SIMULATION — FIXTURE',
    LOCAL_INPUT_FILE: 'SIMULATION — FICHIER LOCAL',
    LOCAL_SCENARIO: 'SIMULATION — SCÉNARIO',
    LOCAL_MARKET_ARCHIVE: 'ARCHIVE DE MARCHÉ LOCALE',
  };

  /* DATA-1 : nature des données de marché rejouées. Jamais LIVE. */
  const V2_EVIDENCE_NATURE = {
    SIMULATION: 'ARCHIVE SYNTHÉTIQUE',
    HISTORICAL_VERIFIED: 'HISTORIQUE VÉRIFIÉ',
    HISTORICAL_UNVERIFIED: 'HISTORIQUE NON VÉRIFIÉ',
  };
  const V2_EVIDENCE_STATUS = { VERIFIED: 'REJEU VÉRIFIÉ', INCOMPLETE: 'REJEU INCOMPLET', INVALID: 'ARCHIVE REJETÉE' };
  const V2_RAW_STATES = { RAW_VERIFIED: 'BRUT RELU', RAW_DIGEST_ONLY: 'EMPREINTE SEULE', RAW_UNKNOWN: 'BRUT INCONNU' };

  /** Libellé d'origine ; un scénario est nommé par son identifiant. */
  const originText = (origin) => (origin.kind === 'LOCAL_SCENARIO' && isText(origin.label)
    ? `${V2_ORIGIN_LABELS[origin.kind]} ${origin.label.toUpperCase()}` : V2_ORIGIN_LABELS[origin.kind]);

  const V2_TEMPORAL = ['HISTORICAL', 'AT_GENERATION', 'UNKNOWN'];

  /* Manifeste E2E-0 : ce qu'il faut prouver avant toute production. */
  const V2_EVIDENCE_LABELS = {
    restorableRecoveryPoint: 'Point de restauration vérifié',
    productionMigrationsApplied: 'Migrations de production appliquées',
    officialBundleLiveProven: 'Bundle officiel prouvé en direct',
    runtimeDeploymentProven: 'Déploiement runtime prouvé',
    providerPoliciesApproved: 'Politiques fournisseurs approuvées',
    semanticMethodsApproved: 'Méthodes sémantiques approuvées',
    portfolioRiskPoliciesApproved: 'Politiques portefeuille et risque approuvées',
    alertDeliveryPolicyApproved: 'Politique de livraison des alertes approuvée',
    goldenPathReplayProven: 'Rejeu du chemin de référence prouvé',
    incidentRecoveryProven: 'Reprise après incident prouvée',
    executionAuthorityApproved: 'Autorité d\'exécution approuvée',
  };

  const isList = Array.isArray;
  const isText = (v) => typeof v === 'string' && v.length > 0;
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const label = (code) => String(code).replace(/_/g, ' ');

  /**
   * Garde-fou client : la vue doit dire HOLD, exécution interdite, simulée,
   * avec des statuts connus. Toute autre affirmation est refusée en bloc :
   * le terminal n'affiche jamais une partie d'une vue non conforme.
   */
  function v2Problem(view) {
    if (!view || typeof view !== 'object') return 'vue absente';
    if (view.schemaVersion !== V2_SCHEMA_VERSION) return `version inconnue (${String(view.schemaVersion)})`;
    if (view.simulated !== true) return 'vue non marquée simulée';
    if (!has(V2_ORIGIN_LABELS, view.origin && view.origin.kind)) return 'origine inconnue';
    if (!view.temporal || !V2_TEMPORAL.includes(view.temporal.classification)) return 'classification temporelle inconnue';
    const chain = view.chain;
    if (!chain || chain.chainState !== 'HOLD') return 'état de chaîne différent de HOLD';
    if (chain.execution !== 'FORBIDDEN') return 'exécution non interdite';
    if (chain.outcome !== 'COMPLETED' && chain.outcome !== 'REJECTED') return 'issue inconnue';
    if (!isList(view.stages) || !isList(view.capabilities) || !view.market || !isList(view.market.fields)
        || !isList(view.horizons) || !view.acceptance || !isList(view.acceptance.evidence) || !view.observability) {
      return 'structure incomplète';
    }
    const why = view.holdRationale;
    if (!why || !isList(why.rootCauses) || !isList(why.unclassifiedCodes)) return 'justification du HOLD absente';
    for (const c of why.rootCauses) {
      if (!c || !has(V2_BLOCKER_LABELS, c.category) || !isList(c.codes) || !isList(c.stages)
          || !isList(c.reasons)) return 'cause non conforme';
    }
    const sum = view.summary;
    if (!sum || sum.decision !== 'HOLD' || sum.execution !== 'FORBIDDEN') return 'synthèse différente de HOLD';
    if (!V2_SUMMARY_STATUS.includes(sum.status) || !isList(sum.mainReasons) || !isList(sum.missingData)
        || !isList(sum.blockingDependencies)) return 'synthèse non conforme';
    if (sum.mainReasons.some((r) => !r || !has(V2_BLOCKER_LABELS, r.category))
        || sum.missingData.some((m) => !m || !V2_MISSING_KINDS.includes(m.kind))
        || sum.blockingDependencies.some((dep) => !dep || !has(V2_DEPENDENCY_LABELS, dep.category))) {
      return 'synthèse non conforme';
    }
    for (const c of view.capabilities) {
      if (!c || !has(V2_CAPABILITY_LABELS, c.status) || !isList(c.blockers)) return 'capacité non conforme';
    }
    const mev = view.marketEvidence;
    if (mev === undefined) return 'preuves de marché absentes';
    if (mev !== null) {
      if (!has(V2_EVIDENCE_STATUS, mev.status) || !has(V2_EVIDENCE_NATURE, mev.nature) || !isList(mev.observations)
          || !isList(mev.reasonCodes) || mev.observations.some((o) => !o || !has(V2_RAW_STATES, o.raw))) {
        return 'preuves de marché non conformes';
      }
      // Une affirmation forte doit porter toutes ses conditions.
      if (mev.reproducible !== (mev.status === 'VERIFIED')) return 'reproductibilité incohérente';
      if (mev.nature === 'SIMULATION' && mev.provenanceClass !== 'SYNTHETIC_FIXTURE') return 'nature de marché incohérente';
      if (mev.nature !== 'SIMULATION' && mev.provenanceClass !== 'CAPTURED') return 'nature de marché incohérente';
      if (mev.nature === 'HISTORICAL_VERIFIED' && (mev.status !== 'VERIFIED' || mev.observations.length === 0
          || mev.observations.some((o) => o.raw !== 'RAW_VERIFIED'))) return 'historique vérifié non prouvé';
    }
    for (const h of view.horizons) {
      // Une direction n'existe qu'avec une méthode approuvée ; il n'y en a aucune.
      if (!h || h.status !== 'ABSTAIN' || h.direction !== 'UNAVAILABLE') return 'horizon non abstenu';
    }
    for (const st of view.stages) {
      if (!st || !isText(st.stage) || !isText(st.state) || !isList(st.reasons)
          || !has(V2_CAPABILITY_LABELS, st.capability)) {
        return 'étage non conforme';
      }
    }
    return null;
  }

  /** Construit un élément avec texte et attributs, jamais de HTML. */
  function node(tag, className, text, attrs) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text == null || text === '' ? '—' : String(text);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
    return n;
  }

  function v2Row(cells) {
    const tr = document.createElement('tr');
    for (const cell of cells) tr.appendChild(cell);
    return tr;
  }

  function v2EmptyRow(colspan, text) {
    const td = node('td', 'v2__empty', text);
    td.colSpan = colspan;
    return v2Row([td]);
  }

  const v2Blockers = (list) => (isList(list) && list.length
    ? list.map((b) => V2_BLOCKER_LABELS[b] || 'NON CLASSÉ').join(' · ') : '—');

  /** Durée lisible d'un âge en secondes. */
  function fmtAge(seconds) {
    if (!isNum(seconds)) return 'N/A';
    const sign = seconds < 0 ? '-' : '';
    const s = Math.abs(seconds);
    if (s < 120) return `${sign}${s} s`;
    if (s < 7200) return `${sign}${Math.floor(s / 60)} min`;
    if (s < 172800) return `${sign}${Math.floor(s / 3600)} h`;
    return `${sign}${Math.floor(s / 86400)} j`;
  }

  function v2Status(stateName, title, detail) {
    setAttr(el.v2Status, 'data-state', stateName);
    setText(el.v2State, title);
    setText(el.v2Detail, detail);
  }

  /** Nature de la vue : courte dans la barre commune, complète dans l'espace V2. */
  function setChainMode(mode, text, full) {
    setAttr(el.modeV2, 'data-mode', mode);
    setText(el.modeV2Val, text);
    setAttr(el.v2NavNature, 'data-mode', mode);
    setText(el.v2NavNature, full || text);
    setText(el.tabChainState, mode === 'unavailable' ? '—' : mode === 'refused' ? 'REFUSÉE' : 'HOLD');
    setAttr(el.tabChainState, 'data-mode', mode);
  }

  /** Vue absente, illisible ou rejetée : rien d'autre n'est affiché. */
  function renderV2Unavailable(stateName, title, detail) {
    v2Status(stateName, title, detail);
    setChainMode(stateName === 'unavailable' ? 'unavailable' : 'refused',
      stateName === 'unavailable' ? 'INDISPONIBLE' : title);
    setAttr(el.v2Origin, 'data-state', 'unknown');
    setText(el.v2Origin, stateName === 'unavailable' ? 'AUCUN RUNTIME' : 'VUE REFUSÉE');
    el.v2Why.hidden = true;
    el.v2Summary.hidden = true;
    el.v2Mev.hidden = true;
    el.v2MevObs.replaceChildren();
    for (const n of [el.v2ChainState, el.v2Execution, el.v2Integrity, el.v2Cutoff, el.v2CutoffAge, el.v2Digest,
      el.v2Generated, el.v2Replay, el.v2Positioning, el.v2PositioningThrough, el.v2PositioningSources, el.v2MarketState]) {
      setText(n, '—');
    }
    setAttr(el.v2Digest, 'title', null);
    el.v2Stages.replaceChildren(node('li', 'v2__empty', '—'));
    el.v2Market.replaceChildren(v2EmptyRow(6, '—'));
    el.v2Capabilities.replaceChildren(node('li', 'v2__empty', 'Matrice indisponible sans vue V2.'));
    el.v2Horizons.replaceChildren(node('li', 'v2__empty', '—'));
    el.v2Evidence.replaceChildren(node('li', 'v2__empty', '—'));
    setText(el.v2AcceptanceState, '—');
    setText(el.v2Observability, '—');
    setText(el.v2CapabilityCount, '—');
  }

  /** Une liste de phrases ; l'élément vide garde la liste lisible. */
  function plainList(className, items, empty) {
    const ul = node('ul', className);
    if (!items.length) ul.appendChild(node('li', 'v2__empty', empty));
    for (const text of items) ul.appendChild(node('li', '', text));
    return ul;
  }

  /** Synthèse décisionnelle : état global, raisons, données, dépendances. */
  function renderSummary(view) {
    const sum = view.summary;
    el.v2Summary.hidden = false;
    setAttr(el.v2Summary, 'data-status', sum.status);
    setText(el.v2SummaryHeadline, sum.headline);
    const reasons = sum.mainReasons.map((r) => `${r.count} — ${r.plain || V2_BLOCKER_LABELS[r.category]}`);
    if (isNum(sum.missingAcceptanceEvidence) && sum.missingAcceptanceEvidence > 0) {
      reasons.push(`${sum.missingAcceptanceEvidence}/${view.acceptance.evidence.length} preuves de recette manquantes`);
    }
    el.v2SummaryReasons.replaceChildren(...plainList('summary__list', reasons, 'Aucune cause racine.').childNodes);
    el.v2SummaryMissing.replaceChildren(...plainList('summary__list',
      sum.missingData.map((m) => m.plain || m.code), 'Aucune donnée manquante au cutoff.').childNodes);
    const groups = Object.keys(V2_DEPENDENCY_LABELS).map((category) => [category,
      sum.blockingDependencies.filter((dep) => dep.category === category)]).filter(([, deps]) => deps.length);
    el.v2SummaryDeps.replaceChildren(...(groups.length ? groups.map(([category, deps]) => {
      const box = node('details', 'dep', undefined, { 'data-category': category });
      box.appendChild(node('summary', 'dep__head', `${V2_DEPENDENCY_LABELS[category]} (${deps.length})`));
      const ul = node('ul', 'dep__list');
      for (const dep of deps) {
        const li = node('li', 'dep__item');
        li.appendChild(node('span', 'dep__plain', dep.plain || dep.code));
        li.appendChild(node('span', 'dep__code', `${dep.code}${isList(dep.stages) && dep.stages.length
          ? ` · ${dep.stages.map(label).join(', ')}` : ''}`));
        ul.appendChild(li);
      }
      box.appendChild(ul);
      return box;
    }) : [node('p', 'v2__empty', 'Aucune dépendance : la chaîne n\'a pas été évaluée.')]));
  }

  function renderWhy(view) {
    const why = view.holdRationale;
    if (view.chain.outcome !== 'COMPLETED') {
      el.v2Why.hidden = true;
      return;
    }
    el.v2Why.hidden = false;
    const first = why.firstBlockedStage ? label(why.firstBlockedStage) : null;
    setText(el.v2WhyLead, first
      ? `La chaîne s'arrête à ${first}, premier étage bloqué ; les étages suivants héritent de ce blocage `
        + `(${why.inheritedReasonCount} motif(s) hérité(s) de l'amont).`
      : 'Aucun étage ne s\'abstient, mais aucune décision positive n\'est approuvée : HOLD par construction.');
    const steps = why.rootCauses.filter((c) => has(V2_LIFT_VERBS, c.category))
      .map((c) => V2_LIFT_VERBS[c.category](c.codes.length));
    setText(el.v2WhyLift, steps.length ? `Pour lever le HOLD, il faudrait : ${steps.join(' ; ')}.` : '');
    el.v2WhyLift.hidden = steps.length === 0;
    const items = [];
    const opened = new Set([...el.v2WhyList.querySelectorAll('details[open]')].map((d) => d.getAttribute('data-category')));
    const card = (category, title, reasons, stages) => {
      const wrap = node('details', 'why', undefined, { 'data-category': category });
      wrap.open = opened.has(category);
      const head = node('summary', 'why__head');
      head.appendChild(node('span', 'why__cat', title));
      head.appendChild(node('span', 'why__count', String(reasons.length)));
      wrap.appendChild(head);
      wrap.appendChild(plainList('why__plain', [...new Set(reasons.map((r) => r.plain || label(r.code)))], '—'));
      wrap.appendChild(node('p', 'why__codes', reasons.map((r) => label(r.code)).join(' · ')));
      if (stages) wrap.appendChild(node('p', 'why__stages', `Étages : ${stages.map(label).join(', ')}`));
      return wrap;
    };
    for (const cause of why.rootCauses) {
      const reasons = cause.codes.map((code, i) => ({ code,
        plain: cause.reasons[i] && cause.reasons[i].code === code ? cause.reasons[i].plain : null }));
      items.push(card(cause.category, `${V2_BLOCKER_LABELS[cause.category]} — ${V2_BLOCKER_ACTIONS[cause.category]}`,
        reasons, cause.stages));
    }
    if (why.unclassifiedCodes.length) {
      items.push(card('UNCLASSIFIED', 'NON CLASSÉ — motif inconnu de ce terminal',
        why.unclassifiedCodes.map((code) => ({ code, plain: null })), null));
    }
    el.v2WhyList.replaceChildren(...items);
  }

  function renderStages(view) {
    if (view.stages.length === 0) {
      el.v2Stages.replaceChildren(node('li', 'v2__empty', 'Aucun étage : entrée rejetée avant la chaîne.'));
      return;
    }
    // Un rafraîchissement garde les étages que le lecteur a dépliés.
    const opened = new Set([...el.v2Stages.querySelectorAll('details[open]')]
      .map((box) => box.parentElement.getAttribute('data-stage')));
    const all = el.v2StagesToggle.getAttribute('aria-pressed') === 'true';
    el.v2Stages.replaceChildren(fragmentOf(view.stages, (st) => {
      const li = node('li', 'stage', undefined, { 'data-capability': st.capability, 'data-state': st.state, 'data-stage': st.stage });
      const box = node('details', 'stage__box');
      box.open = all || opened.has(st.stage);
      const head = node('summary', 'stage__head');
      head.appendChild(node('span', 'stage__name', label(st.stage)));
      head.appendChild(node('span', 'stage__state', st.state));
      head.appendChild(node('span', 'stage__count', st.reasons.length ? `${st.reasons.length} motif(s)` : 'aucun motif'));
      head.appendChild(node('span', 'stage__cap', V2_CAPABILITY_LABELS[st.capability]));
      box.appendChild(head);
      const reasons = node('ul', 'stage__reasons');
      for (const r of st.reasons) {
        const category = r && has(V2_BLOCKER_LABELS, r.category) ? r.category : 'UNCLASSIFIED';
        const item = node('li', 'reason', undefined, { 'data-category': category });
        item.appendChild(node('span', 'reason__cat', V2_BLOCKER_LABELS[category] || 'NON CLASSÉ'));
        item.appendChild(node('span', 'reason__code', (r && r.code) || '?'));
        if (r && isText(r.plain)) item.appendChild(node('span', 'reason__plain', r.plain));
        reasons.appendChild(item);
      }
      if (st.reasons.length) box.appendChild(reasons);
      box.appendChild(node('div', 'stage__version', `${st.schemaVersion || '?'} · ${st.algorithmVersion || '?'}`));
      li.appendChild(box);
      return li;
    }));
  }

  function renderV2(view) {
    const problem = v2Problem(view);
    if (problem) {
      renderV2Unavailable('rejected', 'VUE V2 REFUSÉE', `Vue non conforme : ${problem}. Aucun état affiché.`);
      return;
    }
    const chain = view.chain;
    const temporal = view.temporal;
    const historical = temporal.classification === 'HISTORICAL';
    setAttr(el.v2Origin, 'data-state', 'simulated');
    setText(el.v2Origin, originText(view.origin));
    const when = historical ? 'HISTORIQUE' : temporal.classification === 'UNKNOWN' ? 'CUTOFF INCONNU' : 'CUTOFF À LA GÉNÉRATION';
    const mev = view.marketEvidence;
    // Données de marché rejouées : leur nature prime ; la chaîne reste un dry run.
    const market = mev ? `${V2_EVIDENCE_NATURE[mev.nature]} · ${V2_EVIDENCE_STATUS[mev.status]}` : null;
    setChainMode(historical ? 'historical' : 'simulated', market ? `${V2_EVIDENCE_NATURE[mev.nature]} · DRY RUN` : `SIMULATION · ${when}`,
      `${originText(view.origin)} · ${market ? `${market} · ` : ''}`
        + `${historical ? `HISTORIQUE — cutoff il y a ${fmtAge(temporal.cutoffAgeSeconds)}` : when}`
        + ' · PAS UNE ANALYSE RÉELLE');

    if (chain.outcome === 'REJECTED') {
      const r = chain.rejection || {};
      const errors = isList(r.inputErrors) ? r.inputErrors.slice(0, 4).join(' · ') : '';
      v2Status('rejected', 'HOLD — ENTRÉE REJETÉE',
        `Rejet à ${r.failedAt || 'étage inconnu'}${errors ? ` : ${errors}` : ''}${r.stageError ? ` — ${r.stageError}` : ''}`);
    } else if (chain.integrity !== 'CONSISTENT') {
      v2Status('rejected', 'HOLD — INTÉGRITÉ VIOLÉE',
        `${isList(chain.violations) ? chain.violations.length : 0} violation(s) : la chaîne n'est pas exploitable.`);
    } else {
      const findings = isList(chain.inputFindings) ? chain.inputFindings.length : 0;
      v2Status('hold', 'HOLD — EXÉCUTION INTERDITE',
        `Simulation locale, pas une analyse de marché réelle. Aucune décision positive approuvée${findings ? ` ; ${findings} entrée(s) rendue(s) plus restrictive(s)` : ''}.`);
    }
    renderSummary(view);
    renderWhy(view);

    setText(el.v2ChainState, chain.chainState);
    setText(el.v2Execution, 'INTERDITE');
    setText(el.v2Integrity, chain.integrity || 'N/A');
    setText(el.v2Cutoff, chain.knowledgeCutoff || 'N/A');
    setText(el.v2CutoffAge, isNum(temporal.cutoffAgeSeconds)
      ? `${fmtAge(temporal.cutoffAgeSeconds)}${historical ? ' — HISTORIQUE' : ''}` : 'N/A');
    setText(el.v2Digest, isText(chain.digest) ? chain.digest : 'N/A');
    setAttr(el.v2Digest, 'title', isText(chain.digest) ? chain.digest : null);
    setText(el.v2Generated, isText(view.generatedAt) ? `${fmtTimeUTC(view.generatedAt)} UTC` : 'N/A');

    renderStages(view);

    setText(el.v2MarketState, view.market.state ? `MP-0 ${view.market.state}` : '—');
    el.v2Market.replaceChildren(view.market.fields.length === 0
      ? v2EmptyRow(6, 'Aucun champ de marché.')
      : fragmentOf(view.market.fields, (f) => {
        const tr = v2Row([
          node('td', 'v2__field', String(f.field || '?').toUpperCase()),
          node('td', 'ta-r num', isNum(f.value) ? String(f.value) : 'N/A'),
          node('td', 'v2__state-cell', f.statusAtCutoff === 'LIVE' ? 'FRAIS AU CUTOFF' : f.statusAtCutoff),
          node('td', 'ta-r num', isNum(f.ageSecondsAtCutoff) ? fmtAge(f.ageSecondsAtCutoff) : 'N/A'),
          node('td', 'num', isText(f.observedAt) ? f.observedAt.replace('T', ' ').replace(/\.000Z$|Z$/, 'Z') : 'N/A'),
          node('td', '', f.source || 'N/A'),
        ]);
        tr.setAttribute('data-status', String(f.statusAtCutoff || 'UNKNOWN'));
        return tr;
      }));

    const replay = view.market.replay;
    setText(el.v2Replay, replay && isText(replay.mode)
      ? `${replay.mode}${replay.reproducible === true ? ' — reproductible' : ` — non reproductible${isText(replay.reason) ? ` (${replay.reason})` : ''}`}`
      : 'N/A');
    const pos = view.positioning || {};
    setText(el.v2Positioning, isText(pos.evidenceState)
      ? `${pos.evidenceState} · ${isNum(pos.evidenceCount) ? pos.evidenceCount : 0} preuve(s) · signal ${pos.positioningState || 'N/A'}`
      : 'N/A');
    setText(el.v2PositioningThrough, isText(pos.observedThrough) ? pos.observedThrough : 'N/A');
    setText(el.v2PositioningSources, isList(pos.sourceAuthorities) && pos.sourceAuthorities.length
      ? pos.sourceAuthorities.join(' · ') : 'N/A');

    renderReadiness(view);
    renderMarketEvidence(view.marketEvidence);

    const counts = {};
    for (const c of view.capabilities) counts[c.status] = (counts[c.status] || 0) + 1;
    setText(el.v2CapabilityCount, Object.keys(V2_CAPABILITY_LABELS)
      .map((k) => `${V2_CAPABILITY_LABELS[k]} ${counts[k] || 0}`).join(' · '));
    el.v2Capabilities.replaceChildren(fragmentOf(view.capabilities, (c) => {
      const li = node('li', 'cap', undefined, { 'data-capability': c.status });
      const head = node('div', 'cap__head');
      head.appendChild(node('span', 'cap__id', label(c.id || '?')));
      head.appendChild(node('span', 'cap__status', V2_CAPABILITY_LABELS[c.status]));
      li.appendChild(head);
      li.appendChild(node('p', 'cap__detail', c.detail));
      li.appendChild(node('p', 'cap__blockers', `Blocages : ${v2Blockers(c.blockers)}`));
      return li;
    }));
  }

  const known = (v) => (isText(v) ? v : 'INCONNU');
  const shortTime = (v) => (isText(v) ? v.replace('T', ' ').replace(/\.000Z$|Z$/, 'Z') : 'INCONNU');

  /** DATA-1 : provenance complète de chaque valeur retenue au cutoff. */
  function renderMarketEvidence(mev) {
    el.v2Mev.hidden = mev === null;
    if (mev === null) {
      el.v2MevObs.replaceChildren();
      return;
    }
    setAttr(el.v2Mev, 'data-status', mev.status);
    setAttr(el.v2Mev, 'data-nature', mev.nature);
    setText(el.v2MevStatus, `${V2_EVIDENCE_STATUS[mev.status]} · ${V2_EVIDENCE_NATURE[mev.nature]} · `
      + (mev.reproducible ? 'reproductible' : 'non reproductible'));
    setText(el.v2MevArchive, `${known(mev.archiveId)} · ${known(mev.provenanceClass)} · ${mev.recordCount} enregistrement(s)`);
    setText(el.v2MevCoverage, mev.coverage
      ? `${shortTime(mev.coverage.from)} → ${shortTime(mev.coverage.to)} — ${mev.coverage.statement}` : 'NON DÉCLARÉE');
    setText(el.v2MevDigest, `${known(mev.archiveDigest)}${mev.pinnedDigest ? ' (épinglée)' : ' (non épinglée)'}`);
    setText(el.v2MevReplay, mev.replayDigest);
    setText(el.v2MevReasons, mev.reasonCodes.length ? mev.reasonCodes.join(' · ') : 'aucun');
    setText(el.v2MevAudit, `${mev.recordsIngestedAfterCutoff} enregistrement(s) ingéré(s) après le cutoff`
      + `${isList(mev.correctedAfterCutoff) && mev.correctedAfterCutoff.length
        ? ` ; corrigé(s) plus tard : ${mev.correctedAfterCutoff.map((f) => String(f).toUpperCase()).join(', ')}` : ''}`);
    el.v2MevObs.replaceChildren(mev.observations.length === 0
      ? node('li', 'v2__empty', 'Aucune observation retenue au cutoff.')
      : fragmentOf(mev.observations, (o) => {
        const li = node('li', 'mev__item', undefined, { 'data-raw': o.raw });
        const head = node('div', 'mev__head');
        head.appendChild(node('span', 'mev__field', String(o.field || '?').toUpperCase()));
        head.appendChild(node('span', 'mev__value num', `${isNum(o.value) ? o.value : 'N/A'} ${known(o.unit)}`));
        head.appendChild(node('span', 'mev__raw', V2_RAW_STATES[o.raw]));
        li.appendChild(head);
        const dl = node('dl', 'mev__facts');
        for (const [k, v] of [
          ['INSTRUMENT · TYPE', `${known(o.instrument)} · ${known(o.observationType)}`],
          ['SOURCE · ID SOURCE', `${known(o.source)} · ${known(o.sourceRecordId)}`],
          ['OBSERVÉ', shortTime(o.observedAt)],
          ['PUBLIÉ', shortTime(o.publishedAt)],
          ['INGÉRÉ', shortTime(o.ingestedAt)],
          ['RÉVISION', `${known(o.revision)}${isText(o.supersedes) ? ` (corrige ${o.supersedes})` : ''}`],
          ['FRAÎCHEUR AU CUTOFF', `${o.freshnessAtCutoff === 'LIVE' ? 'FRAIS AU CUTOFF' : known(o.freshnessAtCutoff)} · ${fmtAge(o.ageSecondsAtCutoff)}`],
          ['EMPREINTE', known(o.recordDigest)],
        ]) {
          const row = node('div');
          row.appendChild(node('dt', '', k));
          row.appendChild(node('dd', '', v));
          dl.appendChild(row);
        }
        li.appendChild(dl);
        return li;
      }));
  }

  function renderReadiness(view) {
    el.v2Horizons.replaceChildren(view.horizons.length === 0
      ? node('li', 'v2__empty', 'Aucun horizon : entrée rejetée.')
      : fragmentOf(view.horizons, (h) => {
        const li = node('li', 'horizon', undefined, { 'data-status': h.status });
        li.appendChild(node('span', 'horizon__id', h.horizon));
        li.appendChild(node('span', 'horizon__status', h.status));
        li.appendChild(node('span', 'horizon__dir', 'aucune direction'));
        return li;
      }));
    const acc = view.acceptance;
    const declared = acc.evidence.filter((e) => e && e.declared === true).length;
    setText(el.v2AcceptanceState, acc.state ? `${acc.state} · ${declared}/${acc.evidence.length} DÉCLARÉES` : '—');
    el.v2Evidence.replaceChildren(acc.evidence.length === 0
      ? node('li', 'v2__empty', 'Aucun manifeste : entrée rejetée.')
      : fragmentOf(acc.evidence, (e) => {
        const ok = e && e.declared === true;
        const li = node('li', 'evidence__item', undefined, { 'data-declared': String(ok) });
        li.appendChild(node('span', 'evidence__mark', ok ? 'DÉCLARÉE' : 'MANQUANTE'));
        li.appendChild(node('span', 'evidence__label', V2_EVIDENCE_LABELS[e && e.key] || String(e && e.key)));
        return li;
      }));
    const obs = view.observability;
    setText(el.v2Observability, obs.state
      ? `${obs.state} · corrélation ${obs.correlationId || 'absente'} · déploiement ${obs.deploymentId || 'absent'}`
      : 'N/A');
  }

  /**
   * Navigation interne de l'espace CHAÎNE V2 : défilement vers une section
   * sans toucher à l'ancre (#chaine reste l'adresse de l'espace), et
   * dépliage de tous les étages en un clic.
   */
  function initChainNavigation() {
    for (const link of el.wsChain.querySelectorAll('.v2nav__link')) {
      link.addEventListener('click', () => {
        const target = document.getElementById(link.getAttribute('data-target'));
        if (!target || target.hidden) return;
        if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      });
    }
    el.v2StagesToggle.addEventListener('click', () => {
      const open = el.v2StagesToggle.getAttribute('aria-pressed') !== 'true';
      for (const box of el.v2Stages.querySelectorAll('details')) box.open = open;
      el.v2StagesToggle.setAttribute('aria-pressed', String(open));
      setText(el.v2StagesToggle, open ? 'TOUT REPLIER' : 'TOUT DÉPLIER');
    });
  }

  /* Scénario de simulation choisi ; null = l'entrée du serveur local. */
  let v2Scenario = null;
  /* Seule la dernière réponse demandée est affichée. */
  let v2Request = 0;

  /** Liste des scénarios du serveur local ; absente, le sélecteur reste caché. */
  async function loadScenarios() {
    if (!CONFIG.V2_SCENARIOS_URL) return;
    try {
      const response = await fetch(CONFIG.V2_SCENARIOS_URL, { headers: { accept: 'application/json' } });
      if (!response.ok) return;
      const list = await response.json();
      if (!isList(list)) return;
      const options = [node('option', '', 'Entrée du serveur', { value: '' })];
      for (const item of list) {
        if (!item || !/^[a-z0-9-]{1,64}$/.test(String(item.id)) || !isText(item.label)) continue;
        options.push(node('option', '', `${item.id} — ${item.label}`, { value: item.id }));
      }
      el.v2Scenario.replaceChildren(...options);
      el.v2ScenarioWrap.hidden = options.length < 2;
      el.v2Scenario.addEventListener('change', () => {
        v2Scenario = el.v2Scenario.value || null;
        refreshV2();
      });
    } catch { /* sans liste, l'entrée du serveur reste affichée */ }
  }

  async function refreshV2() {
    if (!CONFIG.V2_VIEW_URL) {
      renderV2Unavailable('unavailable', 'INDISPONIBLE',
        'Aucun runtime V2 déployé. En local : npm run terminal:local');
      return;
    }
    const request = ++v2Request;
    const url = v2Scenario ? `${CONFIG.V2_VIEW_URL}?scenario=${encodeURIComponent(v2Scenario)}` : CONFIG.V2_VIEW_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUNTIME.FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (request !== v2Request) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (request !== v2Request) return;
      renderV2(body);
    } catch (err) {
      if (request !== v2Request) return;
      renderV2Unavailable('error', 'VUE V2 INJOIGNABLE', `Serveur local injoignable — ${err.message}. HOLD conservé.`);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ======================================================================
     12. MODE DÉMO
     ====================================================================== */

  /**
   * Sans backend configuré, le terminal s'anime avec des données de
   * démonstration explicitement signalées. Objectif : valider le déploiement
   * GitHub Pages et la mise en page avant que la base ne soit en ligne.
   * Le bandeau MODE DÉMO empêche toute confusion avec des données réelles.
   */
  function startDemo() {
    el.demoFlag.hidden = false;
    setTransport('demo');

    let price = 3412.40;
    const macro = { dxy: 97.842, us10y: 4.213, real_yield: 1.874, vix: 16.42, wti: 68.31 };

    const tick = () => {
      price += (Math.random() - 0.5) * 1.8;
      const spread = 0.28 + Math.random() * 0.12;
      renderQuote({
        close: price,
        bid: price - spread / 2,
        ask: price + spread / 2,
        spread,
        ts: new Date().toISOString(),
        staleness_seconds: 0,
      });

      for (const key of Object.keys(macro)) {
        macro[key] += (Math.random() - 0.5) * (key === 'vix' ? 0.14 : 0.012);
      }
      renderMacro([{
        symbol: 'XAUUSD',
        dxy_value: macro.dxy,
        us10y_yield: macro.us10y,
        real_yield: macro.real_yield,
        vix: macro.vix,
        wti: macro.wti,
      }]);
    };

    tick();
    setInterval(tick, 2000);

    renderNews([
      {
        id: 'demo-1', title: '[DÉMO] Fed maintient ses taux et signale une pause prolongée face à une inflation sous-jacente persistante',
        news_score: 86.2, classification: 'critical', gold_direction_impact: 'bullish',
        region: 'US', category: 'monetary_policy', ts: new Date(Date.now() - 6e5).toISOString(),
      },
      {
        id: 'demo-2', title: '[DÉMO] CPI américain ressort à 3.4% contre 3.1% attendu',
        news_score: 74.5, classification: 'major', gold_direction_impact: 'bullish',
        region: 'US', category: 'inflation', ts: new Date(Date.now() - 24e5).toISOString(),
      },
      {
        id: 'demo-3', title: '[DÉMO] Tensions renforcées autour du détroit d\'Ormuz après un incident naval',
        news_score: 68.9, classification: 'major', gold_direction_impact: 'bullish',
        region: 'MENA', category: 'geopolitics', ts: new Date(Date.now() - 42e5).toISOString(),
      },
    ]);

    /* Aucune analyse n'est fabriquée : un setup, un verdict ou des scénarios
       inventés seraient lus comme une décision. Le mode démo montre l'état
       honnête d'un terminal sans analyse. */
    renderNoAnalysis('NO_DATA', 'MODE DÉMO — aucune analyse réelle. Aucun setup, verdict ni scénario n\'est simulé.');
  }

  /* ======================================================================
     13. HORLOGE ET DÉMARRAGE
     ====================================================================== */

  function startClock() {
    const tick = () => {
      const now = new Date();
      setText(el.clock, [now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()]
        .map((n) => String(n).padStart(2, '0')).join(':'));
      setText(el.sessionLabel, currentSession(now));
    };
    tick();
    setInterval(tick, 1000);
  }

  function init() {
    startClock();

    setMarketMode(DEMO_MODE ? 'demo' : 'connecting');
    initWorkspaces();

    initChainNavigation();

    /* La vue V2 est indépendante du flux V1 : elle est lue dans les deux modes. */
    loadScenarios();
    refreshV2();
    if (CONFIG.V2_VIEW_URL) setInterval(refreshV2, CONFIG.ANALYSIS_INTERVAL_MS);

    el.errorRetry.addEventListener('click', () => {
      clearError();
      if (DEMO_MODE) return;
      pollCycle();
      analysisCycle();
      if (state.transport !== 'websocket') {
        state.wsAttempts = 0;
        connectWebSocket();
      }
    });

    if (DEMO_MODE) {
      console.info('[alpha-xau] MODE DÉMO — renseigner window.ALPHA_XAU_CONFIG pour connecter le backend.');
      startDemo();
      return;
    }

    connectWebSocket();
    startPolling();
    analysisCycle();
    analysisTimer = setInterval(analysisCycle, CONFIG.ANALYSIS_INTERVAL_MS);

    /* Onglet en arrière-plan : on suspend le polling pour ne pas consommer
       le quota API inutilement, et on resynchronise au retour. */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
        analysisCycle();
      }
    });

    window.addEventListener('online', () => {
      clearError();
      state.wsAttempts = 0;
      connectWebSocket();
      startPolling();
    });

    window.addEventListener('offline', () => {
      reportError('Navigateur hors ligne.');
      reportError('Navigateur hors ligne.');
    });

    window.addEventListener('beforeunload', () => {
      stopPolling();
      if (analysisTimer) clearInterval(analysisTimer);
      cleanupSocket();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
