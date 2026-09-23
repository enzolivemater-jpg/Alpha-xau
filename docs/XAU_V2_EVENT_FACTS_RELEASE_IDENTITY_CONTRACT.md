# XAU V2 — Event Facts EF-1 / Official Release Identity Contract

Status: `CONTRACT_DRAFT — EF-1, NOT ACTIVATED`
Milestone: EF-1 (pure identity contract only)
Baseline verified against: `1d712a79984fac68587c8c44385c61ac7abffd90`

This document defines how a future source-specific adapter may prove that
one or more official observations belong to the **same official release
instance**. It adds no code, migration, table, source, route, database call,
deployment, or live behavior. It does not activate Canonical Event State
V2 (CES V2).

## 1. Purpose

The current Event processor never discovers strong identity. It only
consumes a caller-supplied `StrongIdentityContext`; absent that curated
context, each observation independently plans `CREATE_NEW_CLUSTER`.

EF-1 closes the architectural definition gap, not the runtime gap. It
defines the exact evidence and canonicalization rules a later adapter and
orchestrator must satisfy before multiple observations from one official
publication may share an Event Cluster.

The invariant is:

> One official publication instance has one release identity, regardless
> of how many metrics, reference periods, pages, files, observations, or
> Event Versions describe it.

## 2. Identity boundaries

Three identities remain separate:

1. **Release / event identity** — one official publication instance.
   This is the only identity EF-1 defines and the only one eligible to
   become Event Cluster strong identity.
2. **Metric identity** — `metric_code` within one CES V2 `facts.metrics`
   array. It never identifies an Event Cluster.
3. **Period identity** — a metric value for a reference period, such as
   `(authority, release_family, metric_code, reference_period)`. It may
   support revision matching, but never identifies a publication.

CES remains factual content. Release identity is non-CES routing evidence
used to associate observations with the correct Event Cluster. It must not
be copied into `canonical_event_state` merely to make clustering easier.

## 3. Definitions

### 3.1 Official release instance

An official release instance is one publication act by one verified
authority for one release family and, when the authority publishes staged
estimates, one release stage.

Examples:

- the August 2026 US CPI publication is one instance even though it
  contains headline/core and monthly/annual metrics;
- one Employment Situation publication is one instance even though it
  contains payrolls, unemployment, earnings, and revisions to earlier
  months;
- one weekly claims publication is one instance even though its metrics
  refer to different week-ending dates;
- GDP Advance and GDP Second for the same quarter are different release
  instances;
- a correction that explicitly corrects the same official publication
  keeps the same release identity and produces a new Event Version;
- the next scheduled publication in the same family receives a different
  release identity.

### 3.2 Authoritative evidence

Authoritative release-instance evidence is structured evidence supplied by
the verified official source or its reviewed official schedule. It must be
available before identity resolution and must be preserved outside CES for
audit.

It is not:

- a title interpretation;
- a URL by itself;
- publication-time proximity;
- a metric code or metric reference period;
- an article identifier from an aggregator;
- a similarity score or LLM conclusion.

## 4. Allowed evidence strategies

Every source-specific adapter must select exactly one reviewed strategy
version. There is no generic fallback between strategies.

### 4.1 `OFFICIAL_RELEASE_ID`

Preferred when the authority exposes a stable identifier that uniquely
names one publication instance within the stated authority, family, and
stage.

Required components:

- verified `authority`;
- reviewed `release_family`;
- reviewed `release_stage` (`SINGLE` when the family has no stages);
- exact official `release_id`;
- `strategy_version`.

The source contract must prove the identifier's scope and stability. A
page URL, file URL, slug, or feed item GUID is not automatically an
official release identifier.

### 4.2 `OFFICIAL_SCHEDULE_INSTANCE`

Allowed when the authority exposes a stable schedule/calendar instance
key that deterministically names the publication and the adapter proves
the released material maps to that exact schedule instance.

Required components:

- verified `authority`;
- reviewed `release_family`;
- reviewed `release_stage`;
- exact official `schedule_instance_id`;
- `strategy_version`.

A generic calendar date, expected month, or nearest scheduled time is not
a schedule-instance key.

### 4.3 `OFFICIAL_RELEASE_TUPLE`

Allowed only when a source-specific contract proves that the authority
does not expose a stable release or schedule identifier and that the
following exact tuple uniquely names a release instance for that source:

- verified `authority`;
- reviewed `release_family`;
- reviewed `release_stage`;
- authoritative official public-release instant;
- any additional source-specific discriminator required for uniqueness;
- `strategy_version`.

The public-release instant must come from authoritative official evidence,
not the collector's fetch time, `observed_at`, `ingested_at`, an Event
Version `knowledge_cutoff`, or a time inferred from an article title.

This strategy is not a universal fallback. It is enabled per source only
after the source contract demonstrates uniqueness, correction behavior,
timezone semantics, and schedule exceptions.

## 5. Exact source-contract requirements

Before a strategy can be activated for one source/family, its contract
must define all of the following:

1. exact verified source tuple and authority;
2. supported `release_family` values;
3. stage vocabulary and how `SINGLE` versus staged releases are decided;
4. chosen evidence strategy and strategy version;
5. exact source fields used and their authoritative meaning;
6. normalization rules for every identity component;
7. proof of uniqueness scope;
8. behavior for corrections, reissues, delayed publications, and
   rescheduled releases;
9. behavior when evidence is missing, malformed, duplicated, or
   contradictory;
10. audit evidence retained outside CES;
11. test fixtures derived from real official source shapes;
12. rollback/disable behavior that fails closed without rewriting prior
    Event history.

No source inherits another source's strategy merely because its pages look
similar.

## 6. Canonical release identity output

A successful future **pure resolver** produces a release identity proposal
with exactly these three fields:

```json
{
  "authorityNamespace": "xau_v2:official_release:<authority>:v1",
  "identityType": "<reviewed_strategy>:<strategy_version>",
  "identityValue": "<canonical_release_identity_json>"
}
```

This proposal is **not yet** a `StrongIdentityContext`. A later
orchestrator performs an exact active-claim lookup for the resulting
strong-identity key and only then constructs the existing Event processor
input:

```json
{
  "kind": "CURATED_STRONG_IDENTITY",
  "authorityNamespace": "<proposal.authorityNamespace>",
  "identityType": "<proposal.identityType>",
  "identityValue": "<proposal.identityValue>",
  "candidateClusterIds": ["<exact active claim cluster id, when one exists>"]
}
```

The pure resolver never emits, defaults, or guesses `candidateClusterIds`.
In particular, the orchestrator must not substitute an empty array when
the lookup was skipped, failed, timed out, or returned a malformed result.
Doing so could incorrectly plan `CREATE_NEW_CLUSTER` for an identity that
already exists.

### 6.1 `authorityNamespace`

Exact grammar:

```text
xau_v2:official_release:<authority>:v1
```

`<authority>` is the reviewed lowercase ASCII authority code from the
source contract. It is not a free-form provider name.

### 6.2 `identityType`

Exact grammar:

```text
official_release_id:<strategy_version>
official_schedule_instance:<strategy_version>
official_release_tuple:<strategy_version>
```

Strategy versions are lowercase ASCII identifiers defined by the
source-specific contract. Changing identity semantics requires a new
strategy version; it must never silently reinterpret an old value.

### 6.3 `identityValue`

`identityValue` is a canonical JSON string, not an object and not an
opaque title hash. It contains exactly the components approved by the
source contract plus:

- `authority`;
- `release_family`;
- `release_stage`;
- `strategy`;
- `strategy_version`.

Canonicalization rules:

- UTF-8 JSON;
- object keys sorted lexicographically at every level;
- no insignificant whitespace;
- strings only; no JSON numbers, booleans, or nulls;
- every value must already satisfy its source-specific canonical grammar;
- no Unicode compatibility folding, case folding, trimming, timestamp
  conversion, URL normalization, or other silent repair at this layer;
- no extra keys;
- arrays are forbidden in V1 identity values;
- serialization is byte-deterministic.

Illustrative shape for `OFFICIAL_RELEASE_ID` (not an activated source):

```json
{"authority":"example_authority","release_family":"US_CPI","release_id":"example-stable-id","release_stage":"SINGLE","strategy":"OFFICIAL_RELEASE_ID","strategy_version":"v1"}
```

The existing database identity claim machinery hashes
`authorityNamespace`, `identityType`, and this exact string. Therefore
byte-level canonical stability is required before any database lookup or
claim assertion.

### 6.4 Existing strong-identity key compatibility

The later orchestrator uses the already-deployed identity-claim formula,
unchanged:

```text
lowercase_hex_sha256(
  authorityNamespace || U+001F || identityType || U+001F || identityValue
)
```

`U+001F` is the existing unit-separator byte used by the database
contract. Namespace and type grammars are ASCII and cannot contain it;
the canonical JSON serializer escapes control characters inside JSON
strings, so `identityValue` cannot inject a literal separator byte. No
caller trims, case-folds, reparses, or otherwise normalizes any of the
three fields after the pure resolver emits them.

## 7. Resolver result states

A future pure resolver returns one of these explicit states:

### 7.1 `RESOLVED`

All required evidence is valid and one canonical identity was produced.

### 7.2 `UNAVAILABLE`

Required authoritative evidence is absent. No identity claim is proposed.
For a CES V2-capable typed release, processing fails closed; it must not
fall back to title, URL, metric, period, or proximity identity.

### 7.3 `MALFORMED`

Evidence exists but violates the source contract. No identity claim is
proposed.

### 7.4 `CONFLICT`

Two authoritative evidence elements that should describe the same
release resolve to different identities, or one evidence element maps to
more than one release instance. No identity claim is proposed and the
conflict is surfaced for review.

### 7.5 `UNSUPPORTED`

The verified source/family/stage has no activated EF-1 strategy. No
identity claim is proposed.

No non-`RESOLVED` state may be converted to `kind: NONE` and then treated
as safe CES V2 processing. `NONE` remains valid for legacy V1 event flow,
but CES V2 activation requires a resolved release identity.

## 8. Grouping and version semantics

### 8.0 Exact active-claim lookup

After a `RESOLVED` proposal, the later orchestrator derives the exact
strong-identity key using the existing database formula and reads active
claims only:

- 0 active claims -> `candidateClusterIds: []`; the Event processor may
  plan a new cluster plus the exact identity claim proposal;
- 1 active claim -> `candidateClusterIds: [cluster_id]`; the Event
  processor may assign the observation to that exact cluster;
- more than 1 active claim -> explicit invariant/corruption failure;
- lookup unavailable, malformed, or ambiguous -> fail closed; never
  substitute 0 candidates.

Lookup is exact by strong-identity key. It never scans titles, URLs,
metrics, periods, timestamps, or neighboring clusters.

### 8.1 Same identity

The following may share the same release identity when official evidence
proves they are parts or representations of the same publication:

- multiple metrics in one release;
- multiple official files or pages for one release;
- duplicate observations of one release;
- an explicit correction or restatement of the same release instance;
- later evidence that changes canonical facts for that same instance.

They attach to one Event Cluster. Material factual changes create new
append-only Event Versions; they do not create a new release identity.

### 8.2 Different identity

The following require different release identities:

- consecutive scheduled publications of the same family;
- GDP Advance versus GDP Second/Final for the same quarter;
- separately published releases that happen at the same timestamp;
- two authorities publishing similarly named material;
- a new official publication that discusses or republishes an older
  release without being its explicit correction.

### 8.3 Collision

If one resolved identity already has active claims on different Event
Clusters, the existing persistence contract treats that as an explicit
inter-cluster collision. EF-1 never chooses a winner, merges clusters,
moves evidence, or rewrites history.

## 9. Time boundaries

Release identity may use an authoritative official public-release instant
only under a reviewed `OFFICIAL_RELEASE_TUPLE` strategy.

It must never substitute:

- `provider_observed_at`;
- collector `observed_at`;
- `ingested_at`;
- Event Version `knowledge_cutoff`;
- `effective_time`;
- metric `reference_period`.

These times answer different questions. A resolver must preserve their
separation and must be replayable from evidence available at the relevant
knowledge cutoff.

## 10. Forbidden mechanisms

The following are forbidden as strong release identity, alone or in
combination as an unreviewed heuristic:

- fuzzy title, summary, or body similarity;
- keyword matching or semantic embeddings;
- LLM classification;
- URL alone, canonical URL alone, or URL path alone;
- provider item id unless the source contract proves it is the official
  release-instance identifier;
- generic date or timestamp proximity;
- nearest-calendar-event matching;
- `metric_code`;
- any metric's `reference_period`;
- `release_family` alone;
- article count, provider count, source count, or editorial lineage;
- legacy `news_score`, expected move, Gold direction, market reaction,
  price data, or future information.

Eligibility evidence and release identity remain separate. A URL path may
prove that an item belongs to an eligible source category without proving
which release instance it represents.

## 11. Determinism and replay invariants

For identical reviewed evidence and strategy version:

- resolver output is deep-equal;
- `authorityNamespace`, `identityType`, and `identityValue` are
  byte-identical;
- database strong-identity key is identical;
- array/file/metric order cannot affect identity;
- application clock, environment, network, database state, LLM output,
  market data, and legacy scores cannot affect identity;
- retries cannot create a different claim intention;
- historical replay uses the strategy version that was active for that
  evidence, never silently the latest strategy.

## 12. Security and provenance

- Only exact verified official source tuples may enter an activated
  resolver.
- Identity fields must never contain credentials, auth headers, query
  secrets, or private tokens.
- Raw authoritative evidence is retained outside CES with source,
  observation time, ingestion time, and applicable publication evidence.
- CES contains economic facts, not identity transport metadata.
- Identity claims remain service-role-only under the existing database
  contract; EF-1 changes no grants or RLS.
- Unknown or malformed evidence fails closed and is observable.

## 13. Compatibility

EF-1 does not change:

- `StrongIdentityContext` or `StrongIdentityClaimProposal` shapes;
- existing Event Cluster, identity-claim, membership, or Event Version
  tables and RPCs;
- CES V1 or CES V2 factual shapes;
- Event Impact or Gold Transmission;
- existing V1 observations and clusters;
- source collectors;
- runtime routes, cron, deployment, or secrets.

The future EF-2 adapter must map reviewed official source evidence into
this contract. A later runtime milestone must perform §8.0's exact
active-claim lookup and only then construct the existing
`StrongIdentityContext` passed to the Event processor.

## 14. Required source-specific tests

Every activated strategy must prove at least:

1. same release, multiple metrics -> same identity;
2. same release, different metric reference periods -> same identity;
3. same release represented by multiple official artifacts -> same
   identity when the source contract explicitly maps them together;
4. duplicate observation -> byte-identical identity;
5. correction of the same release -> same identity;
6. consecutive release -> different identity;
7. staged release -> different identity per stage;
8. same timestamp, different family -> different identity;
9. missing evidence -> `UNAVAILABLE`;
10. malformed evidence -> `MALFORMED`;
11. contradictory evidence -> `CONFLICT`;
12. unsupported family/stage -> `UNSUPPORTED`;
13. URL/title/metric/period/proximity-only evidence -> never `RESOLVED`;
14. canonical JSON order and byte stability;
15. no use of clock, database, network, environment, LLM, market data, or
    legacy scoring;
16. existing strong-identity-key formula receives the exact canonical
    three-part input without silent normalization.

## 15. Activation prerequisites

No release identity strategy is activated by this document. Activation
for one source/family requires:

1. source-specific contract satisfying §5;
2. real official fixtures proving the chosen evidence semantics;
3. pure deterministic resolver and tests satisfying §§6-14;
4. reviewed non-canonical evidence/provenance storage or an already
   reviewed existing location that preserves the required evidence;
5. exact active-claim lookup with 0/1/>1 behavior;
6. orchestrator integration using the existing curated
   `StrongIdentityContext` boundary;
7. additive, backward-compatible rollout and explicit disable path;
8. coordinated CES V2 activation only after its producer and downstream
   consumers are ready.

## 16. Next milestone

EF-2 must select exactly one high-value quantitative official release
family and one official structured source, then define and implement:

- its exact release-instance evidence strategy under EF-1;
- a pure mapping from that source's reviewed structured payload to the
  EF-0 CES V2 `facts` shape;
- deterministic fixtures and fail-closed behavior;
- no persistence, runtime, consensus provider, or CES V2 activation.

Choosing or paying for a consensus provider remains a Human Gate and is
not part of EF-2.

---

EF-1 is architecture only. No production behavior changes until a future,
separately reviewed source-specific milestone implements and activates one
strategy.
