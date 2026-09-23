# XAU V2 — Event Facts V2 / Canonical Event State V2 Contract

Status: `CONTRACT_DRAFT — EF-0, NOT ACTIVATED`
Milestone: EF-0 (architecture/contract only)
Baseline verified against: `57458f0a83ac84224294b589b76df056ca076569`

This is a **contract/design document only**. It defines the shape and
semantics that a future, separately reviewed milestone must implement. It
does not add a migration, a table, a runtime producer, a source adapter, a
Worker route, or a Supabase call, and it does not change any currently
deployed behavior. Canonical Event State (CES) schema version 1 is
unaffected and remains the only schema version actually produced or
consumed anywhere in the live system after this document merges.

---

## 1. Purpose

Event Impact V1 and Gold Transmission V1 are both intentionally
fail-closed today because the one canonical factual record they read —
`event_versions.canonical_event_state` — carries no typed quantitative
facts. Before any positive causal or directional logic can be built on
top of either engine, the system needs a **reviewed, frozen shape** for
what a typed economic fact actually looks like: what "unknown" means,
what "consensus" is allowed to mean, how a revision differs from a
correction, what unit a number is in, and what period it refers to.

EF-0 exists to answer those questions once, precisely, before any parser,
adapter, or persistence code is written against them — the same
discipline already applied to Event Impact (EI-1..EI-6) and Gold
Transmission (GT-0..GT-6): schema and contract before behavior, contract
before implementation.

## 2. Existing V1 state (verified against source)

Verified directly against the repository at the baseline above, not
assumed:

- `public.event_versions.canonical_event_state` is the **only** canonical
  factual event truth in the system
  (`database/migrations/0012_event_cluster_version_foundation.sql:356`,
  `canonical_event_state_schema_version SMALLINT NOT NULL CHECK
  (canonical_event_state_schema_version > 0)`).
- CES schema version 1's shape is exactly three fields — `event_type`,
  `subject`, `detail` — and nothing else
  (`backend/event_engine/deterministic_processor.ts:382-386`,
  `CanonicalEventState`).
- `EventType` (v1) is a frozen six-value union: `MONETARY_POLICY_
  COMMUNICATION`, `OFFICIAL_SPEECH`, `CENTRAL_BANK_COMMUNICATION`,
  `STATISTICAL_RELEASE`, `OFFICIAL_PRESS_RELEASE`, `SANCTIONS_ACTION`
  (`deterministic_processor.ts:343-349`).
- Event Impact V1 (`backend/event_impact/deterministic_processor.ts:26`)
  defines `SUPPORTED_CANONICAL_EVENT_STATE_SCHEMA_VERSION = 1`. Any other
  schema version fails closed to `UNAVAILABLE` /
  `UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA`
  (`deterministic_processor.ts:350-354`). A schema-version-1 Event Version
  that reaches EI-3 today returns `INSUFFICIENT_EVIDENCE` /
  `GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE`
  (`deterministic_processor.ts:365`).
- Gold Transmission V1 (`backend/gold_transmission/
  deterministic_processor.ts:14`) defines `GOLD_TRANSMISSION_SUPPORTED_
  EVENT_SCHEMA_VERSION = 1`. Any other schema version fails closed to
  `UNAVAILABLE` / `UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA`
  (`deterministic_processor.ts:262-263`). A schema-version-1 Event Version
  that reaches GT-3 today returns `INSUFFICIENT_EVIDENCE` /
  `TYPED_EVENT_FACTS_UNAVAILABLE` (`deterministic_processor.ts:268`).
- `event_versions.effective_time` / `effective_time_precision` are the
  sole effective-time fields in the schema; V1's processor always emits
  `null`/`null` for both (`deterministic_processor.ts:488-489, 724-725`,
  typed as the literal `null`, not merely defaulted to it).

Both fail-closed behaviors above are exactly correct and this document
does not change either of them.

## 3. Exact V2 JSON contract

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 CPI report",
  "detail": null,
  "facts": {
    "release_family": "US_CPI",
    "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
    "metrics": [
      {
        "metric_code": "CPI_HEADLINE_MOM",
        "unit": "PERCENT_CHANGE_MOM",
        "actual": { "state": "KNOWN", "value": "0.3" },
        "consensus": { "state": "UNKNOWN", "value": null },
        "previous_reported": { "state": "KNOWN", "value": "0.2" },
        "revised_previous": { "state": "UNKNOWN", "value": null }
      }
    ]
  }
}
```

`event_type`/`subject`/`detail` are **byte-identical in meaning** to V1 —
same types, same normalization rules
(`normalizeWhitespace`/`resolveDetail`), same absence of provenance/IDs/
URLs/timestamps/Gold analytical fields. `facts` is the only addition.
`facts` is present if and only if `canonical_event_state_schema_version
= 2` (see §14 for the rejection case where it is absent or malformed at
that schema version).

## 4. Field definitions

### 4.1 `facts.release_family`

A stable, deterministic string identifying the release *type*, never a
free-text title. Not exhaustively frozen in EF-0 (adapters for new
families are a future, separately reviewed concern), but its **grammar**
is frozen now: uppercase ASCII, `A-Z0-9_` only, no whitespace, e.g.
`US_CPI`, `US_NFP`, `US_JOBLESS_CLAIMS`, `US_PCE`, `US_ISM_MANUFACTURING`,
`US_ISM_SERVICES`, `US_JOLTS`, `US_ADP`, `US_DURABLE_GOODS`, `US_GDP`.
Each `release_family` value's exact metric set is defined by the
adapter that introduces it, under the same review discipline as adding a
new `EventType` value — this document does not enumerate or freeze the
family list itself.

### 4.2 `facts.reference_period`

See §8 (dedicated section — this is a load-bearing distinction from
publication time and knowledge cutoff, called out separately per the
task).

### 4.3 `facts.metrics`

A **non-empty array** of metric objects. A release with exactly one
number (e.g. a single-print release) still uses a one-element array —
never a bare scalar shape — so a release that later reveals additional
sub-metrics does not require a shape migration, only a longer array.

Each metric object:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `metric_code` | string | yes | Stable identity within this release — see §4.4 |
| `unit` | string (frozen enum, §7) | yes | The unit `actual`/`consensus`/`previous_reported`/`revised_previous` are expressed in |
| `actual` | typed value (§6) | yes | The officially reported value for this reference period |
| `consensus` | typed value (§6) | yes | Market consensus/forecast, see §9 boundary — `UNKNOWN` unless a reviewed provider supplies it |
| `previous_reported` | typed value (§6) | yes | The value AS ORIGINALLY REPORTED for the prior reference period, before any later revision |
| `revised_previous` | typed value (§6) | yes | The value for the prior reference period AFTER a revision, if the current release explicitly states one |

`surprise` and `revision` are **not** contract fields — see §10.

### 4.4 `metric_code` — identity within one release

`metric_code` is the identity of a metric **within its own
`facts.metrics` array** — never global, never across release families.
Grammar: uppercase ASCII, `A-Z0-9_` only. Examples used by the mandatory
examples in §13: `CPI_HEADLINE_MOM`, `CPI_HEADLINE_YOY`, `CPI_CORE_MOM`,
`CPI_CORE_YOY`, `NFP_PAYROLL_CHANGE`, `UNEMPLOYMENT_RATE`, `AVG_HOURLY_
EARNINGS_MOM`, `PRIVATE_PAYROLLS`, `U6_UNDEREMPLOYMENT_RATE`,
`INITIAL_CLAIMS`, `CONTINUING_CLAIMS`, `CLAIMS_4WK_AVERAGE`.

**Array order carries no meaning.** Two payloads that differ only in the
order of `facts.metrics` are the same fact. A future canonicalization
step (mirroring the exact pattern already reviewed and shipped for Event
Impact's `p_interpretations` in `database/migrations/
0024_event_impact_atomic_rpc.sql`) sorts metrics deterministically by
`metric_code` before computing any fingerprint. `metric_code` **must be
unique within one `facts.metrics` array** — a duplicate `metric_code` in
the same payload is malformed (§14, example F).

## 5. Invariants

1. `facts` is present if and only if `canonical_event_state_schema_version
   = 2`. Schema version 1 payloads never carry `facts`; this is enforced
   structurally, not just by convention (see §12).
2. `facts.metrics` is a non-empty array when `facts` is present. An empty
   array is malformed, not a valid "no facts" representation — see §11 for
   how "this event type genuinely has no quantitative facts" is actually
   expressed (it is expressed by **staying at schema version 1**, not by
   an empty V2 `facts.metrics`).
3. Every `metric_code` is unique within its `facts.metrics` array.
4. Every typed value field (`actual`/`consensus`/`previous_reported`/
   `revised_previous`) obeys the state/value pairing in §6 — `KNOWN`
   requires a non-null `value` matching the numeric-string grammar in
   §6.1; `UNKNOWN` requires `value: null`. A `KNOWN` state with a `null`
   value, or an `UNKNOWN` state with a non-null value, is malformed.
5. `actual`, `consensus`, `previous_reported`, and `revised_previous` for
   the same metric object share the same `unit` implicitly (the metric
   object has exactly one `unit` field, not one per value) — a metric
   whose consensus is reported in a different unit than its actual is a
   distinct concern for a future adapter to normalize before emission,
   not something this contract represents as mixed units on one metric.
6. `facts` never contains `effective_time`/`effective_time_precision` —
   those remain exclusively `event_versions` columns (§12.3).
7. `facts` never contains collector/ingestion provenance (§10).

## 6. Null / unknown semantics — critical

**Unknown is never zero. Missing data is never a placeholder.** This is
the same discipline already enforced for Event Impact's `magnitude_state`/
`confidence_state` and Gold Transmission's `evidence_state` — extended
here to raw facts.

### 6.1 Typed value shape

Every `actual`/`consensus`/`previous_reported`/`revised_previous` field is
an object, never a bare JSON number or `null`:

```json
{ "state": "KNOWN", "value": "0.3" }
{ "state": "UNKNOWN", "value": null }
```

`state` is a two-value enum: `KNOWN` | `UNKNOWN`. When `KNOWN`, `value` is
a canonical decimal string (§6.2, never a JSON number). When `UNKNOWN`,
`value` is `null`.

**Why two states, not three:** Event Impact and Gold Transmission both
use a three-state `UNASSESSED`/`UNKNOWN`/`ESTIMATED` vocabulary because
those are *assessment* layers, where "never attempted" and "attempted but
indeterminate" are both meaningful and distinct outcomes of a decision
process. A raw fact is not a decision — a value was either successfully
extracted from an official/reviewed source for this reference period, or
it was not. *Why* it was not (no reviewed provider exists at all, vs. the
adapter ran and could not parse this specific field this cycle) is
provenance/diagnostic information, not a canonical factual state, and
belongs to a future evidence/adapter-log concern explicitly kept outside
CES (§10) — never a third value squeezed into the canonical fact itself.

### 6.2 Canonical numeric representation

`value` (when `state = "KNOWN"`) is always a **JSON string**, never a JSON
number, matching exactly:

```
^-?(0|[1-9][0-9]*)(\.[0-9]+)?$
```

- No thousands separators, no `%` sign, no unit suffix (`"4.1"`, never
  `"4,1%"`, `"200K"`, or `"3 million"` — those are exactly what this
  contract exists to reject).
- No leading `+`, no leading zeros other than a bare `"0"`, no exponential
  notation.
- The decimal-string form is chosen specifically over a JSON number to
  avoid floating-point round-tripping and JSON-serialization
  non-determinism (e.g. `0.30` vs `0.3` vs IEEE-754 representation drift)
  becoming a **fingerprint-instability** bug the same class as the GT-6
  secret-redaction truncation-ordering defect fixed earlier in this
  program — a canonical string is trivially stable under
  `JSON.stringify`/re-parse and trivially validated by the regex above.
- The contract does **not** mandate a fixed number of decimal places —
  an adapter preserves exactly the precision the official source actually
  reported (e.g. unemployment rate to one decimal, average hourly
  earnings sometimes to two) rather than the contract inventing or
  stripping precision.
- `THOUSANDS_OF_PERSONS`/`PERSONS`-unit values (see §7) still use this
  same decimal-string grammar — the *unit* says "thousands," the *value*
  is not scaled/formatted by the contract.

### 6.3 Worked absence examples (mirroring the task's own list exactly)

- Actual unavailable: `"actual": { "state": "UNKNOWN", "value": null }`.
- No authorized consensus provider exists at all (§9): `"consensus": {
  "state": "UNKNOWN", "value": null }` — the *same* representation as any
  other unknown; this contract does not distinguish "no provider" from
  "provider ran, no value" as two different canonical states (§6.1
  reasoning above; that distinction is a provenance/adapter concern).
- No previous value: `"previous_reported": { "state": "UNKNOWN", "value":
  null }`.
- No revision evidence: `"revised_previous": { "state": "UNKNOWN", "value":
  null }` — **never** defaulted to equal `previous_reported`. Revision is
  never assumed to be zero (no change) unless the upstream source
  explicitly states the prior value was confirmed unchanged, in which
  case the adapter emits `revised_previous` as `KNOWN` with the same
  numeric value as `previous_reported` — an explicit fact, not an
  absence treated as "no change."

## 7. Unit model

A frozen, explicit enum — never free text, never inferred from
`metric_code` naming alone. EF-0 freezes the following initial set;
extending it later follows the same review discipline as extending
`EventType` or `release_family`:

| Unit | Meaning | Example |
|---|---|---|
| `LEVEL_PERCENT` | A percentage that is itself a level/rate, not a change | Unemployment rate |
| `PERCENT_CHANGE_MOM` | Percentage change, month-over-month | CPI headline MoM |
| `PERCENT_CHANGE_YOY` | Percentage change, year-over-year | CPI headline YoY |
| `PERCENT_CHANGE_ANNUALIZED` | A period change expressed as an annualized rate | GDP QoQ annualized |
| `BASIS_POINTS` | A change or level expressed in basis points | A rate move expressed in bps |
| `INDEX_POINTS` | A raw index level or index-point change | ISM Manufacturing PMI level |
| `PERSONS` | A raw count of persons | — |
| `THOUSANDS_OF_PERSONS` | A count of persons, reported in thousands | Nonfarm payroll change, initial/continuing claims |
| `CURRENCY_AMOUNT` | A monetary amount — **requires** an accompanying `currency_code` (ISO 4217, e.g. `"USD"`) on the same metric object | Durable goods orders value |

**Cross-unit arithmetic is forbidden.** `actual`/`consensus`/`previous_
reported`/`revised_previous` on one metric object are only ever compared
or subtracted from each other because they share that metric's single
`unit` (invariant §5.5) — a future consumer must never compare values
across two different metric objects (e.g. `CPI_HEADLINE_MOM` in
`PERCENT_CHANGE_MOM` against `CPI_HEADLINE_YOY` in `PERCENT_CHANGE_YOY`)
without explicit, separately reviewed logic for doing so.

## 8. Reference-period model

**Publication timestamp is not reference period. Knowledge cutoff is not
reference period. `effective_time` is not automatically reference
period.** A CPI report released in September commonly refers to August —
conflating the two would silently misdate every macro release.

`facts.reference_period` is a discriminated union on `kind`:

```json
{ "kind": "MONTH", "year": 2026, "month": 8 }
{ "kind": "QUARTER", "year": 2026, "quarter": 3 }
{ "kind": "WEEK_ENDING", "date": "2026-09-13" }
{ "kind": "DATE", "date": "2026-09-20" }
```

- `MONTH`: `month` is `1`-`12`.
- `QUARTER`: `quarter` is `1`-`4`.
- `WEEK_ENDING`: `date` is the ISO-8601 calendar date (`YYYY-MM-DD`) the
  source itself labels as the week-ending date (e.g. jobless claims "week
  ended September 13, 2026") — never derived by the adapter from
  publication timing.
- `DATE`: an exact single calendar date, for releases that reference a
  specific day rather than a period (`YYYY-MM-DD`).

The mapping from a release's publication time to its reference period is
**never derived automatically** by this contract or by any generic
processor logic — it is supplied explicitly and deterministically by the
future source-specific adapter that knows, for that exact release family,
which period a given publication covers. No inference from title text, no
"most recent completed month" heuristic.

## 9. Consensus / forecast boundary — critical

Official statistical sources (BLS, Federal Reserve, ECB, US Treasury,
etc.) report `actual` and `previous_reported`/`revised_previous` — they do
**not** supply market consensus. Consensus is a separate commercial data
category (surveyed economist forecasts), never bundled with an official
release.

Rules, unchanged from the task's own framing:

- `actual`/`previous_reported`/`revised_previous` may be populated by a
  reviewed **official** adapter (Federal Reserve/ECB/US Treasury/OFAC-class
  authority, matching the existing exact-tuple discipline in
  `deterministic_processor.ts` §2).
- `consensus` may be populated **only** when a separately reviewed,
  separately authorized source contract explicitly supplies it.
- Absent such a provider, `consensus` is **always** `{ "state": "UNKNOWN",
  "value": null }` — never inferred, never copied from a prior release,
  never derived from price action, Committee prose, a legacy score, or an
  LLM.
- Adding a paid/new consensus provider is explicitly a **Human Gate** and
  explicitly **out of scope for EF-0** — this document defines the shape
  consensus would occupy if and when that provider exists; it does not
  authorize or imply adding one.

## 10. Surprise / revision — derived, never canonical

**Neither `surprise` nor `revision` is a field in the V2 JSON contract.**
Both are **deterministic, downstream-derived quantities**, computed on
demand from already-canonical fields by any consumer — never persisted,
never a second source of truth that could drift out of sync with
`actual`/`consensus`/`previous_reported`/`revised_previous`. This is the
"simplest design that cannot become internally inconsistent" the task
asked EF-0 to prefer: if `surprise` were also stored, a future bug could
persist a `surprise` value that no longer matches its own `actual`/
`consensus` pair after some other write path touched one but not the
other — impossible if it is never stored at all.

### 10.1 Surprise

```
surprise_raw = actual.value - consensus.value      (same metric, same unit)
```

Defined **only** when both `actual.state = "KNOWN"` and `consensus.state =
"KNOWN"` for the same metric object. If either is `"UNKNOWN"`, surprise is
undefined — a consumer must treat it as `null`, never `0` and never
"neutral." A normalized/scaled surprise magnitude (e.g. in standard-
deviation units of historical surprise) is explicitly **out of scope for
EF-0** — inventing a normalization methodology without separate review
would itself be exactly the kind of unreviewed positive logic this
document exists to gate.

### 10.2 Revision

```
revision = revised_previous.value - previous_reported.value
```

Defined **only** when both are `"KNOWN"` for the same metric object.
`previous_reported` and `revised_previous` are always stored as two
**distinct** fields (never one field silently overwritten by the other —
see invariant discussion in §6.3) precisely so this derivation is always
possible to compute correctly when the evidence exists, and is always
`null` — never `0` — when it does not.

## 11. Provenance boundary

CES (V1 and V2 alike) represents **canonical factual state** — the same
principle V1 already established (`0012...sql:401`: "jamais une
évaluation de direction/magnitude/confiance/pricing pour l'or") extends
naturally to: *never transient collector metadata either*. Specifically
excluded from `facts`, on purpose:

- fetch timestamp, ingestion timestamp (these belong to `event_versions.
  knowledge_cutoff`/RAW observation metadata, already modeled elsewhere,
  never duplicated into CES);
- arbitrary URL formatting or the source URL itself;
- collector retry/attempt metadata;
- any field whose *change alone*, with the underlying economic fact
  itself unchanged, would force a new Event Version (a new
  `state_fingerprint`, since that fingerprint is computed over
  `canonical_event_state` — `backend/event_engine/deterministic_
  processor.ts`'s state-fingerprint payload, matching the frozen contract
  in `0020_event_version_atomic_rpc.sql`).

A future typed adapter still needs traceable evidence (which document,
which exact source reading produced this `actual` value) — that evidence
belongs to a **separate, future, non-canonical** record (the same
"evidence stays outside the canonical truth" principle GT-0A already
applied when it kept native market-driver provenance in its own table
rather than folding it into `event_versions`). This document does not
design that evidence record — only states plainly that CES must never
become it.

## 12. Event identity boundary

EF-0 does **not** implement strong identity for macro releases. It does
not derive, compute, or persist any release-identity value. It states
only what a **future, separately reviewed** milestone may build on top of
this contract without contradicting it:

A deterministic macro-release identity is representable, without any
fuzzy text similarity, from the explicit tuple:

```
(authority, release_family, reference_period)
```

— e.g. `(FEDERAL_RESERVE-equivalent BLS authority, US_CPI, {MONTH, 2026,
8})` deterministically identifies "the August 2026 US CPI release,"
independent of exact publication title wording, exactly mirroring the
existing strong-identity discipline in `deterministic_processor.ts` §7
(`StrongIdentityContext` — curated-only, never discovered from title/URL/
provider text). This document only names the tuple's shape; it does not
implement identity resolution, does not touch `StrongIdentityContext`,
and does not weaken the existing rule that strong identity is only ever
*consumed* when explicitly curated, never inferred.

### 12.1 EventType — no change

`EventType`'s frozen six-value union is unchanged by this document. A
future decision on whether `STATISTICAL_RELEASE` alone is CES-V2-eligible,
or whether other types could be, is explicitly deferred (§16) — not
decided here.

### 12.2 Effective time — no change

`event_versions.effective_time`/`effective_time_precision` remain the
**sole** effective-time fields, unchanged, and `facts.reference_period`
is never a substitute for them or vice versa: reference period says *what
period the number describes*; effective time (still always `null` in V1,
per §2) says *when the event itself took legal/factual effect*. The two
answer different questions and are never merged.

### 12.3 No competing canonical table

Reaffirmed explicitly per the frozen architecture constraint: this
document proposes zero new tables. `event_versions.canonical_event_state`
remains the **only** canonical factual event truth, versioned by
`canonical_event_state_schema_version`. Any future raw/evidence storage
for source adapters is a distinct, later, non-canonical concern (§11) —
never a second table that could disagree with CES about what the facts
are.

## 13. Event types without quantitative facts — decision

**Decision: Option A.** CES V2 (`facts` present, schema version 2)
applies only to events that genuinely carry a typed quantitative payload.
Every other event type — speeches, sanctions actions, qualitative
central-bank communication, and any `STATISTICAL_RELEASE` for which no
reviewed adapter yet exists — **remains CES schema version 1**,
unconditionally, exactly as today.

**Why not Option B** (an explicit typed "no quantitative facts" state):
it would force every non-quantitative event through a schema-version
bump and an empty/placeholder `facts` shape for no informational gain —
exactly the "fake empty facts and unnecessary schema churn" the task
warned against. Schema version itself already carries this information
for free: schema version 1 already *means* "no typed facts here," with
zero new vocabulary required. A future `resolveEventType()`-adjacent
decision may determine which `EventType` values are ever eligible to
advance to schema version 2 (the same review discipline as the ECB
eligibility gate shipped in PR #45) — that gating decision is explicitly
**not** made in this document.

## 14. Compatibility with EI V1 / GT V1

No change to either processor. Both already fail closed correctly for
any schema version other than `1` (§2), which is precisely the behavior
this document relies on and preserves:

- The moment a future milestone begins emitting schema version 2 Event
  Versions (**not** in this PR — see §16), EI-3 and GT-3 will continue to
  return `UNAVAILABLE` / `UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA` for
  those rows, exactly as they already do today for any unrecognized
  version — **not** a crash, **not** a silently wrong `INSUFFICIENT_
  EVIDENCE`, and **not** an accidental "it just works" outcome that was
  never reviewed.
- EI V2 and GT V2 support are explicitly **future, separate, coordinated**
  milestones (§16) — this document does not modify either processor's
  source, does not add a schema-version-2 branch to either, and does not
  change `SUPPORTED_CANONICAL_EVENT_STATE_SCHEMA_VERSION` or
  `GOLD_TRANSMISSION_SUPPORTED_EVENT_SCHEMA_VERSION` from `1`.

## 15. Examples

### A) CPI with actual + consensus + previous (valid)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 CPI report",
  "detail": null,
  "facts": {
    "release_family": "US_CPI",
    "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
    "metrics": [
      {
        "metric_code": "CPI_HEADLINE_MOM",
        "unit": "PERCENT_CHANGE_MOM",
        "actual": { "state": "KNOWN", "value": "0.3" },
        "consensus": { "state": "KNOWN", "value": "0.2" },
        "previous_reported": { "state": "KNOWN", "value": "0.2" },
        "revised_previous": { "state": "UNKNOWN", "value": null }
      }
    ]
  }
}
```
Derived (never stored): `surprise_raw = 0.3 - 0.2 = 0.1`. `revision`:
undefined/`null` (`revised_previous` is `UNKNOWN`).

### B) CPI with actual but NO consensus (valid — the §9 boundary)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 CPI report",
  "detail": null,
  "facts": {
    "release_family": "US_CPI",
    "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
    "metrics": [
      {
        "metric_code": "CPI_HEADLINE_MOM",
        "unit": "PERCENT_CHANGE_MOM",
        "actual": { "state": "KNOWN", "value": "0.3" },
        "consensus": { "state": "UNKNOWN", "value": null },
        "previous_reported": { "state": "KNOWN", "value": "0.2" },
        "revised_previous": { "state": "UNKNOWN", "value": null }
      }
    ]
  }
}
```
Missing consensus is `UNKNOWN`, **not** `0` and not "no surprise" — a
consumer computing surprise from this payload must produce `null`, never
`0`.

### C) NFP with a previous-value revision (valid)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 Employment Situation report",
  "detail": null,
  "facts": {
    "release_family": "US_NFP",
    "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
    "metrics": [
      {
        "metric_code": "NFP_PAYROLL_CHANGE",
        "unit": "THOUSANDS_OF_PERSONS",
        "actual": { "state": "KNOWN", "value": "142" },
        "consensus": { "state": "KNOWN", "value": "165" },
        "previous_reported": { "state": "KNOWN", "value": "114" },
        "revised_previous": { "state": "KNOWN", "value": "89" }
      },
      {
        "metric_code": "UNEMPLOYMENT_RATE",
        "unit": "LEVEL_PERCENT",
        "actual": { "state": "KNOWN", "value": "4.3" },
        "consensus": { "state": "KNOWN", "value": "4.2" },
        "previous_reported": { "state": "KNOWN", "value": "4.2" },
        "revised_previous": { "state": "UNKNOWN", "value": null }
      }
    ]
  }
}
```
Derived: `NFP_PAYROLL_CHANGE` surprise `= 142 - 165 = -23`; revision `=
89 - 114 = -25` (the prior month was revised DOWN by 25k — this is
computed from two distinct stored facts, never from an overwritten single
field). `UNEMPLOYMENT_RATE` has no revision evidence this cycle:
`revised_previous` stays `UNKNOWN`, never silently assumed equal to
`previous_reported`.

### D) Jobless Claims with several metrics from one release (valid)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Department of Labor releases jobless claims report for the week ended September 13, 2026",
  "detail": null,
  "facts": {
    "release_family": "US_JOBLESS_CLAIMS",
    "reference_period": { "kind": "WEEK_ENDING", "date": "2026-09-13" },
    "metrics": [
      {
        "metric_code": "INITIAL_CLAIMS",
        "unit": "THOUSANDS_OF_PERSONS",
        "actual": { "state": "KNOWN", "value": "231" },
        "consensus": { "state": "KNOWN", "value": "235" },
        "previous_reported": { "state": "KNOWN", "value": "227" },
        "revised_previous": { "state": "UNKNOWN", "value": null }
      },
      {
        "metric_code": "CONTINUING_CLAIMS",
        "unit": "THOUSANDS_OF_PERSONS",
        "actual": { "state": "KNOWN", "value": "1926" },
        "consensus": { "state": "UNKNOWN", "value": null },
        "previous_reported": { "state": "KNOWN", "value": "1920" },
        "revised_previous": { "state": "UNKNOWN", "value": null }
      },
      {
        "metric_code": "CLAIMS_4WK_AVERAGE",
        "unit": "THOUSANDS_OF_PERSONS",
        "actual": { "state": "KNOWN", "value": "229.5" },
        "consensus": { "state": "UNKNOWN", "value": null },
        "previous_reported": { "state": "UNKNOWN", "value": null },
        "revised_previous": { "state": "UNKNOWN", "value": null }
      }
    ]
  }
}
```
Three independent metrics, one release, one `reference_period` (a
`WEEK_ENDING`, distinct from the `MONTH`/`QUARTER` shapes above) — proves
`metric_code` is doing the identity work `facts.metrics` needs, not array
position.

### E) Event where quantitative facts are not applicable (valid — stays V1)

```json
{
  "event_type": "OFFICIAL_SPEECH",
  "subject": "Federal Reserve Governor delivers remarks on the economic outlook",
  "detail": "The speaker discussed current labor market conditions without new data disclosures."
}
```
Schema version **1**, no `facts` key at all — per the §13 decision, this
is not an error, not a degraded case, and not something EF-0 changes.

### F) Malformed / internally inconsistent payloads (MUST be rejected)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 CPI report",
  "detail": null,
  "facts": {
    "release_family": "US_CPI",
    "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
    "metrics": [
      {
        "metric_code": "CPI_HEADLINE_MOM",
        "unit": "PERCENT_CHANGE_MOM",
        "actual": { "state": "KNOWN", "value": null },
        "consensus": { "state": "UNKNOWN", "value": "0.2" },
        "previous_reported": { "state": "KNOWN", "value": "0.2" },
        "revised_previous": { "state": "UNKNOWN", "value": null }
      },
      {
        "metric_code": "CPI_HEADLINE_MOM",
        "unit": "PERCENT_CHANGE_YOY",
        "actual": { "state": "KNOWN", "value": "2,9%" },
        "consensus": { "state": "UNKNOWN", "value": null },
        "previous_reported": { "state": "UNKNOWN", "value": null },
        "revised_previous": { "state": "UNKNOWN", "value": null }
      }
    ]
  }
}
```
Rejected for **three independent** reasons, each alone sufficient:
1. `actual.state = "KNOWN"` with `value: null` violates the §6.1/invariant-4
   state/value pairing (and symmetrically `consensus.state = "UNKNOWN"`
   with a non-null `value: "0.2"` violates the same pairing in the other
   direction).
2. `metric_code = "CPI_HEADLINE_MOM"` appears **twice** in the same
   `facts.metrics` array, violating invariant §5.3 (unique within one
   payload) — even though the two entries claim different `unit`s, a
   duplicate `metric_code` is never disambiguated by `unit`.
3. `"2,9%"` violates the canonical numeric-string grammar in §6.2 (comma
   decimal separator and a literal `%` suffix are both forbidden — the
   unit is already carried by the `unit` field, never re-encoded into the
   value string).

## 16. Activation prerequisites

Schema version 2 is **not activated** by this document. Before any Event
Version is ever created with `canonical_event_state_schema_version = 2`,
all of the following must independently exist and be independently
reviewed:

1. A reviewed, source-specific adapter contract for at least one
   `release_family` that deterministically maps a specific official
   collector's output into this exact `facts` shape (no generic
   free-text/keyword parsing invented ad hoc).
2. A reviewed decision on which `EventType`s are ever eligible to advance
   past schema version 1 (§13's corollary — not decided here).
3. A reviewed decision on where adapter-level evidence/provenance for a
   typed fact is stored (§11 — explicitly not CES, not designed here).
4. A reviewed, additive-only migration that extends `canonical_event_
   state_schema_version` handling wherever it is currently gated to
   exactly `1` — including, explicitly, the EI-3 and GT-3 `SUPPORTED_*`
   constants, which must move to `2` **only** in the same coordinated
   milestone that also teaches those processors what a schema-version-2
   payload actually contains, never as an accidental side effect of a
   schema/persistence-only change.
5. If/when a consensus provider is added: a separate, explicit Human
   Gate authorization (§9) — not implied or pre-approved by this
   document.

## 17. Next implementation sequence (proposed, not authorized by this PR)

Mirroring the EI-1..EI-6 / GT-0..GT-6 milestone discipline already used
twice in this program:

- **EF-1**: one reviewed source adapter for exactly one `release_family`
  (e.g. `US_CPI`) — pure mapping function, RAW input to `facts` output,
  no persistence, no runtime, matching the purity discipline already
  established for `deterministic_processor.ts`.
- **EF-2**: the additive migration that allows `canonical_event_state_
  schema_version = 2` to be persisted for that one adapter's output —
  schema-only, no live apply in the same task, matching the `0023`/`0027`
  precedent.
- **EF-3**: EI-3/GT-3 updated, in the same coordinated milestone, to
  actually consume schema-version-2 `facts` for the one supported
  `release_family` — still conservative/fail-closed for every metric this
  contract doesn't yet cover.
- **EF-4+**: additional `release_family` adapters, each independently
  reviewed, each additive.
- Consensus-provider activation (§9/§16.5) is its own, separately gated
  track, not a numbered EF milestone by default.

---

No code, migration, table, runtime, source adapter, Worker route, or
Supabase call is introduced by this document. `canonical_event_state_
schema_version` remains `1` everywhere in the live system after this PR
merges.
