/**
 * DATA-3 — continuity audit of a capture log, per series (report only).
 *
 * A declared coverage window is a claim. This audit lists, for every series
 * the log holds, where its observations leave holes, and never concludes the
 * opposite: an audit that finds no hole still does not attest continuous
 * coverage (`continuity: 'NOT_ATTESTED'`, always).
 *
 * What it measures, and on what basis:
 *  - observation gaps: the interval between two consecutive distinct
 *    observation times of one series. For a daily series, the missing UTC
 *    dates are counted and split into weekdays and Saturday/Sunday. Whether a
 *    missing date is a market closure, a public holiday or a missing
 *    observation is NOT_EVALUATED: no source calendar is approved
 *    (`calendarCompleteness: NOT_PROVEN`, DATA-4E/4G). No tolerance is
 *    approved either, so no gap is called acceptable or excessive;
 *  - unavailable / not-live intervals: where, inside the window, no record of
 *    the series was held fresh under the existing runtime freshness rule
 *    (`SYMBOL_RULES` staleMaxAgeS / liveMaxAgeS, as the replay applies it):
 *    held means ingested by then, fresh means its age is at most the
 *    threshold. Those are the replay's own rules, not new thresholds. A
 *    series without a rule (DXY) is NOT_EVALUATED;
 *  - duplicates (records of one observation time that are not a linked
 *    revision) and capture-order anomalies (a record appended before an
 *    earlier ingestion, an observation received after a later one).
 *
 * Interval bounds: `from` is excluded when the series was fresh up to it and
 * included at the window start; `to` is excluded when a record becomes fresh
 * there and included at the window end. A zero-length interval means the
 * series was unavailable at that single instant.
 *
 * With `cutoff`, only records ingested by the cutoff are read and the window
 * ends there at the latest: the report never uses what was not yet held.
 * Pure: no clock, file, network or provider; the replay is not changed.
 */

export const CAPTURE_CONTINUITY_REPORT_VERSION = 'capture-continuity-1.0.0';

const DAY_MS = 86_400_000;
const NO_CALENDAR = 'NO_APPROVED_SOURCE_CALENDAR';
const NO_TOLERANCE = 'NO_APPROVED_GAP_TOLERANCE';

const parse = (value) => {
  if (typeof value !== 'string') return null;
  // Explicit zone only: an implicit one would read differently per host.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
const iso = (ms) => new Date(ms).toISOString();
const seconds = (ms) => ms / 1000;
const utcDay = (ms) => Math.floor(ms / DAY_MS);

/** Closed intervals [a, b] → the parts of [from, to] none of them covers. */
export function uncoveredIntervals(intervals, from, to) {
  const merged = [];
  for (const [a, b] of [...intervals].filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const out = [];
  let pos = from;
  let covered = false; // whether `pos` itself is covered
  for (const [a, b] of merged) {
    if (b < pos) continue; // wholly before the window
    if (a > to) break;
    if (a > pos) out.push([pos, a]);
    pos = Math.max(pos, b);
    covered = true;
    if (pos >= to) return out;
  }
  if (pos < to || !covered) out.push([pos, to]);
  return out;
}

const interval = ([a, b]) => ({ from: iso(a), to: iso(b), durationSeconds: seconds(b - a) });

/**
 * @param archive  a market evidence archive (DATA-1 format)
 * @param options.rules   field → { liveMaxAgeS, staleMaxAgeS } | null (the replay's freshness rule)
 * @param options.cadence field → 'DAILY' | 'INTRADAY' (from the capture series' observation type)
 * @param options.cutoff  optional knowledge cutoff
 */
export function auditCaptureContinuity(archive, { rules = {}, cadence = {}, cutoff = null } = {}) {
  const base = {
    reportVersion: CAPTURE_CONTINUITY_REPORT_VERSION,
    archiveId: archive?.archiveId ?? null,
    // Never upgraded by this audit, whatever it finds: no calendar or tolerance is approved.
    continuity: 'NOT_ATTESTED',
    continuityBasis: [NO_CALENDAR, NO_TOLERANCE],
  };
  const notEvaluated = (reason) => ({ ...base, outcome: 'NOT_EVALUATED', reason, window: null, series: [], declaredFieldsWithoutSeries: [], findings: [] });
  if (!archive || !Array.isArray(archive.records)) return notEvaluated('ARCHIVE_UNREADABLE');
  const cutoffMs = cutoff === null ? null : parse(cutoff);
  if (cutoff !== null && cutoffMs === null) return notEvaluated('CUTOFF_UNREADABLE');

  const rows = [];
  for (const [index, r] of archive.records.entries()) {
    const observed = parse(r?.observedAt);
    const ingested = parse(r?.ingestedAt);
    if (observed === null || ingested === null || typeof r.field !== 'string') return notEvaluated('RECORD_TIME_UNREADABLE');
    rows.push({ index, r, observed, ingested });
  }

  const findings = [];
  // Append order: a log is appended in reception order.
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].ingested < rows[i - 1].ingested) {
      findings.push({ code: 'INGESTION_ORDER_VIOLATION', series: null, at: iso(rows[i].ingested), evidenceId: rows[i].r.evidenceId ?? null });
    }
  }
  const held = cutoffMs === null ? rows : rows.filter((x) => x.ingested <= cutoffMs);

  // Window: the declared coverage, else the span of receptions (no claim then).
  let window;
  const cov = archive.coverage;
  if (cov) {
    const from = parse(cov.from);
    const to = parse(cov.to);
    if (from === null || to === null || from > to) return notEvaluated('COVERAGE_UNREADABLE');
    window = { from, to, basis: 'DECLARED_COVERAGE', fields: Array.isArray(cov.fields) ? [...cov.fields] : [] };
  } else if (held.length) {
    window = { from: Math.min(...held.map((x) => x.ingested)), to: Math.max(...held.map((x) => x.ingested)), basis: 'RECEPTION_SPAN', fields: [] };
  } else {
    return notEvaluated('NO_RECORD');
  }
  if (cutoffMs !== null) {
    if (cutoffMs < window.from) return { ...notEvaluated('CUTOFF_BEFORE_WINDOW'), window: { from: iso(window.from), to: iso(window.to), basis: window.basis } };
    window.to = Math.min(window.to, cutoffMs);
  }

  const groups = new Map();
  for (const x of held) {
    const key = [x.r.field, x.r.source, x.r.sourceRecordId ?? ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }

  const series = [];
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key);
    const { field, source, sourceRecordId } = list[0].r;
    const rule = Object.hasOwn(rules, field) ? rules[field] : null;
    const kind = cadence[field] ?? 'UNKNOWN';

    // Duplicates: one observation time held more than once and not as a linked revision.
    const byTime = new Map();
    for (const x of list) {
      if (!byTime.has(x.observed)) byTime.set(x.observed, []);
      byTime.get(x.observed).push(x);
    }
    const duplicates = [];
    for (const [t, same] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
      if (same.length < 2) continue;
      const ids = new Set(same.map((x) => x.r.evidenceId));
      const linked = same.filter((x) => x.r.supersedes !== null && ids.has(x.r.supersedes)).length === same.length - 1;
      const sameValue = same.every((x) => Object.is(x.r.value, same[0].r.value));
      const type = linked ? 'LINKED_REVISION' : sameValue ? 'SAME_VALUE_RECORDED_TWICE' : 'UNLINKED_DIVERGENT_VALUES';
      duplicates.push({ observedAt: iso(t), evidenceIds: same.map((x) => x.r.evidenceId), type });
      if (!linked) findings.push({ code: 'DUPLICATE_OBSERVATION', series: key, at: iso(t), type });
    }

    // Received out of order: an observation older than one already held, arriving later.
    let maxObserved = Number.NEGATIVE_INFINITY;
    let maxObservedIngested = null;
    const lateObservations = [];
    for (const x of [...list].sort((a, b) => a.ingested - b.ingested || a.index - b.index)) {
      if (x.observed < maxObserved && x.ingested > maxObservedIngested && !byTime.get(x.observed).some((y) => y.ingested < x.ingested)) {
        lateObservations.push({ observedAt: iso(x.observed), ingestedAt: iso(x.ingested), afterObservedAt: iso(maxObserved) });
      }
      if (x.observed > maxObserved) { maxObserved = x.observed; maxObservedIngested = x.ingested; }
    }
    for (const l of lateObservations) findings.push({ code: 'OBSERVATION_RECEIVED_AFTER_A_LATER_ONE', series: key, at: l.ingestedAt, observedAt: l.observedAt });

    // Observation gaps between consecutive distinct observation times.
    const times = [...byTime.keys()].sort((a, b) => a - b);
    const observationGaps = [];
    for (let i = 1; i < times.length; i += 1) {
      const [a, b] = [times[i - 1], times[i]];
      const gap = { ...interval([a, b]), tolerance: 'NOT_EVALUATED', toleranceReason: NO_TOLERANCE };
      if (kind === 'DAILY') {
        let weekdays = 0;
        let weekend = 0;
        for (let d = utcDay(a) + 1; d < utcDay(b); d += 1) {
          const dow = new Date(d * DAY_MS).getUTCDay();
          if (dow === 0 || dow === 6) weekend += 1; else weekdays += 1;
        }
        if (weekdays + weekend === 0) continue; // consecutive dates
        Object.assign(gap, {
          missingDates: weekdays + weekend, missingWeekdays: weekdays, missingSaturdaysSundays: weekend,
          // A missing weekday may be a holiday or a missing value; a Saturday is not proved closed either.
          marketClosure: 'NOT_EVALUATED', nonBusinessDay: 'NOT_EVALUATED', calendarReason: NO_CALENDAR,
        });
      } else {
        Object.assign(gap, { marketClosure: 'NOT_EVALUATED', nonBusinessDay: 'NOT_EVALUATED', calendarReason: NO_CALENDAR });
      }
      observationGaps.push(gap);
    }

    // Freshness intervals: held from ingestion, fresh while age <= threshold.
    const freshness = (maxAgeS) => uncoveredIntervals(list.map((x) => [Math.max(x.ingested, x.observed), x.observed + maxAgeS * 1000]), window.from, window.to).map(interval);
    const evaluated = rule && Number.isFinite(rule.staleMaxAgeS) && Number.isFinite(rule.liveMaxAgeS);
    const unavailable = evaluated ? freshness(rule.staleMaxAgeS) : null;
    const notLive = evaluated ? freshness(rule.liveMaxAgeS) : null;
    if (unavailable) for (const u of unavailable) findings.push({ code: 'SERIES_UNAVAILABLE_IN_WINDOW', series: key, ...u });
    else findings.push({ code: 'FRESHNESS_RULE_UNAVAILABLE', series: key });

    series.push({
      series: key, field, source, sourceRecordId: sourceRecordId ?? null, cadence: kind,
      declared: window.fields.includes(field),
      records: list.length, observationTimes: times.length,
      firstObservedAt: iso(times[0]), lastObservedAt: iso(times.at(-1)),
      firstIngestedAt: iso(Math.min(...list.map((x) => x.ingested))), lastIngestedAt: iso(Math.max(...list.map((x) => x.ingested))),
      observationGaps,
      freshnessBasis: evaluated ? 'RUNTIME_FRESHNESS_RULE' : 'NOT_EVALUATED',
      unavailableIntervals: unavailable, notLiveIntervals: notLive,
      duplicates, lateObservations,
    });
  }

  // A declared field no series holds: unavailable over the whole window.
  const declaredFieldsWithoutSeries = window.fields.filter((f) => !series.some((s) => s.field === f)).sort();
  for (const f of declaredFieldsWithoutSeries) findings.push({ code: 'DECLARED_FIELD_WITHOUT_OBSERVATION', series: null, field: f, ...interval([window.from, window.to]) });

  const gapsDetected = findings.length > 0 || series.some((s) => s.observationGaps.length > 0);
  return {
    ...base,
    outcome: gapsDetected ? 'GAPS_DETECTED' : 'NO_GAP_DETECTED',
    reason: null,
    window: { from: iso(window.from), to: iso(window.to), basis: window.basis, fields: window.fields, cutoff: cutoffMs === null ? null : iso(cutoffMs) },
    series,
    declaredFieldsWithoutSeries,
    findings,
  };
}

/**
 * Fields declared covered that the audit found unavailable at some instant of
 * the declared window, with the intervals. Any of them means the declared
 * window is not continuous for that field, under the replay's own rule.
 */
export function declaredFieldHoles(report) {
  if (report.outcome === 'NOT_EVALUATED' || report.window?.basis !== 'DECLARED_COVERAGE') return [];
  return report.window.fields.flatMap((field) => fieldHoles(report, field) ?? [{ field, from: null, to: null, basis: 'FRESHNESS_RULE_UNAVAILABLE' }]);
}

/**
 * Where, in the window, no series of `field` was held fresh: a declared field
 * no series holds is a hole over the whole window. null when a series of the
 * field has no freshness rule (not evaluated). Optimistic across sources: the
 * field counts as held if any of its series is fresh.
 */
function fieldHoles(report, field) {
  const own = report.series.filter((s) => s.field === field);
  if (own.length === 0) {
    return report.window.basis === 'DECLARED_COVERAGE' && report.window.fields.includes(field)
      ? [{ field, from: report.window.from, to: report.window.to, durationSeconds: seconds(Date.parse(report.window.to) - Date.parse(report.window.from)), basis: 'NO_SERIES' }]
      : [];
  }
  if (own.some((s) => s.unavailableIntervals === null)) return null;
  const fresh = own.flatMap((s) => complement(s.unavailableIntervals, report.window));
  return uncoveredIntervals(fresh, Date.parse(report.window.from), Date.parse(report.window.to))
    .map(([a, b]) => ({ field, ...interval([a, b]), basis: 'RUNTIME_FRESHNESS_RULE' }));
}

const FIELD_ORDER = ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti'];

/**
 * The audit as an operator reads it, per field and per series: what was
 * observed, the gaps between observations, the holes (no value held fresh) and
 * a status. The statuses never say "continuous": NO_HOLE_DETECTED only means
 * this audit found none, and `continuity` stays NOT_ATTESTED. Shared by the
 * terminal catalog, terminal:check-data and the page, so they cannot disagree.
 */
export function summarizeContinuity(report) {
  const base = { reportVersion: report.reportVersion, continuity: 'NOT_ATTESTED', continuityBasis: [...report.continuityBasis] };
  if (report.outcome === 'NOT_EVALUATED') return { ...base, outcome: 'NOT_EVALUATED', reason: report.reason, window: null, fields: [], series: [], findings: {} };
  const names = new Set([...report.window.fields, ...report.series.map((s) => s.field)]);
  const fields = [...names].sort((a, b) => (FIELD_ORDER.indexOf(a) + 1 || 99) - (FIELD_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b)).map((field) => {
    const own = report.series.filter((s) => s.field === field);
    const holes = fieldHoles(report, field);
    const gaps = own.flatMap((s) => s.observationGaps);
    const status = own.length === 0 ? 'NO_SERIES' : holes === null ? 'NOT_EVALUATED' : holes.length ? 'HOLES_DETECTED' : 'NO_HOLE_DETECTED';
    return {
      field, declared: report.window.fields.includes(field), series: own.map((s) => s.series),
      observationTimes: own.reduce((n, s) => n + s.observationTimes, 0),
      observed: own.length ? { first: own.map((s) => s.firstObservedAt).sort()[0], last: own.map((s) => s.lastObservedAt).sort().at(-1) } : null,
      observationGaps: gaps.length,
      largestGapSeconds: gaps.length ? Math.max(...gaps.map((g) => g.durationSeconds)) : null,
      missingWeekdays: gaps.reduce((n, g) => n + (g.missingWeekdays ?? 0), 0),
      missingSaturdaysSundays: gaps.reduce((n, g) => n + (g.missingSaturdaysSundays ?? 0), 0),
      holes: holes === null ? null : holes.map(({ from, to, durationSeconds, basis }) => ({ from, to, durationSeconds, basis })),
      status,
    };
  });
  const series = report.series.map((s) => ({
    series: s.series, field: s.field, cadence: s.cadence, observationTimes: s.observationTimes,
    observed: { first: s.firstObservedAt, last: s.lastObservedAt },
    observationGaps: s.observationGaps.map(({ from, to, durationSeconds, missingWeekdays, missingSaturdaysSundays }) => ({
      from, to, durationSeconds, missingWeekdays: missingWeekdays ?? null, missingSaturdaysSundays: missingSaturdaysSundays ?? null })),
    holes: s.unavailableIntervals, freshnessBasis: s.freshnessBasis,
    duplicates: s.duplicates.filter((d) => d.type !== 'LINKED_REVISION').length, lateObservations: s.lateObservations.length,
    status: s.unavailableIntervals === null ? 'NOT_EVALUATED' : s.unavailableIntervals.length ? 'HOLES_DETECTED' : 'NO_HOLE_DETECTED',
  }));
  const findings = {};
  for (const f of report.findings) findings[f.code] = (findings[f.code] ?? 0) + 1;
  return { ...base, outcome: report.outcome, reason: null,
    window: { from: report.window.from, to: report.window.to, basis: report.window.basis }, fields, series, findings };
}

/** The replay's freshness rule and the capture cadence of each field (backend modules passed in, so this file stays pure). */
export function continuityOptions(ev, validate, cap) {
  const rules = {};
  for (const [field, spec] of Object.entries(ev.MARKET_EVIDENCE_FIELD_SPEC)) {
    rules[field] = spec.freshnessSymbol === null ? null : validate.SYMBOL_RULES[spec.freshnessSymbol];
  }
  const cadence = Object.fromEntries(cap.CAPTURE_SERIES.map((s) => [s.field, s.observationType === 'DAILY_VALUE' ? 'DAILY' : 'INTRADAY']));
  return { rules, cadence };
}

/** Closed approximation of a series' fresh intervals from its unavailable ones (bounds shared). */
function complement(unavailable, window) {
  const out = [];
  let pos = Date.parse(window.from);
  let open = false;
  for (const u of unavailable) {
    const a = Date.parse(u.from);
    if (a > pos || (a === pos && open)) out.push([pos, a]);
    pos = Date.parse(u.to);
    open = true;
  }
  const end = Date.parse(window.to);
  if (unavailable.length === 0) out.push([pos, end]);
  else if (pos < end) out.push([pos, end]);
  return out;
}
