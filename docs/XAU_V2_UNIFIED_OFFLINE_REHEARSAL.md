# XAU V2 — Rehearsal of one canonical offline decision chain (2026-10-14)

**Status: draft integration experiment, NOT mergeable / NOT deployable / NOT production evidence.**

## Architecture decision scoped to this experiment

- **One and only one decision engine:** `backend/decision_chain/dry_run.ts` from TV-2 #126, which already calls the 12 V2 stages at a caller-supplied cutoff. Its `evaluateDecisionChain`, `verifyDecisionChainIntegrity`, and `computeDecisionChainDigest` are reused, not copied.
- **OBS-0 v2:** `backend/observability/offline_receipt.ts` is an explicit, schema-versioned adapter for that 12-stage result. The older 10-stage OBS-0 API is incompatible and **has not been copied**. The adapter checks exact stage/trace identity, strict calendar cutoff, positive-value suppression, forged runtime/approval claims, and hashes only a fully valid hold result.
- **EVIDENCE-0:** `backend/observability/evidence_manifest.ts` from #121; even a coherent batch remains `UNVERIFIED` and `authorization=NONE`. Future published/ingested values reject the claim batch.
- **TIME-0:** `backend/shared/temporal_contract.ts` from #121 validates strict Gregorian instants and exact nanoseconds. The existing `shared/strict_timestamp.ts` remains untouched so we do not silently change the TV-2/market contracts; the integration boundary requires strict TIME-0 validation as well. A later API unification requires separate contract review.
- **UI-0 + TR-0:** pure offline views and canonical transport from #121; `UNVERIFIED / NOT_CONNECTED / HOLD / ABSTAIN / FORBIDDEN`. Structural validity of JSON does not authenticate sources.
- **TV-2:** unchanged from #126 except for its previously CI-verified removal of fictional directional demo news.

`backend/observability/unified_rehearsal.ts` composes existing modules **only as an offline integration test harness**. It calls `evaluateDecisionChain` once; on invalid chain or OBS-0 rejection it withholds chain claims from UI-0. It has no live clock, provider, API endpoint, database, job scheduler, broker, order creator or alert channel. The display still receives a simulation, never authenticated market data.

## Exact source selections

- Base: TV-2 #126 at `535b091aaee7b1e60e5e7cca6681cc0397e5fd5c` (inherited from #123→#124→#125).
- Reviewed additive TS modules: composite #121 at `57956f870103f3cf8baedc0de8ce46a5a6bda161` (TIME/EVIDENCE/UI/TR only).
- Architecture guards: #121, expanded **only** for the actual canonical TV-2 dependency closure, including `market_engine/validate.ts` and `shared/strict_timestamp.ts`.
- OBS and integration harness: new v2 adapters. Not a verbatim merge of OBS0 #110/#118; the negative-only anti-spoof conditions have been forward-ported and extended to the 12-stage structure. Do not remove older reviewed anti-spoof tests from their own source PRs.

## Independent gates to verify on the exact source tree

1. `npm run typecheck` (no schema drift or duplicate symbol).
2. `npm test` (existing TV-2 tests plus TIME-0, EVIDENCE-0, UI-0, TR-0 and new 12-stage anti-spoof integrated tests).
3. ARCH-1 legacy Worker/cron non-reachability, ARCH-2 no runtime side effects, ARCH-3 transitive pure-import closure.
4. GitHub Quality Gate's ephemeral PostgreSQL jobs; **these never contact Supabase production**.
5. Regression cases: order, fake deploy ID, approved acceptance, provider invocation, alert payload, bullish horizon, invalid civil date, nanosecond cutoff drift, future evidence, replay determinism, fictional news.
6. Browser cross-compatibility, authentic official-source vintage, external providers, REC-1 isolated restore and production staging remain **UNPROVEN**.

## Integration after a separate human gate

This integration PR is a **test harness, not an authorized merge candidate**. The source PRs #106–#122 and #123–#126 still need individual delta review and de-duplication. No cherry-pick of the obsolete ten-stage implementation over the selected canonical file. Any permanent choice of schema, receipt v2 semantics, temporal precision or rendering semantics requires its own review and approval.

**DO NOT MERGE, DEPLOY, APPLY MIGRATIONS, CHANGE `main`, EXECUTE REC-1, ACTIVATE PROVIDERS, SEND ALERTS OR TRADE.**

## Central version registry for this combined, unmerged experiment

These are explicitly **separate** schema identities. Each exact version string
belongs to only one module and does not imply runtime approval.

| Module | Schema version | Algorithm version |
| --- | --- | --- |
| TIME-0 | `xau.temporal-instant.v1` | `strict-gregorian-nanoseconds-1.0.0` |
| EVIDENCE-0 | `xau.evidence-manifest.v1` | `evidence-structural-cutoff-gate-1.0.0` |
| OBS-0 v2 | `xau.offline-audit-receipt.v2` | `canonical-chain-hold-receipt-2.0.0` |
| UI-0 | `xau.institutional-advisory-ui.v1` | `institutional-offline-hold-projection-1.0.0` |
| TR-0 | `xau.offline-advisory-transport.v1` | `offline-canonical-readonly-transport-1.0.0` |
| Combined harness | `xau.unified-offline-rehearsal.v2` | `unified-readonly-cross-contract-1.2.0` |

The old CHAIN-0 `runDecisionChainDryRun(input)` ten-stage shape and OBS-0
`xau.offline-audit-receipt.v1` are not accepted by these v2 adapters.

## ARCH-4 — untrusted caller-envelope boundary (draft additive hardening)

The offline integration harness accepts **untrusted runtime values**, not just a
TypeScript interface. Its entry boundary rejects unknown top-level keys,
non-plain objects, accessors, missing metadata, non-local origin enums, unsafe
display labels, malformed RFC3339 generation/cutoff claims, and any generation
instant earlier than the claimed knowledge cutoff. Evidence arrays are bounded
to 512 claims for this purely local rehearsal. Rejection projects the existing
canonical CHAIN-0 `REJECTED / HOLD / FORBIDDEN` state without running any stage,
minting a receipt, or forwarding caller origin/clock labels. This is not source
authentication: valid origin and time fields remain **caller-supplied claims**.

The structural output schema is unchanged (`v1`); the tightened input validation
is tracked as algorithm `1.1.0`. Run
`tests/test_unified_input_boundary.mjs` for negative and replay regressions.
No live providers, real market sources, migration, merge or production authority.

## ARCH-5 — single admitted receipt for terminal fingerprint (draft)

A structurally **rejected** OBS-0 receipt previously left an alternative
terminal digest path: `computeDecisionChainDigest` was called directly when
CHAIN-0 had completed, even though OBS-0 rejected the chain's safety claims.
That defeated the intended invariant that the terminal fingerprint derives
**only from an accepted OBS-0 offline receipt**.

The integration harness now sets its terminal fingerprint using only
`fingerprintFromAcceptedReceipt(receipt)`; it is `null` whenever the receipt
is rejected, missing, tampered, or malformed. CHAIN-0 remains the only decision
orchestrator. No alternate hash computation is permitted downstream of the
receipt. UI-0/TR-0 chain claims are withheld by the same gate. A SHA-256
fingerprint is not a source attestation, signature, authority to deploy or
approval to trade. Algorithm version advances to `1.2.0` (schema unchanged).

`tests/test_unified_receipt_gate.mjs` covers acceptance, tampering,
receipt rejection, malformed hashes and deterministic integration replay.
This is a negative-only integrity fix, not a positive trading capability.

## ARCH-6 — versioned integration output boundary (draft breaking contract)

The combined harness now emits both `schemaVersion` and `algorithmVersion`
in **every** completed or rejected output. Previous drafts exported the
algorithm constant but omitted it from the serialized result, preventing an
offline replay consumer from identifying the exact validation algorithm.

This adds a top-level output key, therefore the result schema is explicitly
**bumped from `xau.unified-offline-rehearsal.v1` to
`xau.unified-offline-rehearsal.v2`**, rather than silently changing the
meaning of v1. The algorithm remains
`unified-readonly-cross-contract-1.2.0`; these are separate identities.
Existing test fixtures now assert both values and their stability across
rejected inputs. The underlying CHAIN-0, OBS-0, EVIDENCE-0, UI-0 and TR-0
contracts are not rewritten or promoted to runtime.

**Human review required before any schema adoption.** This is an unmerged
offline-only experiment with no live consumer, production endpoint, broker
connection, DB operation, migration or trading authority.
