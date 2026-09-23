# XAU V2 — Gold Transmission GT-0 architecture closure

Status: `CLOSED_FOR_GT-1_SCHEMA`  
Decision date: 2026-09-23  
Baseline: `ffc15c0a4e2be5639fa95617c91d2a2b6e41897d`

This decision closes the prerequisite boundary for the first Gold
Transmission implementation. It does not claim that Gold Transmission is
implemented or live-proven.

## 1. Selected V1 model

Gold Transmission V1 is **Model S: semantic / ex-ante**.

It may use only facts and market-driver observations that were available at
the assessment `knowledge_cutoff`. It must emit the explicit causal chain:

`EVENT -> TRANSMISSION CHANNEL -> MARKET VARIABLE -> GOLD EFFECT`

An unknown link remains `UNKNOWN` or causes `INSUFFICIENT_EVIDENCE`; it is
never filled from a keyword score, Committee prose, a future market reaction,
or an LLM guess.

**Model R: observed reaction** is a later, separate model. Model R must not be
mixed into V1 because it requires a defined reaction window, a defensible
event effective time, and as-of market observations.

## 2. GT-0A — market-driver provenance

The canonical market-driver source is the append-only dedicated-row contract
introduced by migration `0025_market_driver_native_rows.sql` for `US10Y`,
`US10YR`, `VIX`, and `WTI`.

Each driver observation owns its symbol, value, source, observation time, and
ingestion time. XAUUSD-stamped macro fields may remain a compatibility
projection/cache, but they are not authoritative Gold Transmission evidence.

The database contract is merged and live-applied. Runtime collection still
requires deployment and live proof; therefore GT-1 may implement schema and
pure fail-closed contracts, but no production Gold Transmission assessment may
claim native driver evidence until that deploy proof exists.

## 3. GT-0B — Canonical Event State evolution

There remains exactly one factual event truth:
`event_versions.canonical_event_state`, versioned by
`canonical_event_state_schema_version`.

Canonical Event State V2 will extend that contract; it will not create a
second event-facts table or competing canonical representation.

The current RAW contract (`news_articles`) supplies provenance, title,
summary/content, provider category, and publication metadata. It does **not**
supply typed `actual`, `forecast`, `previous`, `revision`, `surprise`, `unit`,
or event-specific numeric attributes. Consequently:

- V1 remains valid and immutable for existing Event Versions;
- V2 is not fabricated from free-text keyword or numeric scraping;
- V2 activates only after a reviewed upstream adapter supplies typed factual
  measurements with explicit source semantics;
- absence of typed facts yields `UNKNOWN` / `INSUFFICIENT_EVIDENCE`, never a
  zero, neutral value, inferred surprise, or copied legacy score.

This does not block the GT-1 persistence schema or a pure processor that can
abstain. It does block positive directional rules that require unavailable
typed facts.

## 4. GT-0C — effective time

`event_versions.effective_time` and `effective_time_precision` remain the only
effective-time fields. Publication, observation, and ingestion timestamps are
not substitutes for when the underlying event became effective.

For Model S V1, `effective_time = NULL` is an accepted explicit unknown and is
not a blocker. Source-specific deterministic effective-time extraction is
added only when an upstream contract exposes it without inference.

Model R remains blocked until effective-time and reaction-window semantics are
separately specified and tested.

## 5. GT-1 entry constraints

GT-1 may now define additive, append-only persistence for semantic Gold
Transmission assessments and causal paths, subject to all of the following:

- immutable linkage to one Event Version;
- explicit `knowledge_cutoff` and algorithm version;
- idempotent persistence and exact replay behavior;
- named transmission channel and market variable for every persisted path;
- no pricing, positioning, magnitude, Committee, or final trading decision;
- no H6 and no silent cross-horizon consensus;
- explicit abstention when a causal direction cannot be supported;
- native driver evidence cannot be claimed before GT-0A runtime live proof.

The next safe milestone is **GT-1 — Gold Transmission schema**. Runtime wiring
and positive live assessment remain downstream of the blocked GT-0A deploy.
