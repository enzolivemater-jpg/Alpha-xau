# XAU V2 — US BLS Employment Situation / NFP Source Contract

Status: `RAW HTML EVIDENCE AUDIT + PURE ADAPTER — CI PROOF ONLY — NOT ACTIVATED`
Baseline verified against: `1ce4030f20e754973c666fb25b36538bea7d9e69`

This contract retains two exact official US Bureau of Labor Statistics archive
HTML artifacts in deterministic gzip envelopes, audits their
average-hourly-earnings evidence hierarchy, and feeds only the reviewed
projection to a pure fail-closed adapter. It adds no live fetch, runtime parser,
database write, identity lookup, Worker route, cron, deployment, consensus
provider, or CES V2 runtime activation.

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

The fixtures retain reviewed projections and the exact raw HTML from the July
and August 2026 archive releases:

| Release | Raw bytes | SHA-256 | AHE MoM evidence |
|---|---:|---|---|
| July / `USDL-26-1291` | 1,066,217 | `4602e50c53ccfc789d52ef73191171d9918141516b7734524e70f2b8326024a5` | `UNAVAILABLE`: narrative says `+2 cents` but prints no MoM percent |
| August / `USDL-26-1435` | 1,064,564 | `6d83eeecf867f1e8c9a2a5449a4b064896062f4529ad36c4ff2a37e6968b7481` | `KNOWN`: narrative explicitly prints `0.3 percent` |

The audit authenticates each gzip envelope before bounded decompression, then
authenticates the decoded HTML byte count and SHA-256 before DOM parsing. These
files are deterministic CI evidence, not a live collector. July's structured
projection therefore sets `averageHourlyEarningsMom` to `null`, and the adapter
returns `UNAVAILABLE` without emitting partial facts. Release identity remains
independently resolvable from the official `USDL` identifier.

## 3. Exact metric mapping

| CES metric | BLS series | Official release evidence | CES unit |
|---|---|---|---|
| `AVG_HOURLY_EARNINGS_MOM` | `CES0500000003` | Explicit AHE MoM percent in the release narrative; absent evidence is `null` | `PERCENT_CHANGE_MOM` |
| `NFP_PAYROLL_CHANGE` | `CES0000000001` | Total nonfarm over-the-month change | `THOUSANDS_OF_PERSONS` |
| `UNEMPLOYMENT_RATE` | `LNS14000000` | Summary table A, total unemployment rate | `LEVEL_PERCENT` |

Metrics are emitted in lexicographic `metric_code` order. All use the explicit
release reference month. Payroll values and revisions must be safe integers in
thousands. Rate cells must be finite and representable at one decimal place.
The adapter never rounds, interpolates, converts a level or cents delta into a
percentage, or borrows a percentage from a neighboring table hierarchy.

In both retained releases, Summary table B row
`ces_table10.r.4.1.4.1` is labelled `Over-the-month percent change`, but its
`headers` attribute explicitly nests it under
`ces_table10.r.4.1.4`, `Index of aggregate weekly hours (2007=100)`. It is not
an AHE percentage row and is forbidden as AHE evidence. In July its last value
is `0.0`; treating that value as AHE would fabricate a fact. In August the
accepted `0.3` comes only from the explicit AHE sentence in the narrative, not
from that adjacent table row.

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

1. both retained gzip envelopes and decoded archive HTML files match exact byte
   counts and SHA-256 hashes;
2. DOM table headers prove the adjacent percentage row belongs to aggregate
   weekly hours, not average hourly earnings;
3. July AHE MoM is `UNAVAILABLE`, while August `0.3` is admitted only from the
   explicit narrative percentage;
4. August resolves without input mutation and July emits no partial facts;
5. identity and output are replay-deterministic;
6. all three August series map to exact CES metrics and units;
7. both payroll revisions survive and canonicalize chronologically;
8. consensus remains structurally impossible to inject;
9. missing, malformed, conflicting, unsupported, altered-artifact, and
   correction paths fail or resolve exactly as specified;
10. neither the audit nor adapter has network, database, runtime, provider,
    model, or market dependency.
