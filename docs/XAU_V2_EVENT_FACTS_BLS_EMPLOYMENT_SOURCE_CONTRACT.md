# XAU V2 — US BLS Employment Situation / NFP Source Contract

Status: `PURE ADAPTER — NOT ACTIVATED`  
Baseline verified against: `6adffe22a0c49f9f0959ba5bf2c60f5112f2125e`

This contract introduces a pure, fail-closed adapter for one official US
Bureau of Labor Statistics Employment Situation publication. It adds no live
fetch, HTML parser, database write, identity lookup, Worker route, cron,
deployment, consensus provider, or CES V2 runtime activation.

## 1. Frozen source and identity

| Field | Frozen value |
|---|---|
| Authority | US Bureau of Labor Statistics |
| Authority code | `US_BLS` |
| Provider | `bls` |
| Source code | `bls_employment_situation_release` |
| Source domain | `bls.gov` |
| Release family | `US_NFP` |
| Release stage | `SINGLE` |
| Identity strategy | `OFFICIAL_RELEASE_ID` |
| Strategy version | `bls_employment_situation_v1` |
| Adapter version | `bls-employment-event-facts-adapter-v1` |

The official `USDL-YY-NNNN` identifier establishes release identity within the
US BLS authority/family/stage scope. Title, archive path, reference month,
metric values, revisions, series identifiers, and publication time never
substitute for a missing official release identifier and never alter identity.

For `USDL-26-1435`, the identity proposal is:

```json
{
  "authorityNamespace": "xau_v2:official_release:us_bls:v1",
  "identityType": "official_release_id:bls_employment_situation_v1",
  "identityValue": "{\"authority\":\"us_bls\",\"release_family\":\"US_NFP\",\"release_id\":\"USDL-26-1435\",\"release_stage\":\"SINGLE\",\"strategy\":\"OFFICIAL_RELEASE_ID\",\"strategy_version\":\"bls_employment_situation_v1\"}"
}
```

## 2. Official evidence boundary

One retained archived Employment Situation release is the evidence bundle. Its
reviewed projection preserves:

- the exact `USDL` release identifier, heading, embargo/publication statement,
  and BLS archive path;
- an explicit `MONTH` reference period;
- total nonfarm payroll change and the two prior-month revisions printed by the
  same release;
- the unemployment rate;
- the month-over-month change in average hourly earnings for all employees on
  private nonfarm payrolls;
- the exact BLS series identifiers bound by this adapter.

Official entry points:

- `https://www.bls.gov/news.release/empsit.htm`
- `https://www.bls.gov/bls/news-release/empsit.htm`
- `https://www.bls.gov/schedule/news_release/empsit.htm`
- `https://www.bls.gov/errata/`

The fixtures retain reviewed projections from the July and August 2026 archive
releases. They are deterministic test evidence, not a live collector.

## 3. Exact metric mapping

| CES metric | BLS series | Official release evidence | CES unit |
|---|---|---|---|
| `AVG_HOURLY_EARNINGS_MOM` | `CES0500000003` | Summary table B, all employees, total private, over-the-month percent change | `PERCENT_CHANGE_MOM` |
| `NFP_PAYROLL_CHANGE` | `CES0000000001` | Total nonfarm over-the-month change | `THOUSANDS_OF_PERSONS` |
| `UNEMPLOYMENT_RATE` | `LNS14000000` | Summary table A, total unemployment rate | `LEVEL_PERCENT` |

Metrics are emitted in lexicographic `metric_code` order. All use the explicit
release reference month. Payroll values and revisions must be safe integers in
thousands. Rate cells must be finite and representable at one decimal place.
The adapter never rounds, interpolates, or converts a level into a change.

## 4. Release-local revisions

`NFP_PAYROLL_CHANGE.prior_periods` contains exactly the two immediately
preceding calendar months. Every entry retains both values printed by the same
release:

- `prior_value`: the value publicly reported immediately before this release;
- `revised_value`: the value restated by this release.

The entries are canonicalized oldest to newest. Missing, duplicate,
non-consecutive, same-month, or future periods fail closed. A revision amount
is derived later as `revised_value - prior_value`; it is not persisted in CES.
The unemployment and earnings metrics emit empty `prior_periods` because this
projection does not contain the paired before/after evidence required to claim
a release-local revision for those metrics.

## 5. Consensus boundary

No consensus source or license is authorized. The input contract contains no
forecast field, and every emitted metric uses:

```json
{ "state": "UNKNOWN", "value": null }
```

`UNKNOWN` is never converted to zero and no surprise is computed. Adding a
consensus source requires a separate provider, licensing, timestamp, revision,
and methodology decision.

## 6. Conflict and correction behavior

The heading must exactly name the projected month and year, and the retained
artifact path must equal the official release archive path. Contradiction is
`CONFLICT`; the adapter never repairs a period from the publication date.

A correction under the same official `USDL` identifier retains release
identity and may change facts. A different `USDL` identifier is a different
release identity. Handling a BLS correction that changes identifiers requires
separate review; this adapter does not infer equivalence.

## 7. Result states

| State | Meaning |
|---|---|
| `RESOLVED` | Exact source, release identity, artifact binding, series, values, and revisions pass |
| `UNAVAILABLE` | Required official evidence or either prior payroll revision is absent |
| `MALFORMED` | Shape, identifier grammar, archive grammar, or numeric precision is invalid |
| `CONFLICT` | Header/artifact/reference period or prior-period sequence contradicts itself |
| `UNSUPPORTED` | Source tuple, family, stage, or series mapping is outside this contract |

No non-resolved state emits partial facts or a fallback identity.

## 8. Security and activation boundary

`backend/event_facts/bls_employment_situation_adapter.ts` is pure: no imports,
network, database, environment, clock, randomness, LLM, market price, score, or
legacy fallback. Exact-key validation rejects smuggled fields at every accepted
projection level.

This lot does **not** expand the current CPI-only persistence validator.
The pure EI/GT consumers may separately admit the exact `US_NFP` shape only to
produce their existing conservative insufficiency outputs with zero paths and
zero interpretations. Persistence, source artifacts, parsing, orchestration,
and runtime activation remain blocked pending separate review and the
applicable Human Gates. The adapter alone is not authorization
to fetch, store, deploy, enrich, score, alert, or trade.

## 9. Acceptance evidence

The deterministic test must prove:

1. both reviewed official fixtures resolve without input mutation;
2. identity and output are replay-deterministic;
3. all three series map to exact CES metrics and units;
4. both payroll revisions survive and canonicalize chronologically;
5. consensus remains structurally impossible to inject;
6. missing, malformed, conflicting, unsupported, and correction paths fail or
   resolve exactly as specified;
7. the adapter has no I/O, runtime, provider, model, or market dependency.
