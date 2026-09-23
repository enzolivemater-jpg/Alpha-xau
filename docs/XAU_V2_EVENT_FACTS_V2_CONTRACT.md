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
- `event_versions.knowledge_cutoff` is the Event Version's own, already
  existing, `TIMESTAMPTZ` field — not part of `canonical_event_state`,
  never duplicated into it (this remains true after this revision).
- The deterministic Event processor explicitly does **not** discover or
  infer strong identity: it "only CONSUMES a strong identity when the
  caller explicitly supplies one as curated input (`StrongIdentityContext`)
  — it never discovers or infers one," and "absent an explicit curated
  strong-identity match, every observation independently plans
  `CREATE_NEW_CLUSTER`" (`deterministic_processor.ts:29-33, 35-44`,
  `ClusterDisposition = 'CREATE_NEW_CLUSTER' | 'ASSIGN_EXISTING'` at
  `deterministic_processor.ts:631`). This is load-bearing for §12 below.

Both fail-closed behaviors above are exactly correct and this document
does not change either of them.

## 3. Exact V2 JSON contract

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 Employment Situation report",
  "detail": null,
  "facts": {
    "release_family": "US_NFP",
    "metrics": [
      {
        "metric_code": "NFP_PAYROLL_CHANGE",
        "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
        "unit": "THOUSANDS_OF_PERSONS",
        "actual": { "state": "KNOWN", "value": "142" },
        "consensus": { "state": "KNOWN", "value": "165" },
        "prior_periods": [
          {
            "reference_period": { "kind": "MONTH", "year": 2026, "month": 7 },
            "prior_value": { "state": "KNOWN", "value": "89" },
            "revised_value": { "state": "KNOWN", "value": "85" }
          }
        ]
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
= 2` (see §5, invariant 1, and §15 examples F/G for the rejection case
where it is absent or malformed at that schema version). Exact allowed
keys at every level are frozen in §5bis — no additional key is ever
permitted anywhere in this contract.

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

**GDP / staged releases (explicit rule, not deferred ambiguously):**
GDP is published in multiple vintages for the *same* reference quarter —
commonly an Advance estimate, a Second estimate, and a Final/Third
estimate, each separately scheduled and separately market-moving. A
later vintage for the same quarter is **not** modeled as a revision of
the earlier one (§10.2's `prior_periods[]`-based revision is for a *later
release's* restatement of an *earlier period*, not for a *later vintage of
the same period*). Vintage **must** be part of the release's identity,
deterministically, never inferred or silently ignored. EF-0 freezes only
the rule, not the mechanism — a future source-contract milestone must
choose **one** of:
- distinct `release_family` values per vintage (e.g. `US_GDP_ADVANCE`,
  `US_GDP_SECOND`, `US_GDP_FINAL`); or
- a future explicit `release_stage` field, defined and reviewed in that
  same milestone, never added ad hoc.
Neither mechanism is implemented in EF-0.

### 4.2 `facts.metrics`

A **non-empty array** of metric objects. A release with exactly one
number (e.g. a single-print release) still uses a one-element array —
never a bare scalar shape — so a release that later reveals additional
sub-metrics does not require a shape migration, only a longer array.

### 4.3 Metric object fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `metric_code` | string | yes | Stable identity within this release — see §4.4 |
| `reference_period` | object (discriminated union, §8) | yes | **Per-metric.** The **current** period THIS metric's own `actual`/`consensus` describe — see §4.5 |
| `unit` | string (frozen enum, §7) | yes | The unit `actual`/`consensus`/every `prior_periods[]` value is expressed in |
| `actual` | typed value (§6.1) | yes | The officially reported value for this metric's own `reference_period` |
| `consensus` | typed value (§6.1) | yes | Market consensus/forecast, see §9 boundary — `UNKNOWN` unless a reviewed provider supplies it |
| `prior_periods` | array of prior-period entries (§4.6) | yes, may be empty | Zero or more **earlier** periods this same release explicitly restates — see §4.6 |

`surprise` and `revision` are **not** contract fields — see §10.

### 4.4 `metric_code` — identity within one release

`metric_code` is the identity of a metric **within its own
`facts.metrics` array** — never global, never across release families.
Grammar: uppercase ASCII, `A-Z0-9_` only. Examples used by the mandatory
examples in §15: `CPI_HEADLINE_MOM`, `CPI_HEADLINE_YOY`, `CPI_CORE_MOM`,
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
the same payload is malformed (§15, example F).

### 4.5 Why `reference_period` is per-metric, not per-release

A single release-level period is not safe: `US_JOBLESS_CLAIMS` alone
demonstrates it — `INITIAL_CLAIMS`/`CONTINUING_CLAIMS` are typically
`WEEK_ENDING`-keyed but can reference **different** underlying weeks
(continuing claims data lags initial claims by one week in the DOL's own
published methodology), and `CLAIMS_4WK_AVERAGE` covers a **span**, not a
single week — its `reference_period` names only the week-ending date the
published average is *anchored* to, never the full four-week span itself
(§8, §15 example D). Forcing one shared `reference_period` for the whole
release would either be wrong for at least one metric or would silently
paper over a genuine difference that later matters for identity and
comparison. Each metric therefore carries its own **current**
`reference_period`, and no two metrics are assumed to share one merely
because they appear in the same release/payload.

### 4.6 `prior_periods[]` — this release's own restatement of earlier periods (review fix)

**Why this replaced the earlier draft's cross-release designs:** a
release-local mechanism must capture two distinct things without either
requiring reconstruction from other Event Versions or silently dropping
information: (1) which earlier periods *this specific release* restates,
and (2) what changed, entirely from what is present in *this single
payload*. NFP is the motivating case — each month's Employment Situation
report typically revises **both** of the two preceding months' payroll
figures in the same publication, not just the immediately prior one — so
`prior_periods[]` is an array (zero or more entries), and each entry
carries **both** the value as it was known immediately before this
release and the value as restated by this release, so the revision this
release itself announces is directly computable **from this payload
alone** — never by reconstructing a chain across Event Versions.

`metric.reference_period` (§4.5) is always the **current** period —
the period this metric's own `actual`/`consensus` describe.
`prior_periods[]` is strictly about **earlier** periods this same
official release explicitly restates.

Each entry:

```json
{
  "reference_period": { "kind": "MONTH", "year": 2026, "month": 7 },
  "prior_value": { "state": "KNOWN", "value": "89" },
  "revised_value": { "state": "KNOWN", "value": "85" }
}
```

| Field | Type | Meaning |
|---|---|---|
| `reference_period` | object (§8) | The **earlier** period this entry restates — same `kind` as the metric's own `reference_period`, strictly chronologically earlier (§4.6.1) |
| `prior_value` | typed value (§6.1) | The latest **publicly reported** value for that earlier period, as it stood **immediately before** this release |
| `revised_value` | typed value (§6.1) | The value for that same earlier period, as reported/restated **by this release** |

Both fields use the generic two-state typed-value shape (§6.1):
`{ "state": "KNOWN"|"UNKNOWN", "value": ... }`. `UNKNOWN` is never zero —
a `prior_value` an adapter genuinely cannot establish, or a `revised_value`
this release does not actually restate a numeric figure for, is
`UNKNOWN`, not omitted-as-if-unchanged and not defaulted to any number.

**No `vintage` field, and no `revision` field — deliberately.** The
calendar date a restatement became known is transient
provenance/evidence (§11), not a canonical fact, and is never stored in
CES. `revision` itself (`revised_value - prior_value`, defined only when
both are `KNOWN`, otherwise `null`) is a **derived** quantity (§10.2) —
computed on demand by a consumer, never persisted, for the same
"cannot become internally inconsistent" reason `surprise` is never
persisted (§10).

`prior_periods` is always present on every CES V2 metric. It may be
`[]` only when the current release restates no earlier period for that
metric. It **must be non-empty whenever this release explicitly restates
at least one earlier period** for that metric, and it may contain one or
multiple entries. Non-emptiness never depends on whether a release family
usually restates one period or several.

Exact entry keys, frozen (§5bis): `reference_period`, `prior_value`,
`revised_value` — no extra keys, no `vintage`, no `revision`.

Array order carries no meaning; entries are unique by normalized
`reference_period` (no two entries in one array may restate the same
earlier period); a future canonicalization step sorts `prior_periods[]`
entries deterministically by chronological normalized `reference_period`
(§8.1) before computing any fingerprint, exactly like `facts.metrics`
(§4.4).

#### 4.6.1 Ordering and identity rules

- Every entry's `reference_period.kind` **must equal** the metric's own
  `reference_period.kind` — a `MONTH`-keyed metric's `prior_periods[]`
  entries are all `MONTH`; a `WEEK_ENDING`-keyed metric's are all
  `WEEK_ENDING`; mixing kinds within one metric's `prior_periods[]` is
  malformed.
- Every entry's `reference_period` **must be strictly chronologically
  earlier** than the metric's own `reference_period`, using the per-kind
  ordering defined in §8.1. An entry whose period equals or is later than
  the metric's own period is malformed (§15, example F).
- No two entries in the same `prior_periods[]` array may share the same
  `reference_period` — each earlier period is restated **at most once**
  per release, per metric.
- **Array order carries no meaning**, exactly like `facts.metrics` — a
  future canonicalization step sorts `prior_periods[]` entries
  deterministically by `reference_period` before computing any
  fingerprint.

## 5. Invariants

1. `facts` is present if and only if `canonical_event_state_schema_version
   = 2`. Schema version 1 payloads never carry `facts`; this is enforced
   structurally, not just by convention (see §14).
2. `facts.metrics` is a non-empty array when `facts` is present. An empty
   array is malformed, not a valid "no facts" representation — see §13 for
   how "this event type genuinely has no quantitative facts" is actually
   expressed (it is expressed by **staying at schema version 1**, not by
   an empty V2 `facts.metrics`).
3. Every `metric_code` is unique within its `facts.metrics` array.
4. Every typed value field in this contract (`actual`, `consensus`, and
   each `prior_periods[]` entry's `prior_value`/`revised_value`) obeys the
   single state/value pairing in §6.1 — `KNOWN` requires a `value`
   matching the canonical decimal-string grammar in §6.2 exactly;
   `UNKNOWN` requires `value: null`. A `KNOWN` state with a `null` value,
   or an `UNKNOWN` state with a non-null value, is malformed.
5. `actual`, `consensus`, and every `prior_periods[]` value for the same
   metric object share the same `unit` implicitly (the metric object has
   exactly one `unit` field) — a metric whose consensus or a restated
   prior period is reported in a different unit than `actual` is a
   distinct concern for a future adapter to normalize before emission,
   not something this contract represents as mixed units on one metric.
6. Every `prior_periods[]` entry obeys the ordering/identity rules in
   §4.6.1 (matching `kind`, strictly earlier, no duplicate period within
   one array).
7. `facts` never contains `effective_time`/`effective_time_precision` —
   those remain exclusively `event_versions` columns (§12.5).
8. `facts` never contains collector/ingestion provenance (§11), and never
   contains `vintage` or a stored `revision` value (§4.6, §10.2).
9. Every JSON object in this contract (the CES V2 object itself, `facts`,
   each metric object, each typed-value object, each `prior_periods[]`
   entry, each `reference_period` variant) contains **only** the keys
   listed for it in §5bis — an unrecognized additional key at any level
   is malformed (§15, example G).

## 5bis. Exact key policy

Frozen exactly, for deterministic canonicalization/fingerprinting. No
level in this contract ever tolerates an unlisted key.

| Object | Exact allowed keys |
|---|---|
| CES V2 top-level object (schema version 2) | `event_type`, `subject`, `detail`, `facts` |
| `facts` | `release_family`, `metrics` |
| metric object | `metric_code`, `reference_period`, `unit`, `actual`, `consensus`, `prior_periods` |
| typed-value object (`actual`, `consensus`, a `prior_periods[]` entry's `prior_value`/`revised_value`) | `state`, `value` |
| `prior_periods[]` entry | `reference_period`, `prior_value`, `revised_value` |
| `reference_period` (`kind: "MONTH"`) | `kind`, `year`, `month` |
| `reference_period` (`kind: "QUARTER"`) | `kind`, `year`, `quarter` |
| `reference_period` (`kind: "WEEK_ENDING"`) | `kind`, `date` |
| `reference_period` (`kind: "DATE"`) | `kind`, `date` |

(CES V1's top-level object keeps its already-frozen V1 key set —
`event_type`, `subject`, `detail`, no `facts` — unchanged by this
document.)

## 6. Null / unknown semantics — critical

**Unknown is never zero. Missing data is never a placeholder.** This is
the same discipline already enforced for Event Impact's `magnitude_state`/
`confidence_state` and Gold Transmission's `evidence_state` — extended
here to raw facts.

### 6.1 Typed value shape (`actual`, `consensus`, `prior_periods[]` entry fields)

A single shape is used for **every** value-bearing field in this
contract — `actual`, `consensus`, and each `prior_periods[]` entry's
`prior_value`/`revised_value` alike:

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
it was not. *Why* it was not is provenance/diagnostic information, not a
canonical factual state, and belongs to a future evidence/adapter-log
concern explicitly kept outside CES (§11) — never a third value squeezed
into the canonical fact itself.

### 6.2 Canonical decimal normalization

The canonical value represents numeric meaning only — it is never a
preservation of the source's original lexical precision. (If preserving
exactly how a source formatted a number is ever useful, that belongs to
future non-canonical provenance/evidence, §11 — never to CES. This
document does not claim both "canonical" and "preserves source
precision" — those are incompatible, and canonical wins.)

**Canonicalization algorithm** (applied by the adapter before a value is
ever written to `facts`):

1. Parse the source's reported numeric sign, integer part, and
   fractional part.
2. Strip leading zeros from the integer part, keeping a single `0` if
   the integer part would otherwise be empty.
3. Strip trailing zeros from the fractional part. If the fractional part
   becomes empty, drop the decimal point entirely (no trailing `.`).
4. If the resulting numeric value is arithmetically zero (regardless of
   the source's original sign), the canonical form is the bare string
   `"0"` — **never** `"-0"` or `"-0.0"`. Negative zero has no canonical
   representation other than unsigned zero.
5. Otherwise, keep the sign exactly as reported (a leading `-` only for
   a genuinely negative, non-zero value).

**Canonical output grammar** (what a stored `value` MUST match — this is
a validated invariant, not merely descriptive):

```
^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$
```

together with the explicit zero-sign rule from step 4 above (the regex
alone permits the syntax `-0`; the additional rule forbids it as a
stored value — no negative-zero string is ever canonical).

Worked examples:

| Raw source input | Canonical stored value |
|---|---|
| `"0.30"` | `"0.3"` |
| `"4.0"` | `"4"` |
| `"004.10"` | `"4.1"` |
| `"-0.0"` | `"0"` |
| `"0.000"` | `"0"` |

No thousands separators, no `%` sign, no unit suffix, no leading `+`, no
exponential notation at any stage — those are malformed input to reject,
never a "non-canonical form to normalize."

### 6.3 Worked absence examples

- Actual unavailable: `"actual": { "state": "UNKNOWN", "value": null }`.
- No authorized consensus provider exists at all (§9): `"consensus": {
  "state": "UNKNOWN", "value": null }` — the *same* representation as any
  other unknown; this contract does not distinguish "no provider" from
  "provider ran, no value" as two different canonical states (§6.1
  reasoning above; that distinction is a provenance/adapter concern).
- No restatement of any prior period this release: `"prior_periods": []`
  — never a placeholder entry, never an entry defaulted to equal the
  metric's own `actual`.
- A restated period whose prior publicly reported value cannot be
  established: `"prior_value": { "state": "UNKNOWN", "value": null }`
  alongside a `KNOWN` `revised_value` — the revision (§10.2) is then
  simply `null`, not computed against an assumed value.

## 7. Unit model

A frozen, explicit enum — never free text, never inferred from
`metric_code` naming alone.

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

`CURRENCY_AMOUNT` is deliberately **not** in this initial frozen enum —
no first-wave EF target release family requires a currency-denominated
metric value; adding it prematurely without a fully specified
`currency_code` sub-contract would freeze an incomplete shape. If a
future release family needs it, `CURRENCY_AMOUNT` (with a fully
specified `currency_code` field — required iff `unit = CURRENCY_AMOUNT`,
ISO-4217 uppercase 3-letter grammar — added to §5bis's exact-key table at
that time) is added in that same reviewed milestone, never implied in
advance.

**Cross-unit arithmetic is forbidden.** `actual`/`consensus`/every
`prior_periods[]` value on one metric object are only ever compared or
subtracted from each other because they share that metric's single
`unit` (invariant §5.5) — a future consumer must never compare values
across two different metric objects (e.g. `CPI_HEADLINE_MOM` in
`PERCENT_CHANGE_MOM` against `CPI_HEADLINE_YOY` in `PERCENT_CHANGE_YOY`)
without explicit, separately reviewed logic for doing so.

## 8. Reference-period model

**Publication timestamp is not reference period. Knowledge cutoff is not
reference period. `effective_time` is not automatically reference
period.** A CPI report released in September commonly refers to August —
conflating the two would silently misdate every macro release.

`reference_period` (per metric object, and per `prior_periods[]` entry —
§4.5/§4.6) is a discriminated union on `kind`:

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
  ended September 12, 2026") — never derived by the adapter from
  publication timing. For a metric that reports a **multi-week
  aggregate** anchored to a single published date (e.g. a 4-week moving
  average), `WEEK_ENDING` identifies **only that anchor date** — it never
  represents or encodes the full span the aggregate covers (§15 example
  D).
- `DATE`: an exact single calendar date, for releases that reference a
  specific day rather than a period (`YYYY-MM-DD`).

The mapping from a release's publication time to each metric's reference
period is **never derived automatically** by this contract or by any
generic processor logic — it is supplied explicitly and deterministically
by the future source-specific adapter that knows, for that exact metric,
which period a given publication covers. No inference from title text, no
"most recent completed month" heuristic.

### 8.1 Chronological ordering (needed for §4.6.1)

Ordering is defined **only between two periods of the same `kind`**:

- `MONTH`: order by `(year, month)` lexicographically.
- `QUARTER`: order by `(year, quarter)` lexicographically.
- `WEEK_ENDING` / `DATE`: order by the ISO `date` string lexicographically
  (valid because `YYYY-MM-DD` sorts chronologically as plain text).

Comparing periods of two different `kind`s is undefined and never
attempted by this contract — exactly why §4.6.1 requires every
`prior_periods[]` entry to share its metric's own `kind`.

## 9. Consensus / forecast boundary — critical

Official statistical sources (BLS, Federal Reserve, ECB, US Treasury,
etc.) report `actual` — they do **not** supply market consensus.
Consensus is a separate commercial data category (surveyed economist
forecasts), never bundled with an official release.

Rules, unchanged from the task's own framing:

- `actual` (and every `prior_periods[]` value) may be populated by a
  reviewed **official** adapter (Federal Reserve/ECB/US Treasury/OFAC-class
  authority, matching the existing exact-tuple discipline in
  `deterministic_processor.ts` §2).
- `consensus` may be populated **only** when a separately reviewed,
  separately authorized source contract explicitly supplies it, and only
  after that source proves the anti-look-ahead ordering in §9.1.
- Absent such a provider, `consensus` is **always** `{ "state": "UNKNOWN",
  "value": null }` — never inferred, never copied from a prior release,
  never derived from price action, Committee prose, a legacy score, or an
  LLM.
- Adding a paid/new consensus provider is explicitly a **Human Gate** and
  explicitly **out of scope for EF-0** — this document defines the shape
  consensus would occupy if and when that provider exists; it does not
  authorize or imply adding one.

### 9.1 Consensus anti-look-ahead rule — a future evidence-layer boundary, not a CES field (review fix)

Consensus is a **pre-release market-expectation fact** — it describes
what the market expected *before* the official number existed. The
boundary that actually matters is:

```
provider_observed_at  STRICTLY <  authoritative_official_public_release_at
```

i.e. the consensus reading's own observation instant must be strictly
earlier than the instant the official source itself made the release
public. **`knowledge_cutoff` must never be used to define "pre-release."**
`event_versions.knowledge_cutoff` is a separate XAU knowledge/evidence
boundary (§2) that can legitimately fall *after* the official public
release — using it as a proxy for "before the number existed" would
silently admit a consensus reading that was in fact observed after the
market already knew the actual number.

If the authoritative official public-release instant cannot be
established for a given release, `consensus` for every metric in that
release is `UNKNOWN` — never populated on the strength of an assumed or
approximate release time.

Both `provider_observed_at` and `authoritative_official_public_release_at`
are future **non-canonical evidence/provenance** (§11) — properties of
how and when a value was observed, not of the economic fact itself. They
are never fields of `facts`, and this document does not add them to
§5bis's key tables. **No consensus provider is selected in EF-0**; a
future authorized provider contract must independently define how it
establishes both instants and proves the ordering above before any
`consensus` value is ever written to `facts`.

## 10. Surprise / revision — derived, never canonical

**Neither `surprise` nor `revision` is a field in the V2 JSON contract.**
Both are **deterministic, downstream-derived quantities**, computed on
demand from already-canonical fields by any consumer — never persisted,
never a second source of truth that could drift out of sync with
`actual`/`consensus`/`prior_periods`. This is the "simplest design that
cannot become internally inconsistent" the task asked EF-0 to prefer: if
either were also stored, a future bug could persist a value that no
longer matches the facts it was derived from after some other write path
touched one but not the other — impossible if neither is ever stored at
all.

### 10.1 Surprise

```
surprise_raw = actual.value - consensus.value      (same metric, same unit)
```

Defined **only** when both `actual.state = "KNOWN"` and `consensus.state =
"KNOWN"` for the same metric object. If either is `"UNKNOWN"`, surprise is
undefined — a consumer must treat it as `null`, never `0` and never
"neutral." A normalized/scaled surprise magnitude (e.g. in standard-
deviation units of historical surprise) is explicitly **out of scope for
EF-0**.

### 10.2 Revision — computed directly from this release's own `prior_periods[]` (review fix)

For each `prior_periods[]` entry:

```
revision = revised_value.value - prior_value.value
```

Defined **only** when both `prior_value.state = "KNOWN"` and
`revised_value.state = "KNOWN"` for that entry. If either is `"UNKNOWN"`,
revision is undefined — `null`, never `0`, never assumed unchanged.

Because both `prior_value` and `revised_value` are carried **in the same
payload**, the revision **this specific release announces** for an
earlier period is fully computable from that one release's own
`canonical_event_state` — no reconstruction across other Event Versions
is required. This is a direct consequence of §4.6's shape and corrects
the earlier draft's cross-Event-Version design.

This remains a within-metric restatement of an **earlier period**, and
stays a distinct concept from a **later vintage of the same period**
(GDP's Advance/Second/Final staged-release rule, §4.1) — the two must
never be conflated.

Assembling a *complete historical chain* of every revision ever made to
one period, across every release that ever restated it over time (rather
than just the revision the most recent release itself announces), remains
a distinct, more complex concern this document does not design — it
would need the period-identity concept in §12.3 and is left to a future
milestone if a consumer ever requires it.

## 11. Provenance boundary

CES (V1 and V2 alike) represents **canonical factual state** — the same
principle V1 already established (`0012...sql:401`: "jamais une
évaluation de direction/magnitude/confiance/pricing pour l'or") extends
naturally to: *never transient collector metadata either*. Specifically
excluded from `facts`, on purpose:

- fetch timestamp, ingestion timestamp (these belong to `event_versions.
  knowledge_cutoff`/RAW observation metadata, already modeled elsewhere,
  never duplicated into CES);
- `vintage` — the calendar date a `prior_periods[]` restatement became
  known (§4.6) — and any stored `revision` value (§10.2);
- `provider_observed_at` / `authoritative_official_public_release_at` — a
  future consensus provider's own evidence for the anti-look-ahead
  ordering (§9.1);
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
become it. Source lexical numeric precision (§6.2) is exactly this kind
of provenance, not a canonical field.

## 12. Event identity boundary

EF-0 does **not** implement strong identity for macro releases. It does
not derive, compute, or persist any release-identity value. Three
distinct identity concepts are involved, and they must never be
conflated:

### 12.1 Release / event identity — NOT solved by EF-0, deferred to EF-1 (review fix)

**The earlier draft of this document incorrectly concluded that the
existing Event Cluster/Event Version machinery already uniquely solves
release identity. It does not.** As §2 documents, the deterministic Event
processor explicitly never discovers or infers strong identity — it only
*consumes* one when a caller supplies curated `StrongIdentityContext`.
Absent that, **every observation independently plans
`CREATE_NEW_CLUSTER`**. This means that, today, nothing in the pipeline
guarantees that every metric belonging to one official publication (e.g.
every figure in "the August 2026 Employment Situation report") attaches
to a single Event Cluster — without curated strong identity, two
observations of the *same* release could each independently create their
*own* cluster.

**Release / event identity — one official publication instance — is
therefore an open problem, not something this document resolves.** It is
explicitly deferred to **EF-1**, which must define one deterministic
release-level identity using reviewed, source-specific official
release-instance evidence. Possible future evidence includes an official
release identifier, an official schedule-instance key, a source-specific
release instance, or a reviewed tuple that includes the authoritative
official public-release instant (§9.1) — EF-1 chooses and reviews the
actual mechanism; EF-0 does not.

**Explicitly forbidden as a release-identity mechanism, now or in EF-1,**
matching the existing precision-first discipline in
`deterministic_processor.ts` §2:
- fuzzy title/text similarity;
- `metric_code` (§12.2 — that is metric identity, not release identity);
- one metric's `reference_period` alone (§4.5 already shows one release
  can span several different periods across its metrics);
- URL alone;
- generic timing proximity.

**Requirement EF-1 must satisfy:** all metrics belonging to one official
publication MUST attach to **one** release event / Event Cluster — this
document states that requirement; it does not implement it.

### 12.2 Metric / fact identity — within one release

Within one Event Version's `facts.metrics` array, a metric is identified
by `metric_code` alone (§4.4) — already defined, unchanged by this
review pass.

### 12.3 Period identity — across releases, never release identity (new)

For one metric's value for one specific period, a future milestone may
need a cross-release key identifying "this metric's value for this
period, wherever it is mentioned":

```
(authority, release_family, metric_code, reference_period)
```

e.g. `(the BLS-equivalent authority, US_NFP, NFP_PAYROLL_CHANGE, {MONTH,
2026, 7})` identifies "July 2026's NFP payroll change figure," which may
appear as the `actual` in July's own Event Version and again as a
`prior_periods[]` entry's `reference_period` in the August release's
Event Version. This tuple may help a future consumer match a restated
period across releases (§10.2's historical-chain extension). **It must
never be used as Event Cluster / release identity (§12.1)** — a shared
period does not imply a shared publication, and using it as such would
reintroduce exactly the conflation §12.1 now corrects. This document only
names this tuple's shape; it does not implement identity resolution, does
not touch `StrongIdentityContext`, and does not weaken the existing rule
that strong identity is only ever *consumed* when explicitly curated,
never inferred.

### 12.4 EventType — no change

`EventType`'s frozen six-value union is unchanged by this document.

### 12.5 Effective time — no change

`event_versions.effective_time`/`effective_time_precision` remain the
**sole** effective-time fields, unchanged, and per-metric `reference_
period` is never a substitute for them or vice versa: reference period
says *what period the number describes*; effective time (still always
`null` in V1, per §2) says *when the event itself took legal/factual
effect*. The two answer different questions and are never merged.

### 12.6 No competing canonical table

Reaffirmed explicitly per the frozen architecture constraint: this
document proposes zero new tables. `event_versions.canonical_event_state`
remains the **only** canonical factual event truth, versioned by
`canonical_event_state_schema_version`. Any future raw/evidence storage
for source adapters is a distinct, later, non-canonical concern (§11) —
never a second table that could disagree with CES about what the facts
are.

## 13. Event types without quantitative facts — initial activation rule

**Initial activation rule:** CES V2's *initial* activation is limited to
reviewed typed quantitative release families (`STATISTICAL_RELEASE`-
shaped events with an actual adapter). Speeches, sanctions actions, and
qualitative central-bank communication remain CES V1 **unless and until**
a **future, separately reviewed** contract/schema version explicitly
extends typed facts to those event classes. This document does not
authorize that extension and does not schedule it — it simply does not
permanently foreclose it either.

**Why not an explicit empty-facts V2 state for non-quantitative events
right now:** it would force every non-quantitative event through a
schema-version bump and a placeholder `facts` shape for no informational
gain today. Schema version itself already carries this information for
free in the near term: schema version 1 already *means* "no typed facts
here."

## 14. Compatibility with EI V1 / GT V1

No change to either processor. Both already fail closed correctly for
any schema version other than `1` (§2), which is precisely the behavior
this document relies on and preserves:

- The moment a future milestone begins emitting schema version 2 Event
  Versions (**not** in this PR — see §17), EI-3 and GT-3 will continue to
  return `UNAVAILABLE` / `UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA` for
  those rows, exactly as they already do today for any unrecognized
  version — **not** a crash, **not** a silently wrong `INSUFFICIENT_
  EVIDENCE`, and **not** an accidental "it just works" outcome that was
  never reviewed.
- EI V2 and GT V2 support are explicitly **future, separate, coordinated**
  milestones (§17) — this document does not modify either processor's
  source, does not add a schema-version-2 branch to either, and does not
  change `SUPPORTED_CANONICAL_EVENT_STATE_SCHEMA_VERSION` or
  `GOLD_TRANSMISSION_SUPPORTED_EVENT_SCHEMA_VERSION` from `1`.

## 15. Examples

### A) CPI with actual + consensus, per-metric reference period (valid)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 CPI report",
  "detail": null,
  "facts": {
    "release_family": "US_CPI",
    "metrics": [
      {
        "metric_code": "CPI_HEADLINE_MOM",
        "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
        "unit": "PERCENT_CHANGE_MOM",
        "actual": { "state": "KNOWN", "value": "0.3" },
        "consensus": { "state": "KNOWN", "value": "0.2" },
        "prior_periods": []
      }
    ]
  }
}
```
Derived (never stored): `surprise_raw = 0.3 - 0.2 = 0.1`. This release
does not restate any earlier month, so `prior_periods` is empty and no
revision is derivable from this payload.

### B) CPI with actual but NO consensus (valid — the §9 boundary)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 CPI report",
  "detail": null,
  "facts": {
    "release_family": "US_CPI",
    "metrics": [
      {
        "metric_code": "CPI_HEADLINE_MOM",
        "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
        "unit": "PERCENT_CHANGE_MOM",
        "actual": { "state": "KNOWN", "value": "0.3" },
        "consensus": { "state": "UNKNOWN", "value": null },
        "prior_periods": []
      }
    ]
  }
}
```
Missing consensus is `UNKNOWN`, **not** `0` and not "no surprise" — a
consumer computing surprise from this payload must produce `null`, never
`0`.

### C) NFP restating TWO prior months in one release (valid — demonstrates `prior_periods[]`)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 Employment Situation report",
  "detail": null,
  "facts": {
    "release_family": "US_NFP",
    "metrics": [
      {
        "metric_code": "NFP_PAYROLL_CHANGE",
        "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
        "unit": "THOUSANDS_OF_PERSONS",
        "actual": { "state": "KNOWN", "value": "142" },
        "consensus": { "state": "KNOWN", "value": "165" },
        "prior_periods": [
          {
            "reference_period": { "kind": "MONTH", "year": 2026, "month": 7 },
            "prior_value": { "state": "KNOWN", "value": "89" },
            "revised_value": { "state": "KNOWN", "value": "85" }
          },
          {
            "reference_period": { "kind": "MONTH", "year": 2026, "month": 6 },
            "prior_value": { "state": "KNOWN", "value": "118" },
            "revised_value": { "state": "KNOWN", "value": "123" }
          }
        ]
      },
      {
        "metric_code": "UNEMPLOYMENT_RATE",
        "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
        "unit": "LEVEL_PERCENT",
        "actual": { "state": "KNOWN", "value": "4.3" },
        "consensus": { "state": "KNOWN", "value": "4.2" },
        "prior_periods": []
      }
    ]
  }
}
```
This is the exact realistic NFP mechanic §4.6 motivates: the August
report restates **both** July and June payroll figures in the same
publication — two `prior_periods[]` entries, not one. Surprise for
`NFP_PAYROLL_CHANGE` this release: `142 - 165 = -23`. Both revisions are
computed **directly from this single payload** (§10.2) — no other Event
Version is consulted: July's `revision = 85 - 89 = -4`; June's
`revision = 123 - 118 = +5`.

### D) Jobless Claims — metric-specific reference periods (valid)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Department of Labor releases jobless claims report",
  "detail": null,
  "facts": {
    "release_family": "US_JOBLESS_CLAIMS",
    "metrics": [
      {
        "metric_code": "INITIAL_CLAIMS",
        "reference_period": { "kind": "WEEK_ENDING", "date": "2026-09-12" },
        "unit": "THOUSANDS_OF_PERSONS",
        "actual": { "state": "KNOWN", "value": "231" },
        "consensus": { "state": "KNOWN", "value": "235" },
        "prior_periods": [
          {
            "reference_period": { "kind": "WEEK_ENDING", "date": "2026-09-05" },
            "prior_value": { "state": "KNOWN", "value": "229" },
            "revised_value": { "state": "KNOWN", "value": "227" }
          }
        ]
      },
      {
        "metric_code": "CONTINUING_CLAIMS",
        "reference_period": { "kind": "WEEK_ENDING", "date": "2026-09-05" },
        "unit": "THOUSANDS_OF_PERSONS",
        "actual": { "state": "KNOWN", "value": "1926" },
        "consensus": { "state": "UNKNOWN", "value": null },
        "prior_periods": []
      },
      {
        "metric_code": "CLAIMS_4WK_AVERAGE",
        "reference_period": { "kind": "WEEK_ENDING", "date": "2026-09-12" },
        "unit": "THOUSANDS_OF_PERSONS",
        "actual": { "state": "KNOWN", "value": "229.5" },
        "consensus": { "state": "UNKNOWN", "value": null },
        "prior_periods": []
      }
    ]
  }
}
```
`CONTINUING_CLAIMS` genuinely references the week ending **2026-09-05**,
one week behind `INITIAL_CLAIMS`'s and `CLAIMS_4WK_AVERAGE`'s
**2026-09-12**, in the same release — a single shared release-level
period would have been wrong for one of the three metrics.
`CLAIMS_4WK_AVERAGE`'s `reference_period` names only the **anchor date**
the published four-week average is pinned to (§8) — it does not claim to
represent, and this contract never treats it as representing, the full
four-week span the average actually covers. `INITIAL_CLAIMS` also
demonstrates a `prior_periods[]` entry restating the prior week within
the *same* `WEEK_ENDING` kind as its own period: `revision = 227 - 229 =
-2`, computed directly from this payload.

### E) Event where quantitative facts are not applicable — initial activation only (valid — stays V1)

```json
{
  "event_type": "OFFICIAL_SPEECH",
  "subject": "Federal Reserve Governor delivers remarks on the economic outlook",
  "detail": "The speaker discussed current labor market conditions without new data disclosures."
}
```
Schema version **1**, no `facts` key at all — per the §13 initial
activation rule, this is not an error and not something EF-0 changes,
and not a permanent prohibition on future extension (§13).

### F) Malformed / internally inconsistent payload (MUST be rejected)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 CPI report",
  "detail": null,
  "facts": {
    "release_family": "US_CPI",
    "metrics": [
      {
        "metric_code": "CPI_HEADLINE_MOM",
        "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
        "unit": "PERCENT_CHANGE_MOM",
        "actual": { "state": "KNOWN", "value": null },
        "consensus": { "state": "UNKNOWN", "value": "0.2" },
        "prior_periods": []
      },
      {
        "metric_code": "CPI_HEADLINE_MOM",
        "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
        "unit": "PERCENT_CHANGE_YOY",
        "actual": { "state": "KNOWN", "value": "2,9%" },
        "consensus": { "state": "UNKNOWN", "value": null },
        "prior_periods": [
          {
            "reference_period": { "kind": "MONTH", "year": 2026, "month": 9 },
            "prior_value": { "state": "KNOWN", "value": "0.1" },
            "revised_value": { "state": "KNOWN", "value": "0.15" }
          }
        ]
      }
    ]
  }
}
```
Rejected for **four independent** reasons, each alone sufficient:
1. `actual.state = "KNOWN"` with `value: null` violates the state/value
   pairing (§6.1/invariant §5.4) — and symmetrically `consensus.state =
   "UNKNOWN"` with a non-null `value: "0.2"` violates the same pairing.
2. `metric_code = "CPI_HEADLINE_MOM"` appears **twice** in the same
   `facts.metrics` array, violating invariant §5.3 — a duplicate
   `metric_code` is never disambiguated by `unit`.
3. `"2,9%"` violates the canonical decimal grammar in §6.2 (comma decimal
   separator and a literal `%` suffix are both forbidden).
4. The second metric's `prior_periods[]` entry references September
   2026, which is **later** than that metric's own `reference_period`
   (August 2026) — violating §4.6.1's "strictly chronologically earlier"
   rule.

### G) Malformed — unknown extra field (MUST be rejected)

```json
{
  "event_type": "STATISTICAL_RELEASE",
  "subject": "US Bureau of Labor Statistics releases August 2026 CPI report",
  "detail": null,
  "facts": {
    "release_family": "US_CPI",
    "collector_run_id": "9f2c1b3a-...",
    "metrics": [
      {
        "metric_code": "CPI_HEADLINE_MOM",
        "reference_period": { "kind": "MONTH", "year": 2026, "month": 8 },
        "unit": "PERCENT_CHANGE_MOM",
        "actual": { "state": "KNOWN", "value": "0.3" },
        "consensus": { "state": "UNKNOWN", "value": null },
        "prior_periods": []
      }
    ]
  }
}
```
Rejected: `facts.collector_run_id` is not in §5bis's exact key list for
`facts` (`release_family`, `metrics` only) — precisely the class of
transient collector metadata §11 forbids inside CES. Unknown keys are
never silently ignored; the payload is malformed.

### H) Canonical-decimal example — non-canonical input MUST be rejected, not silently accepted

The literal string `"0.30"` is **not** a valid stored `value` even though
it is numerically equal to a valid one:

```json
{ "state": "KNOWN", "value": "0.30" }
```

is malformed — it fails the canonical output grammar in §6.2 (trailing
fractional zero). The only valid canonical form for this economic value
is:

```json
{ "state": "KNOWN", "value": "0.3" }
```

An adapter is responsible for canonicalizing (§6.2's algorithm) **before**
emitting a value into `facts` — a consumer of already-persisted CES data
is never required to further normalize a stored `value`, because a
non-canonical stored value is itself a contract violation, not an
expected variant to tolerate.

## 16. Activation prerequisites

Schema version 2 is **not activated** by this document. Before any Event
Version is ever created with `canonical_event_state_schema_version = 2`,
all of the following must independently exist and be independently
reviewed:

1. A reviewed, source-specific adapter contract for at least one
   `release_family` that deterministically maps a specific official
   collector's output into this exact `facts` shape (no generic
   free-text/keyword parsing invented ad hoc), including, where
   applicable, the GDP-style staged-release identity rule (§4.1) and
   correct `prior_periods[]` emission whenever the current release
   explicitly restates at least one prior period for a metric (§4.6),
   whether that means one entry or multiple entries (e.g. NFP).
2. A reviewed decision on which `EventType`s are ever eligible to advance
   past schema version 1 (§13's initial-activation rule, and any future
   extension of it).
3. A reviewed decision on where adapter-level evidence/provenance for a
   typed fact is stored (§11 — explicitly not CES, not designed here),
   including any future-needed `vintage` or release-observation timestamps
   and a future consensus provider's `provider_observed_at`/
   `authoritative_official_public_release_at` evidence (§9.1). `revision`
   remains derived on demand from `prior_value`/`revised_value` and is
   never persisted in CES or in that evidence storage.
4. A reviewed, additive-only migration that extends `canonical_event_
   state_schema_version` handling wherever it is currently gated to
   exactly `1` — including, explicitly, the EI-3 and GT-3 `SUPPORTED_*`
   constants, which must move to `2` **only** in the same coordinated
   milestone that also teaches those processors what a schema-version-2
   payload actually contains, never as an accidental side effect of a
   schema/persistence-only change.
5. **EF-1: a reviewed, deterministic release-level identity mechanism**
   (§12.1) — the single most critical open gap this document identifies.
   Without it, nothing guarantees that every metric belonging to one
   official publication attaches to one Event Cluster, which schema
   version 2 activation must not silently assume is already solved.
6. If/when a consensus provider is added: a separate, explicit Human
   Gate authorization (§9), including that provider's own deterministic
   mechanism for establishing `provider_observed_at` and the
   authoritative official public-release instant, and proving the
   ordering between them (§9.1) — not implied or pre-approved by this
   document.

## 17. Next implementation sequence (proposed, not authorized by this PR)

Mirroring the EI-1..EI-6 / GT-0..GT-6 milestone discipline already used
twice in this program. **Corrected from the earlier draft:** EF-1 is
release-level identity, not the period-identity tuple (§12.3), which is a
different, narrower concept.

- **EF-1**: deterministic **release-level** identity for macro releases
  (§12.1) — the open problem this document explicitly does not solve.
  Pure identity contract, no persistence.
- **EF-2**: one reviewed source adapter for exactly one `release_family`
  (e.g. `US_CPI`) — pure mapping function, RAW input to `facts` output
  including correct `prior_periods[]` emission, no persistence, no
  runtime.
- **EF-3**: the additive migration that allows `canonical_event_state_
  schema_version = 2` to be persisted for that one adapter's output —
  schema-only, no live apply in the same task.
- **Then, downstream coordinated support** (exact milestone numbering to
  be assigned when EF-3 completes, not fixed in advance): EI-3/GT-3
  updated, in the same coordinated milestone, to actually consume
  schema-version-2 `facts` for the one supported `release_family` — still
  conservative/fail-closed for every metric this contract doesn't yet
  cover — followed by additional `release_family` adapters, each
  independently reviewed, each additive.
- Consensus-provider activation (§9/§9.1) is its own, separately gated
  track, not a numbered EF milestone by default.

Do not silently activate CES V2. Each step above is independently
reviewed before the next begins.

---

No code, migration, table, runtime, source adapter, Worker route, or
Supabase call is introduced by this document. `canonical_event_state_
schema_version` remains `1` everywhere in the live system after this PR
merges.
