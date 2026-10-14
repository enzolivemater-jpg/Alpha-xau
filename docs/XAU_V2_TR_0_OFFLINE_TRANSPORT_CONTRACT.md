# XAU V2 — TR-0 offline institutional advisory transport

**Status: proposed contract / synthetic-only / not connected. Do not merge or deploy.**

## Scope and ownership

\`backend/advisory_ui/transport_contract.ts\` is a pure adapter **downstream of UI-0** (PR #116). It defines an exact, versioned, canonical JSON envelope to carry an advisory-only UI view from an offline test. The adapter has no HTTP handler, endpoint, Worker/cron import, browser binding, database access, operator session, authentication provider, subscription, broker, external provider or alert-sending primitive.

A packet's transport status \`NOT_CONNECTED\` cannot be upgraded through a caller-supplied field. Its \`origin=UNVERIFIED\` and \`actionability=NONE\` apply **even to structurally valid packets**. This design does not claim live market data, as-of replay admissibility, a signed receipt, an approved method, or any production-readiness evidence. It has no "live" mode.

## Contract

Writer: \`encodeOfflineAdvisoryPacket(claims: unknown, cutoff: unknown): string\`.

- Calls the real UI-0 builder, never passes through upstream unknown fields.
- Emits the fixed literal protocol \`xau.offline-advisory-transport.v1\` with algorithm identity, JSON media type, no connected transport and no action authority.
- Carries the current UI-0 \`HOLD / ABSTAIN / FORBIDDEN\` view, five unavailable H1–H5 placeholders, null recommendation, ticket, sizing and payload, and a visibly **claimed**, not authenticated, cutoff.
- Is deterministic for equivalent inputs and introduces neither a clock nor generated IDs.

Reader: \`inspectOfflineAdvisoryPacket(raw: unknown)\`.

- Bounded by 16,384 UTF-8 bytes, rejects malformed JSON, noncanonical representations, duplicate properties and unknown/misordered fields.
- Rejects unknown schema/algorithm, forged authority, live-source flags, tampered advisory constants, injected order, altered horizon and unapproved positive states.
- Returns \`REJECTED\` with a bounded reason and no packet, or \`STRUCTURALLY_VALID_UNVERIFIED\` with a packet that **still** has no authority.
- A structurally valid *forged* JSON packet can pass the reader; this cannot and does not authenticate a source. Downstream systems MUST NOT upgrade it to live evidence, trigger a notification or execute a trade.

This strict canonical wire format is an offline protocol invariant; it is **not** an authenticated or signed protocol. JSON key order is explicitly defined for reproducibility and is therefore intentionally strict. Any future protocol revision requires a new schema version, tests and independent review.

## Dependency and governance gates

\`TR-0 → UI-0 → CC-0 / AL-0 / E2E-0\`. No dependency on CHAIN-0 runtime, OBS-0 storage or legacy Committee. The current CLI and historical browser surface remain untouched.

Tests: \`tests/test_advisory_transport_contract.mjs\` constructs the upstream gates with their actual functions, validates deterministic canonical replay, overlong payload refusal, field-order restrictions, simulated corruption and forged order/alert/production status. Register it in the deterministic CI runner.

**No merge, migration, production access, source ingestion, REC-1 resume, HTTP wiring, deployment, provider activation, broker connection or live trade.** A later separately approved browser/HTTP adapter would need a verified provenance chain, security model, CORS/cache handling and a new acceptance gate. This PR does not provide those capabilities.

Integration order: independently review #116 (UI-0) before TR-0. Composite offline test of CHAIN-0/OBS-0/UI-0/TR-0 is allowed in an isolated draft branch only and does not replace source PR reviews.
