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
    V2_ARCHIVE_CUTOFFS_URL: '',
    V2_CATALOG_URL: '',
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
    v2ScenarioHint: $('v2-scenario-hint'),
    v2WhyCutoffs: $('v2-why-cutoffs'),
    v2DataWrap: $('v2-data-wrap'),
    v2DataMarket: $('v2-data-market'),
    v2DataPositioning: $('v2-data-positioning'),
    v2DataEvents: $('v2-data-events'),
    v2DataReal: $('v2-data-real'),
    v2DataCardEvents: $('v2-data-card-events'),
    v2OfficialEvents: $('v2-official-events'),
    v2OfficialEventsNote: $('v2-official-events-note'),
    v2OfficialEventsList: $('v2-official-events-list'),
    v2DataHint: $('v2-data-hint'),
    v2DataCardMarket: $('v2-data-card-market'),
    v2DataCardPositioning: $('v2-data-card-positioning'),
    v2ReplayCutoffWrap: $('v2-replay-cutoff-wrap'),
    v2ReplayCutoff: $('v2-replay-cutoff'),
    v2ReplayCutoffHint: $('v2-replay-cutoff-hint'),
    v2ArchiveAvail: $('v2-archive-avail'),
    v2CapturesFailed: $('v2-captures-failed'),
    v2ArchiveAvailList: $('v2-archive-avail-list'),
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
    v2MarketLegend: $('v2-market-legend'),
    v2MarketState: $('v2-market-state'),
    v2Replay: $('v2-replay'),
    v2Positioning: $('v2-positioning'),
    v2PositioningFreshness: $('v2-positioning-freshness'),
    v2PositioningThrough: $('v2-positioning-through'),
    v2PositioningSources: $('v2-positioning-sources'),
    v2PositioningEvidence: $('v2-positioning-evidence'),
    v2PositioningEvidenceNote: $('v2-positioning-evidence-note'),
    v2PositioningEvidenceGroups: $('v2-positioning-evidence-groups'),
    v2Capabilities: $('v2-capabilities'),
    v2Mev: $('v2-mev'),
    v2Prov: $('v2-prov'),
    v2ProvStatus: $('v2-prov-status'),
    v2ProvList: $('v2-prov-list'),
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
      if (DEMO_MODE) {
        // Synthetic values move at random: reading a gold impact into them would be a fake signal.
        setText(impactCell, 'N/A — DÉMO');
        setAttr(impactCell, 'data-impact', 'unavailable');
      } else if (change === null || movement === 'flat' || !rule) {
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

      node.setAttribute('data-class', DEMO_MODE ? 'demo' : klass);
      /* Signale visuellement uniquement ce qui n'avait jamais été affiché. */
      if (!state.seenNewsIds.has(row.id)) {
        node.classList.add('stream__item--new');
        state.seenNewsIds.add(row.id);
      }

      const chip = node.querySelector('[data-field="classification"]');
      setText(chip, DEMO_MODE ? 'DÉMO' : klass === 'critical' ? 'CATALYST' : klass === 'major' ? 'MAJOR' : 'NOISE');
      setAttr(chip, 'data-class', DEMO_MODE ? 'demo' : klass);

      setText(node.querySelector('[data-field="score"]'),
        DEMO_MODE ? 'NON ÉVALUÉ' : isNum(row.news_score) ? `${row.news_score.toFixed(1)}/100` : 'N/A');
      setText(node.querySelector('[data-field="time"]'), DEMO_MODE ? 'HEURE FICTIVE' : fmtTimeUTC(row.ts));
      setText(node.querySelector('[data-field="title"]'), row.title);
      setText(node.querySelector('[data-field="region"]'), row.region);
      setText(node.querySelector('[data-field="category"]'),
        String(row.category || '').replace(/_/g, ' ').toUpperCase());

      const impact = node.querySelector('[data-field="impact"]');
      const dir = String(row.gold_direction_impact || 'neutral');
      setText(impact, DEMO_MODE ? 'OR — NON ÉVALUÉ (DÉMO)' : `OR ${dir === 'bullish' ? '▲ HAUSSIER' : dir === 'bearish' ? '▼ BAISSIER' : '— NEUTRE'}`);
      setAttr(impact, 'data-dir', DEMO_MODE ? 'unavailable' : dir);

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
    let initial = window.location.hash === '#chaine' || window.location.hash.startsWith('#chaine/') ? 'chain' : 'market';
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

  /* B4 : provenance par entrée. Seul le marché peut venir d'une archive ; rien n'est dit observé ni validé. */
  const V2_INPUTS = ['MARKET', 'POSITIONING', 'EVENT_IMPACT', 'GOLD_TRANSMISSION', 'EVIDENCE_GRAPH', 'AUTHORIZATIONS'];
  const V2_INPUT_LABELS = {
    MARKET: 'MARCHÉ',
    POSITIONING: 'POSITIONNEMENT',
    EVENT_IMPACT: 'EVENT IMPACT',
    GOLD_TRANSMISSION: 'GOLD TRANSMISSION',
    EVIDENCE_GRAPH: 'GRAPHE DE PREUVES',
    AUTHORIZATIONS: 'AUTORISATIONS',
  };
  const V2_SOURCE_LABELS = {
    CAPTURED_ARCHIVE: 'ARCHIVE CAPTURÉE — NON CERTIFIÉE',
    SYNTHETIC_FIXTURE: 'FIXTURE SYNTHÉTIQUE',
    LOCAL_INPUT_UNVERIFIED: 'FICHIER LOCAL NON VÉRIFIÉ',
    UNAVAILABLE: 'NON DISPONIBLE',
    UNKNOWN: 'PROVENANCE INCONNUE',
  };

  /** Sources des entrées non marché, sans les entrées absentes ; null si la vue ne les donne pas. */
  const otherSources = (prov) => (prov === undefined ? null
    : [...new Set(prov.slice(1).filter((e) => e.source !== 'UNAVAILABLE').map((e) => V2_SOURCE_LABELS[e.source]))]);

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
      // Une archive illisible ou mal formée n'a pas de classe : rejetée, rien retenu, présentée comme simulation.
      const unreadable = mev.status === 'INVALID' && mev.provenanceClass === null;
      if (unreadable && (mev.nature !== 'SIMULATION' || mev.observations.length > 0)) return 'archive rejetée incohérente';
      if (!unreadable && mev.nature === 'SIMULATION' && mev.provenanceClass !== 'SYNTHETIC_FIXTURE') return 'nature de marché incohérente';
      if (!unreadable && mev.nature !== 'SIMULATION' && mev.provenanceClass !== 'CAPTURED') return 'nature de marché incohérente';
      if (mev.nature === 'HISTORICAL_VERIFIED' && (mev.status !== 'VERIFIED' || mev.observations.length === 0
          || mev.observations.some((o) => o.raw !== 'RAW_VERIFIED'))) return 'historique vérifié non prouvé';
    }
    const prov = view.inputProvenance;
    if (prov !== undefined) {
      if (!isList(prov) || prov.length !== V2_INPUTS.length
          || prov.some((e, i) => !e || e.input !== V2_INPUTS[i] || !has(V2_SOURCE_LABELS, e.source) || typeof e.detail !== 'string')) {
        return 'provenance des entrées non conforme';
      }
      // Seul le marché peut venir d'une archive, et seulement si son manifeste le dit.
      if (prov.slice(1).some((e) => e.source === 'CAPTURED_ARCHIVE')) return 'provenance contradictoire (entrée non marché attribuée à une archive)';
      if (prov[0].source === 'CAPTURED_ARCHIVE' && (!mev || mev.provenanceClass !== 'CAPTURED')) return 'provenance du marché contradictoire';
      if (prov[0].source === 'SYNTHETIC_FIXTURE' && mev && mev.provenanceClass === 'CAPTURED') return 'provenance du marché contradictoire';
    }
    // B5 : aucun seuil de fraîcheur n'est approuvé ; une preuve de positionnement n'est jamais « prête ».
    const pos = view.positioning;
    if (pos && pos.evidenceState === 'EVIDENCE_READY') return 'positionnement déclaré prêt sans seuil de fraîcheur approuvé';
    const fresh = pos && pos.freshness;
    if (pos && isNum(pos.evidenceCount) && pos.evidenceCount > 0
        && (!fresh || !['NOT_EVALUATED', 'AFTER_KNOWLEDGE_CUTOFF'].includes(fresh.status) || !isText(fresh.plain))) return 'fraîcheur du positionnement non conforme';
    if (fresh !== undefined && (!fresh || !['NOT_EVALUATED', 'NO_EVIDENCE', 'AFTER_KNOWLEDGE_CUTOFF'].includes(fresh.status))) return 'fraîcheur du positionnement non conforme';
    // Une preuve postérieure au cutoff n'était pas connue : elle n'a pas d'âge ; une preuve connue n'a pas d'âge négatif.
    if (fresh && fresh.status === 'AFTER_KNOWLEDGE_CUTOFF'
        && (fresh.publishedAgeSecondsAtCutoff !== null || !(isNum(pos.evidenceCount) && pos.evidenceCount > 0))) return 'fraîcheur du positionnement non conforme';
    if (fresh && isNum(fresh.publishedAgeSecondsAtCutoff) && fresh.publishedAgeSecondsAtCutoff < 0) return 'fraîcheur du positionnement non conforme';
    // 4.7.0 : des publications officielles derrière les résumés macro ne s'affichent que si la provenance le dit.
    const oe = view.officialEvents;
    if (oe !== undefined && oe !== null) {
      if (typeof oe !== 'object' || !isList(oe.known) || !isList(oe.notYetPublished) || !isText(oe.label)) return 'événements officiels non conformes';
      const evProv = isList(view.inputProvenance) ? view.inputProvenance.find((e) => e && e.input === 'EVENT_IMPACT') : null;
      if (evProv && evProv.source !== 'LOCAL_INPUT_UNVERIFIED' && evProv.source !== 'UNAVAILABLE') return 'provenance des événements contradictoire';
    }
    // 4.6.0 : les valeurs brutes, quand elles sont données, sont exactement celles que P-0 a gardées.
    if (pos && pos.evidence !== undefined) {
      if (!isList(pos.evidence) || pos.evidence.some((r) => !r || !isText(r.metricCode) || !isNum(r.value) || typeof r.afterCutoff !== 'boolean')
          || (pos.evidenceTruncated !== true && pos.evidence.length !== pos.evidenceCount)) return 'preuves de positionnement non conformes';
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
    // Rôles explicites : en disposition étroite le tableau passe en grille CSS, et certains
    // lecteurs d'écran perdraient sinon la sémantique de tableau.
    tr.setAttribute('role', 'row');
    for (const cell of cells) {
      cell.setAttribute('role', 'cell');
      tr.appendChild(cell);
    }
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
    el.v2Prov.hidden = true;
    el.v2ProvList.replaceChildren();
    for (const n of [el.v2ChainState, el.v2Execution, el.v2Integrity, el.v2Cutoff, el.v2CutoffAge, el.v2Digest,
      el.v2Generated, el.v2Replay, el.v2Positioning, el.v2PositioningFreshness, el.v2PositioningThrough, el.v2PositioningSources,
      el.v2MarketState]) {
      setText(n, '—');
    }
    setAttr(el.v2Digest, 'title', null);
    el.v2Stages.replaceChildren(node('li', 'v2__empty', '—'));
    el.v2Market.replaceChildren(v2EmptyRow(6, '—'));
    el.v2MarketLegend.hidden = true;
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
      el.v2Why.hidden = false;
      setText(el.v2WhyLead, 'Entrée rejetée avant la chaîne : aucun étage n\'a été évalué. '
        + 'Corriger l\'entrée signalée dans DONNÉES MANQUANTES ; aucune décision n\'est possible.');
      setText(el.v2WhyLift, '');
      el.v2WhyCutoffs.hidden = true;
      el.v2WhyList.replaceChildren();
      return;
    }
    // 4.5.0 : des entrées précalculées à un autre cutoff que la chaîne (rejeu d'archive), dit en clair.
    const align = view.cutoffAlignment;
    const misaligned = align && typeof align === 'object' && align.aligned === false && isText(align.plain);
    setText(el.v2WhyCutoffs, misaligned ? align.plain : '');
    el.v2WhyCutoffs.hidden = !misaligned;
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
    // B4 : l'archive ne porte que le marché ; les autres entrées sont nommées à côté.
    const others = view.origin.kind === 'LOCAL_MARKET_ARCHIVE' ? otherSources(view.inputProvenance) : undefined;
    const othersText = others === undefined ? ''
      : others === null ? 'PROVENANCE DES AUTRES ENTRÉES NON FOURNIE · '
        : `AUTRES ENTRÉES : ${others.length ? others.join(' / ') : 'NON DISPONIBLES'} · `;
    setChainMode(historical ? 'historical' : 'simulated', market ? `${V2_EVIDENCE_NATURE[mev.nature]} · DRY RUN` : `SIMULATION · ${when}`,
      `${originText(view.origin)} · ${othersText}${market ? `${market} · ` : ''}`
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
    el.v2MarketLegend.hidden = view.market.fields.length === 0; // nothing to qualify as fresh
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
    const fresh = pos.freshness;
    setText(el.v2PositioningFreshness, fresh && isText(fresh.plain)
      ? `${fresh.plain}${isNum(fresh.publishedAgeSecondsAtCutoff) ? ` · publiée ${fmtAge(fresh.publishedAgeSecondsAtCutoff)} avant le cutoff` : ''}`
      : 'N/A');
    setText(el.v2PositioningThrough, isText(pos.observedThrough)
      ? `${pos.observedThrough}${fresh && fresh.status === 'AFTER_KNOWLEDGE_CUTOFF' ? ' (après le cutoff)' : ''}` : 'N/A');
    setText(el.v2PositioningSources, isList(pos.sourceAuthorities) && pos.sourceAuthorities.length
      ? pos.sourceAuthorities.join(' · ') : 'N/A');
    renderPositioningEvidence(pos);
    renderOfficialEvents(view.officialEvents);

    renderReadiness(view);
    renderMarketEvidence(view.marketEvidence);
    renderInputProvenance(view.inputProvenance);

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
  /** B4 : une ligne par entrée ; une vue sans ce champ le dit, sans rien supposer. */
  function renderInputProvenance(prov) {
    el.v2Prov.hidden = false;
    if (prov === undefined) {
      setText(el.v2ProvStatus, 'PROVENANCE PAR ENTRÉE NON FOURNIE — considérer chaque entrée comme d\'origine inconnue.');
      el.v2ProvList.replaceChildren();
      return;
    }
    const others = otherSources(prov);
    setText(el.v2ProvStatus, `MARCHÉ : ${V2_SOURCE_LABELS[prov[0].source]} · AUTRES ENTRÉES : `
      + `${others.length ? others.join(' / ') : 'NON DISPONIBLES'}`);
    el.v2ProvList.replaceChildren(fragmentOf(prov, (e) => {
      const li = node('li', 'prov__item', undefined, { 'data-input': e.input, 'data-source': e.source });
      const head = node('div', 'prov__head');
      head.appendChild(node('span', 'prov__input', V2_INPUT_LABELS[e.input]));
      head.appendChild(node('span', 'prov__source', V2_SOURCE_LABELS[e.source]));
      li.appendChild(head);
      li.appendChild(node('p', 'prov__detail', e.detail));
      return li;
    }));
  }

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

  /**
   * Choix restituables par l'ancre : #chaine/scenario/<id> ou #chaine/rejeu/<instant UTC>.
   * Lus au chargement (appliqués seulement si l'option existe), réécrits à chaque choix.
   */
  const V2_HASH = /^#chaine\/(scenario|rejeu)\/([A-Za-z0-9:.-]{1,64})$/;
  // Données locales choisies : #chaine/donnees/<marché>/<positionnement>[/rejeu/<instant>] (identifiants du catalogue).
  const V2_DATA_HASH = /^#chaine\/donnees\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\/evenements\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127}))?(?:\/rejeu\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z))?$/;
  const requestedChoice = (() => {
    const d = V2_DATA_HASH.exec(window.location.hash);
    if (d) return { kind: 'donnees', market: d[1], positioning: d[2], events: d[3] ?? null, value: d[4] ?? null };
    const m = V2_HASH.exec(window.location.hash);
    return m ? { kind: m[1], value: decodeURIComponent(m[2]) } : null;
  })();
  /* Sources de données choisies (identifiants du catalogue) ; null = celles du serveur. */
  let v2Market = null;
  let v2Positioning = null;
  let v2Events = null;
  let v2Catalog = null;
  const dataChosen = () => v2Catalog !== null && ((v2Market !== null && v2Market !== v2Catalog.defaults.market)
    || (v2Positioning !== null && v2Positioning !== v2Catalog.defaults.positioning)
    || (v2Events !== null && v2Events !== v2Catalog.defaults.events));
  function writeChoiceToHash() {
    const market = v2Market ?? v2Catalog?.defaults.market;
    const positioning = v2Positioning ?? v2Catalog?.defaults.positioning;
    const hash = v2Scenario ? `#chaine/scenario/${v2Scenario}`
      : dataChosen() ? `#chaine/donnees/${market}/${positioning}${v2Events !== null && v2Events !== v2Catalog.defaults.events ? `/evenements/${v2Events}` : ''}`
        + `${v2ReplayCutoff ? `/rejeu/${v2ReplayCutoff}` : ''}`
        : v2ReplayCutoff ? `#chaine/rejeu/${v2ReplayCutoff}` : '#chaine';
    if (window.location.hash !== hash) {
      try { window.history.replaceState(null, '', hash); } catch { /* ancre non modifiable : choix gardé en mémoire */ }
    }
  }
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
      const count = options.length - 1;
      setText(el.v2ScenarioHint, `${count} scénario${count > 1 ? 's' : ''} ${count > 1 ? 'locaux' : 'local'} à comparer : chacun est une simulation, jamais une donnée de marché, et reste HOLD, exécution interdite.`);
      el.v2ScenarioWrap.hidden = options.length < 2;
      el.v2Scenario.addEventListener('change', () => {
        v2Scenario = el.v2Scenario.value || null;
        // Le cutoff de rejeu et les données locales ne s'appliquent qu'à l'entrée du serveur, jamais à un scénario.
        el.v2ReplayCutoff.disabled = v2Scenario !== null;
        el.v2DataMarket.disabled = v2Scenario !== null;
        el.v2DataPositioning.disabled = v2Scenario !== null;
        el.v2DataEvents.disabled = v2Scenario !== null;
        el.v2DataReal.disabled = v2Scenario !== null;
        writeChoiceToHash();
        refreshV2();
      });
      if (requestedChoice && requestedChoice.kind === 'scenario'
          && options.some((o) => o.value === requestedChoice.value && o.value !== '')) {
        el.v2Scenario.value = requestedChoice.value;
        v2Scenario = requestedChoice.value;
        el.v2ReplayCutoff.disabled = true;
        el.v2DataMarket.disabled = true;
        el.v2DataPositioning.disabled = true;
        el.v2DataEvents.disabled = true;
        el.v2DataReal.disabled = true;
        refreshV2();
      }
    } catch { /* sans liste, l'entrée du serveur reste affichée */ }
  }

  const V2_DATA_KINDS = {
    INPUT_DOCUMENT: 'document d\'entrée', ARCHIVE_FILE: 'archive locale', CAPTURES_MERGED: 'captures fusionnées',
    CAPTURE_LOG: 'journal de capture', CFTC_FILE: 'fichier CFTC COT', OFFICIAL_RELEASES: 'publications officielles',
  };
  const V2_CLASS_LABELS = { CAPTURED: 'CAPTURÉE (déclarée par l\'opérateur)', SYNTHETIC_FIXTURE: 'SYNTHÉTIQUE' };
  const V2_COT_STATUS = { EXTRACTED: 'LU — 14 mesures brutes, aucune méthode approuvée', REJECTED: 'REJETÉ', DOCUMENT: 'celui du document' };
  const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
  const instant = (at) => (isText(at) ? at.replace('T', ' ').replace(/\.000Z$/, 'Z') : '—');

  /**
   * Les sources réelles disponibles, choisies par des règles explicites (aucun jugement de qualité) :
   * marché = captures fusionnées si la fusion a réussi, sinon l'archive capturée reçue le plus récemment ;
   * positionnement = le fichier CFTC lu au rapport le plus récent ; événements = publications officielles
   * locales lues, sinon celles du dépôt. null pour un composant sans source réelle.
   */
  function realPreset(c) {
    const usable = (m) => m.replayable === true && m.provenanceClass === 'CAPTURED' && m.validation && m.validation.status !== 'INVALID'
      && !(isList(m.problems) && m.problems.length);
    const merged = c.market.filter((m) => m.kind === 'CAPTURES_MERGED' && usable(m));
    const others = c.market.filter((m) => m.kind !== 'CAPTURES_MERGED' && usable(m))
      .sort((a, b) => String(b.received?.last ?? '').localeCompare(String(a.received?.last ?? '')));
    const market = (merged[0] || others[0] || null);
    const cot = c.positioning.filter((p) => p.kind === 'CFTC_FILE' && p.status === 'EXTRACTED')
      .sort((a, b) => String(b.reportDate ?? '').localeCompare(String(a.reportDate ?? '')))[0] || null;
    const readCount = (e) => (isList(e.releases) ? e.releases.filter((r) => r.status === 'RESOLVED').length : 0);
    const events = (c.events || []).find((e) => e.id === 'official:local' && readCount(e) > 0)
      || (c.events || []).find((e) => e.id === 'official:repository' && readCount(e) > 0) || null;
    return { market: market && market.id, positioning: cot && cot.id, events: events && events.id };
  }

  /** Fiche d'une source : chaque ligne est un fait du catalogue, jamais un jugement. */
  function dataCard(target, title, rows) {
    const nodes = [node('dt', 'v2__data-card-title', title)];
    for (const [key, value] of rows) {
      nodes.push(node('dt', '', key));
      nodes.push(node('dd', '', value));
    }
    target.replaceChildren(...nodes);
  }

  function renderDataCards() {
    if (v2Catalog === null) return;
    const m = v2Catalog.market.find((x) => x.id === (v2Market ?? v2Catalog.defaults.market));
    if (m) {
      const v = m.validation;
      dataCard(el.v2DataCardMarket, `MARCHÉ — ${m.label}`, m.kind === 'INPUT_DOCUMENT'
        ? [['Type', V2_DATA_KINDS[m.kind]], ['Contenu', 'instantané de marché du document (fixture synthétique ou fichier --input)'], ['Rejeu', 'aucun : pas d\'archive']]
        : [
          ['Type', V2_DATA_KINDS[m.kind] || label(m.kind)],
          ['Provenance', `${V2_CLASS_LABELS[m.provenanceClass] || 'INCONNUE'}${isText(m.archiveId) ? ` · ${m.archiveId}` : ''}`],
          ['Enregistrements', isNum(m.records) ? `${m.records} · champs : ${isList(m.fields) && m.fields.length ? m.fields.map((f) => String(f).toUpperCase()).join(', ') : 'aucun'}` : '—'],
          ['Période observée', m.observed ? `${instant(m.observed.first)} → ${instant(m.observed.last)}` : '—'],
          ['Période reçue', m.received ? `${instant(m.received.first)} → ${instant(m.received.last)}` : '—'],
          ['Couverture déclarée', m.coverage ? `${instant(m.coverage.from)} → ${instant(m.coverage.to)}` : 'NON DÉCLARÉE'],
          ['Validation', v ? `${V2_EVIDENCE_STATUS[v.status] || label(v.status)}${v.nature ? ` · ${V2_EVIDENCE_NATURE[v.nature] || label(v.nature)}` : ''}${v.at ? ` (rejeu au ${instant(v.at)})` : ''}` : '—'],
          ['Raisons', v && isList(v.reasonCodes) && v.reasonCodes.length ? v.reasonCodes.map(label).join(' · ') : 'aucune'],
          ...(isList(m.problems) && m.problems.length ? [['Problèmes', m.problems.map(String).join(' · ')]] : []),
        ]);
    }
    const ev = (v2Catalog.events || []).find((x) => x.id === (v2Events ?? v2Catalog.defaults.events));
    if (ev) {
      const releases = isList(ev.releases) ? ev.releases : [];
      dataCard(el.v2DataCardEvents, `ÉVÉNEMENTS MACRO — ${ev.label}`, ev.kind === 'INPUT_DOCUMENT'
        ? [['Type', V2_DATA_KINDS[ev.kind]], ['Contenu', 'résumés Event Impact / Gold Transmission du document (synthétiques pour la fixture)']]
        : [
          ['Type', `${V2_DATA_KINDS[ev.kind]} · documents non vérifiés à l'exécution`],
          ['Lues', releases.filter((r) => r.status === 'RESOLVED').map((r) => `${r.family} ${r.period} (publiée ${instant(r.publishedAt)})`).join(' · ') || 'aucune'],
          ['Rejetées', releases.filter((r) => r.status !== 'RESOLVED').map((r) => `${r.name} : ${label(r.reason)}`).join(' · ') || 'aucune'],
          ['Usage', 'agrégées par EIA-0 v2 au cutoff de la chaîne : une publication postérieure au cutoff est exclue'],
        ]);
    }
    const p = v2Catalog.positioning.find((x) => x.id === (v2Positioning ?? v2Catalog.defaults.positioning));
    if (p) {
      dataCard(el.v2DataCardPositioning, `POSITIONNEMENT — ${p.label}`, p.kind === 'INPUT_DOCUMENT'
        ? [['Type', V2_DATA_KINDS[p.kind]], ['Contenu', 'preuves de positionnement du document (synthétiques pour la fixture)']]
        : [
          ['Type', `${V2_DATA_KINDS[p.kind] || label(p.kind)} · source NON APPROUVÉE`],
          ['État', p.status === 'EXTRACTED' ? `LU — ${isNum(p.metrics) ? p.metrics : '?'} mesures brutes, aucune méthode approuvée` : V2_COT_STATUS[p.status] || label(p.status)],
          ['Jeu déclaré', p.dataset === 'FUTURES_ONLY' ? 'futures seuls' : p.dataset === 'FUTURES_AND_OPTIONS_COMBINED' ? 'futures et options' : '—'],
          ['Rapport du', isText(p.reportDate) ? p.reportDate : '—'],
          ['Rapports dans le fichier', p.fileReports && isNum(p.fileReports.count)
            ? `${p.fileReports.count} (${p.fileReports.first} → ${p.fileReports.last}) · un seul est lu : celui déclaré` : '—'],
          ['Publié / reçu (déclarés)', `${instant(p.publishedAt)} / ${instant(p.receivedAt)}`],
          ['Empreinte', isText(p.artifactId) ? p.artifactId : '—'],
          ['Liée aux octets', p.boundToBytes === true ? 'oui : la déclaration porte cette empreinte' : p.boundToBytes === false ? 'non (déclaration sans empreinte)' : '—'],
          ['Source déclarée', isText(p.sourceUrl) ? `${p.sourceUrl} (déclarée par l'opérateur, non vérifiée)` : '—'],
          ['Base de la date de publication', p.publicationBasis && isText(p.publicationBasis.reference)
            ? `${p.publicationBasis.kind === 'EXPLICIT_OFFICIAL_MAPPING' ? 'document officiel associant ce rapport à sa date'
              : p.publicationBasis.kind === 'OFFICIAL_SCHEDULE_INFERRED' ? 'DÉDUITE du calendrier officiel provisoire (non prouvée pour ce rapport)' : 'inconnue'} — ${p.publicationBasis.reference}`
            : 'non indiquée (déclaration de l\'opérateur seule)'],
          ['Le fichier indique', `${isText(p.fileDatasetMarker) ? `FutOnly_or_Combined = ${p.fileDatasetMarker}` : 'aucun marqueur de jeu'}${isText(p.dateColumn) ? ` · date lue : ${p.dateColumn}` : ''}`],
          ...(p.status !== 'EXTRACTED' ? [['Raison', `${isList(p.reasonCodes) ? p.reasonCodes.map(label).join(' · ') : ''}${isText(p.detail) ? ` — ${p.detail}` : ''}`]] : []),
        ]);
    }
  }

  /** Données locales du serveur (--data-root, --archive, --captures, --positioning-cot) ; sans choix possible, panneau caché. */
  async function loadCatalog() {
    if (!CONFIG.V2_CATALOG_URL) return false;
    try {
      const response = await fetch(CONFIG.V2_CATALOG_URL, { headers: { accept: 'application/json' } });
      if (!response.ok) return false;
      const c = await response.json();
      if (!c || c.schemaVersion !== 'xau.terminal-data-catalog.v1' || !isList(c.market) || !isList(c.positioning) || !c.defaults) return false;
      const market = c.market.filter((x) => x && isId(x.id) && isText(x.label) && has(V2_DATA_KINDS, x.kind));
      const positioning = c.positioning.filter((x) => x && isId(x.id) && isText(x.label) && has(V2_DATA_KINDS, x.kind));
      const events = (isList(c.events) ? c.events : []).filter((x) => x && isId(x.id) && isText(x.label) && has(V2_DATA_KINDS, x.kind));
      const eventsDefault = isText(c.defaults.events) && events.some((x) => x.id === c.defaults.events) ? c.defaults.events : null;
      if (!market.some((x) => x.id === c.defaults.market) || !positioning.some((x) => x.id === c.defaults.positioning)) return false;
      v2Catalog = { defaults: { market: c.defaults.market, positioning: c.defaults.positioning, events: eventsDefault }, market, positioning, events };
      const optionOf = (x, extra) => node('option', '', `${x.label} — ${V2_DATA_KINDS[x.kind]}${extra(x)}`, { value: x.id });
      el.v2DataMarket.replaceChildren(...market.map((x) => optionOf(x, (m) => (m.validation ? ` · ${V2_EVIDENCE_STATUS[m.validation.status] || label(m.validation.status)}` : ''))));
      el.v2DataPositioning.replaceChildren(...positioning.map((x) => optionOf(x, (p) => (p.kind === 'CFTC_FILE' ? ` · ${p.status === 'EXTRACTED' ? 'LU' : 'REJETÉ'}` : ''))));
      el.v2DataMarket.value = c.defaults.market;
      el.v2DataPositioning.value = c.defaults.positioning;
      el.v2DataEvents.replaceChildren(...events.map((x) => optionOf(x, (e) => (e.kind === 'OFFICIAL_RELEASES'
        ? ` · ${e.releases.filter((r) => r.status === 'RESOLVED').length} lue(s)` : ''))));
      if (eventsDefault) el.v2DataEvents.value = eventsDefault;
      const notes = Array.isArray(c.notes) ? c.notes.filter((n) => typeof n === 'string').slice(0, 8) : [];
      // Rien à choisir mais des remarques (dossier absent…) : le panneau les dit, sans sélecteur inutile.
      el.v2DataWrap.hidden = market.length < 2 && positioning.length < 2 && events.length < 2 && notes.length === 0;
      setText(el.v2DataHint, `${market.length} source(s) de marché, ${positioning.length} de positionnement, ${events.length} d'événements macro, lues au démarrage du serveur. `
        + 'Chaque source garde sa provenance ; aucune n\'est vérifiée de façon indépendante, aucune méthode de positionnement n\'est approuvée. HOLD, exécution interdite.');
      const V2_DATA_NOTES = {
        EVIDENCE_DIR_ABSENT: 'aucun dossier evidence/ : les journaux de capture se déposent dans ~/.local/share/xau-v2/evidence/<journal>/archive.json',
        POSITIONING_DIR_ABSENT: 'aucun dossier positioning/ : y déposer les fichiers CFTC (texte désagrégé) et les déclarer avec scripts/cot_declare.mjs',
      };
      if (notes.length) {
        setText(el.v2DataHint, `${el.v2DataHint.textContent} À savoir : ${notes.map((n) => V2_DATA_NOTES[n] || (/^POSITIONING_DIR_UNREADABLE/.test(n)
          ? `dossier positioning/ illisible (${n.split(':')[1] || '?'})`
          : /^EVENTS_SOURCE_UNKNOWN:/.test(n) ? `source d'événements inconnue (${n.slice(22)}) : celle du document est utilisée` : n)).join(' ; ')}.`);
      }
      el.v2DataMarket.hidden = market.length < 2;
      el.v2DataPositioning.hidden = positioning.length < 2;
      el.v2DataEvents.hidden = events.length < 2;
      for (const lab of el.v2DataWrap.querySelectorAll('.v2__data-label')) {
        lab.hidden = (lab.htmlFor === 'v2-data-market' ? market.length : lab.htmlFor === 'v2-data-events' ? events.length : positioning.length) < 2;
      }
      el.v2DataMarket.addEventListener('change', () => {
        v2Market = el.v2DataMarket.value || null;
        v2ReplayCutoff = null;
        renderDataCards();
        writeChoiceToHash();
        loadArchiveCutoffs(v2Market);
        refreshV2();
      });
      const preset = realPreset(v2Catalog);
      el.v2DataReal.hidden = !(preset.market || preset.positioning || preset.events);
      el.v2DataReal.title = `Marché : ${preset.market || 'aucune source réelle'} · positionnement : ${preset.positioning || 'aucun fichier lu'}`
        + ` · événements : ${preset.events || 'aucun'} — rien n'est approuvé, HOLD`;
      el.v2DataReal.addEventListener('click', () => {
        if (v2Scenario !== null) return;
        if (preset.market) { v2Market = preset.market; el.v2DataMarket.value = preset.market; }
        if (preset.positioning) { v2Positioning = preset.positioning; el.v2DataPositioning.value = preset.positioning; }
        if (preset.events) { v2Events = preset.events; el.v2DataEvents.value = preset.events; }
        v2ReplayCutoff = null;
        renderDataCards();
        writeChoiceToHash();
        loadArchiveCutoffs(v2Market);
        refreshV2();
      });
      el.v2DataEvents.addEventListener('change', () => {
        v2Events = el.v2DataEvents.value || null;
        renderDataCards();
        writeChoiceToHash();
        refreshV2();
      });
      el.v2DataPositioning.addEventListener('change', () => {
        v2Positioning = el.v2DataPositioning.value || null;
        renderDataCards();
        writeChoiceToHash();
        loadArchiveCutoffs(v2Market);
        refreshV2();
      });
      if (requestedChoice && requestedChoice.kind === 'donnees'
          && market.some((x) => x.id === requestedChoice.market) && positioning.some((x) => x.id === requestedChoice.positioning)) {
        v2Market = requestedChoice.market;
        v2Positioning = requestedChoice.positioning;
        el.v2DataMarket.value = v2Market;
        el.v2DataPositioning.value = v2Positioning;
        if (requestedChoice.events && events.some((x) => x.id === requestedChoice.events)) {
          v2Events = requestedChoice.events;
          el.v2DataEvents.value = v2Events;
        }
      }
      el.v2DataMarket.disabled = v2Scenario !== null;
      el.v2DataPositioning.disabled = v2Scenario !== null;
      el.v2DataEvents.disabled = v2Scenario !== null;
      el.v2DataReal.disabled = v2Scenario !== null;
      renderDataCards();
      return true;
    } catch {
      return false;
    }
  }

  /* Cutoff de rejeu choisi pour l'archive du serveur ; null = celui du serveur. */
  let v2ReplayCutoff = null;
  const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  /** 4.7.0 : les publications officielles derrière les résumés macro, connues ou non au cutoff. */
  function renderOfficialEvents(ev) {
    const ok = ev && typeof ev === 'object' && isList(ev.known) && isList(ev.notYetPublished);
    el.v2OfficialEvents.hidden = !ok;
    if (!ok) {
      el.v2OfficialEventsList.replaceChildren();
      return;
    }
    setText(el.v2OfficialEventsNote, `${ev.label} — Event Impact ${ev.impactStatus} · Gold Transmission ${ev.transmissionStatus}`
      + `${isList(ev.reasonCodes) && ev.reasonCodes.length ? ` · ${ev.reasonCodes.map(label).join(' · ')}` : ''}. `
      + 'Résumés recalculés au cutoff de la chaîne (EIA-0 v2) ; aucune interprétation : consensus inconnu, méthodes non approuvées.');
    const line = (e, state) => {
      const li = node('li', '', undefined, { 'data-state': state });
      li.appendChild(node('span', 'v2__avail-field', `${isText(e.family) ? e.family : '?'} ${isText(e.period) ? e.period : ''}`.trim()));
      li.appendChild(document.createTextNode(` · publiée ${instant(e.publishedAt)} · ${state === 'known' ? 'connue au cutoff' : 'PAS ENCORE PUBLIÉE au cutoff : exclue'}`));
      return li;
    };
    const rejected = isList(ev.rejected) ? ev.rejected.filter((r) => r && isText(r.name)).map((r) => {
      const li = node('li', '', undefined, { 'data-state': 'rejected' });
      li.appendChild(node('span', 'v2__avail-field', r.name));
      li.appendChild(document.createTextNode(` · rejetée : ${isText(r.reason) ? label(r.reason) : '?'}`));
      return li;
    }) : [];
    el.v2OfficialEventsList.replaceChildren(...ev.known.map((e) => line(e, 'known')), ...ev.notYetPublished.map((e) => line(e, 'pending')), ...rejected);
  }

  /** Entier lisible (espaces fines entre milliers), indépendant de la locale du navigateur. */
  const groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');

  /**
   * 4.6.0 : les preuves de positionnement brutes, groupées par rapport. Des faits (valeur, unité, période,
   * instants, source), jamais une lecture : aucun net, ratio, rang ni direction n'est calculé.
   */
  function renderPositioningEvidence(pos) {
    const rows = pos && isList(pos.evidence) ? pos.evidence : [];
    el.v2PositioningEvidence.hidden = rows.length === 0;
    if (!rows.length) {
      el.v2PositioningEvidenceGroups.replaceChildren();
      return;
    }
    const groups = new Map();
    for (const r of rows) {
      if (!r || !isText(r.metricCode) || !isNum(r.value) || !isText(r.periodEnd)) continue;
      const key = [r.sourceAuthority, r.datasetCode, r.instrumentCode, r.periodEnd, r.publishedAt, r.observedAt].join('|');
      if (!groups.has(key)) groups.set(key, { head: r, items: [] });
      groups.get(key).items.push(r);
    }
    setText(el.v2PositioningEvidenceNote, `${rows.length}${pos.evidenceTruncated === true ? ' premières' : ''} valeur(s) gardée(s) par P-0, `
      + 'telles que lues. Aucune lecture n\'est faite : méthode de positionnement non approuvée, signal UNAVAILABLE, HOLD.');
    el.v2PositioningEvidenceGroups.replaceChildren(...[...groups.values()].map(({ head, items }) => {
      const wrap = node('div', 'v2__pos-group');
      const after = items.some((i) => i.afterCutoff === true);
      wrap.appendChild(node('p', 'v2__pos-group-head', `${String(head.sourceAuthority).toUpperCase()} · ${head.datasetCode} · ${head.instrumentCode}`
        + ` · rapport du ${head.periodEnd} · publié ${instant(head.publishedAt)} · reçu ${instant(head.observedAt)}`
        + `${after ? ' · APRÈS LE CUTOFF : écartée' : ''}`, { 'data-after-cutoff': String(after) }));
      const list = node('ul', 'v2__pos-list');
      for (const i of items) {
        const li = node('li', '');
        li.appendChild(node('span', 'v2__pos-metric', label(i.metricCode).toUpperCase()));
        li.appendChild(node('span', 'v2__pos-value num', `${groupDigits(i.value)} ${i.unit === 'CONTRACTS' ? 'contrats' : label(i.unit)}`));
        list.appendChild(li);
      }
      wrap.appendChild(list);
      return wrap;
    }));
  }

  /** Ce que l'archive contient par champ, quel que soit le cutoff : comptes et bornes, aucun jugement. */
  function renderArchiveAvailability(fields) {
    if (!isList(fields) || fields.length === 0) return;
    const day = (at) => (isText(at) && UTC_INSTANT.test(at) ? at.replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, 'Z') : null);
    const items = [];
    for (const f of fields) {
      if (!f || !/^[A-Za-z0-9]{1,16}$/.test(String(f.field)) || !isNum(f.records) || f.records < 0) continue;
      const li = node('li', '', undefined, { 'data-records': String(f.records) });
      li.appendChild(node('span', 'v2__avail-field', String(f.field).toUpperCase()));
      const sources = isList(f.sources) ? f.sources.filter((x) => typeof x === 'string' && /^[a-z0-9_]{1,32}$/.test(x)) : [];
      li.appendChild(document.createTextNode(f.records === 0
        ? (f.captureSeries === false ? ' · aucun enregistrement — aucune série de capture définie (source à décider)' : ' · aucun enregistrement')
        : ` · ${f.records} enr. · ${sources.join(', ') || 'source ?'} · observé ${day(f.firstObservedAt) ?? '?'} → ${day(f.lastObservedAt) ?? '?'}`
          + ` · reçu ${day(f.firstIngestedAt) ?? '?'} → ${day(f.lastIngestedAt) ?? '?'}`));
      items.push(li);
    }
    el.v2ArchiveAvailList.replaceChildren(...items);
    el.v2ArchiveAvail.hidden = items.length === 0;
  }

  let replayListening = false;
  let requestedApplied = false;
  let cutoffsRequest = 0;
  /**
   * Instants de réception de la source de marché choisie (archive, captures) ; sans archive, le sélecteur
   * reste caché. Sans identifiant : la source du serveur (comportement d'origine).
   */
  async function loadArchiveCutoffs(marketId = null) {
    if (!CONFIG.V2_ARCHIVE_CUTOFFS_URL) return;
    const request = ++cutoffsRequest;
    el.v2ReplayCutoffWrap.hidden = true;
    el.v2CapturesFailed.hidden = true;
    el.v2ArchiveAvail.hidden = true;
    el.v2ReplayCutoff.hidden = false;
    if (v2Catalog !== null) {
      const source = v2Catalog.market.find((x) => x.id === (marketId ?? v2Catalog.defaults.market));
      if (!source || source.replayable !== true) return;
    }
    try {
      // Le positionnement choisi (s'il n'est pas celui du serveur) : son instant de connaissance est proposé aussi.
      const params = [];
      if (marketId !== null) params.push(`market=${encodeURIComponent(marketId)}`);
      if (v2Catalog !== null && v2Positioning !== null && v2Positioning !== v2Catalog.defaults.positioning) {
        params.push(`positioning=${encodeURIComponent(v2Positioning)}`);
      }
      const url = `${CONFIG.V2_ARCHIVE_CUTOFFS_URL}${params.length ? `?${params.join('&')}` : ''}`;
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (request !== cutoffsRequest) return;
      if (!response.ok) return;
      const list = await response.json();
      if (!list || list.schemaVersion !== 'xau.terminal-archive-cutoffs.v1' || !isList(list.cutoffs)) return;
      const instants = list.cutoffs.filter((at) => typeof at === 'string' && UTC_INSTANT.test(at));
      // --captures non fusionnées : le marché est absent ; dire pourquoi plutôt qu'un simple rejet.
      const cap = list.captures;
      if (cap && typeof cap === 'object' && cap.merged === false) {
        const problems = isList(cap.problems) ? cap.problems.filter((x) => typeof x === 'string').slice(0, 6) : [];
        setText(el.v2CapturesFailed, `CAPTURES NON FUSIONNÉES (${isNum(cap.sources) ? cap.sources : '?'} journal(aux)) : `
          + `${problems.join(' · ') || 'raison inconnue'}. Aucun marché n'est retenu ; HOLD, exécution interdite.`);
        el.v2CapturesFailed.hidden = false;
        el.v2ReplayCutoff.hidden = true;
        setText(el.v2ReplayCutoffHint, '');
        el.v2ReplayCutoffWrap.hidden = false;
        return;
      }
      if (instants.length === 0) return;
      const defaultLabel = isText(list.defaultCutoff) ? `Cutoff du serveur (${list.defaultCutoff})` : 'Cutoff du serveur';
      const options = [node('option', '', defaultLabel, { value: '' })];
      // Ce qui est arrivé à chaque instant (champs), quand le serveur le dit pour ce même instant.
      const received = new Map((isList(list.receptions) ? list.receptions : [])
        .filter((r) => r && typeof r.at === 'string' && isList(r.fields))
        .map((r) => [r.at, r.fields.filter((f) => typeof f === 'string' && /^[A-Za-z0-9]{1,16}$/.test(f))]));
      // Instants où une autre entrée devient connue (rapport CFTC publié et reçu) : pas une réception du marché.
      const known = new Map((isList(list.knownAt) ? list.knownAt : [])
        .filter((k) => k && typeof k.at === 'string' && UTC_INSTANT.test(k.at) && k.input === 'POSITIONING')
        .map((k) => [k.at, isText(k.reportDate) && /^\d{4}-\d{2}-\d{2}$/.test(k.reportDate) ? k.reportDate : null]));
      const receptionsOnly = instants.filter((at) => !known.has(at) || received.has(at));
      instants.forEach((at) => {
        const fields = received.get(at);
        const i = receptionsOnly.indexOf(at);
        const parts = [];
        if (i >= 0) parts.push(`réception ${i + 1}/${receptionsOnly.length}${fields && fields.length ? ` · ${fields.map((f) => f.toUpperCase()).join(', ')}` : ''}`);
        if (known.has(at)) parts.push(`POSITIONNEMENT connu${known.get(at) ? ` (rapport CFTC du ${known.get(at)})` : ''}`);
        options.push(node('option', '', `${at.replace('T', ' ')} — ${parts.join(' · ')}`, { value: at }));
      });
      el.v2ReplayCutoff.replaceChildren(...options);
      setText(el.v2ReplayCutoffHint, `${receptionsOnly.length} instant${receptionsOnly.length > 1 ? 's' : ''} de réception de l'archive${list.truncated === true ? ' (les plus récents)' : ''}`
        + `${known.size ? ` et ${known.size} instant où le positionnement choisi devient connu (publié et reçu)` : ''} : `
        + 'chaque rejeu ne connaît que les données reçues à cet instant. Les autres entrées restent celles du document : '
        + 'un cutoff différent du leur est signalé comme incohérence. HOLD, exécution interdite.');
      // Le cutoff choisi reste appliqué s'il est encore proposé ; sinon retour au cutoff du serveur.
      if (v2ReplayCutoff !== null) {
        if (instants.includes(v2ReplayCutoff)) el.v2ReplayCutoff.value = v2ReplayCutoff;
        else { v2ReplayCutoff = null; writeChoiceToHash(); refreshV2(); }
      }
      el.v2ReplayCutoffWrap.hidden = false;
      renderArchiveAvailability(list.fields);
      el.v2ReplayCutoff.disabled = v2Scenario !== null;
      if (!replayListening) {
        replayListening = true;
        el.v2ReplayCutoff.addEventListener('change', () => {
          v2ReplayCutoff = el.v2ReplayCutoff.value || null;
          writeChoiceToHash();
          refreshV2();
        });
      }
      // L'instant de l'ancre n'est appliqué qu'une fois, pour la source qu'elle nomme.
      const wanted = requestedChoice && (requestedChoice.kind === 'rejeu' || requestedChoice.kind === 'donnees') && !requestedApplied
        ? requestedChoice.value : null;
      if (wanted && instants.includes(wanted)) {
        requestedApplied = true;
        el.v2ReplayCutoff.value = wanted;
        v2ReplayCutoff = wanted;
        if (v2Scenario === null) refreshV2();
      }
    } catch { /* sans liste, le cutoff du serveur reste appliqué */ }
  }

  async function refreshV2() {
    if (!CONFIG.V2_VIEW_URL) {
      renderV2Unavailable('unavailable', 'INDISPONIBLE',
        'Aucun runtime V2 déployé. En local : npm run terminal:local');
      return;
    }
    const request = ++v2Request;
    const query = [];
    if (v2Scenario) query.push(`scenario=${encodeURIComponent(v2Scenario)}`);
    else {
      // Seules les sources différentes de celles du serveur sont demandées : l'adresse par défaut reste la même.
      if (v2Catalog !== null && v2Market !== null && v2Market !== v2Catalog.defaults.market) query.push(`market=${encodeURIComponent(v2Market)}`);
      if (v2Catalog !== null && v2Positioning !== null && v2Positioning !== v2Catalog.defaults.positioning) {
        query.push(`positioning=${encodeURIComponent(v2Positioning)}`);
      }
      if (v2Catalog !== null && v2Events !== null && v2Events !== v2Catalog.defaults.events) query.push(`events=${encodeURIComponent(v2Events)}`);
      if (v2ReplayCutoff) query.push(`cutoff=${encodeURIComponent(v2ReplayCutoff)}`);
    }
    const url = query.length ? `${CONFIG.V2_VIEW_URL}?${query.join('&')}` : CONFIG.V2_VIEW_URL;
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
        id: 'demo-1', title: '[DÉMO] Événement monétaire fictif — aucun communiqué officiel',
        news_score: null, classification: 'noise', gold_direction_impact: null,
        region: 'US', category: 'monetary_policy', ts: new Date(Date.now() - 6e5).toISOString(),
      },
      {
        id: 'demo-2', title: '[DÉMO] Indicateur d’inflation fictif — aucune donnée officielle',
        news_score: null, classification: 'noise', gold_direction_impact: null,
        region: 'US', category: 'inflation', ts: new Date(Date.now() - 24e5).toISOString(),
      },
      {
        id: 'demo-3', title: '[DÉMO] Événement géopolitique fictif — aucune actualité vérifiée',
        news_score: null, classification: 'noise', gold_direction_impact: null,
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
    // Le catalogue d'abord : il dit quelle source est rejouable ; sans catalogue, comportement d'origine.
    loadCatalog().then((ok) => {
      loadArchiveCutoffs(ok && v2Market !== null ? v2Market : null);
      if (ok && dataChosen() && v2Scenario === null) refreshV2();
    });
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
