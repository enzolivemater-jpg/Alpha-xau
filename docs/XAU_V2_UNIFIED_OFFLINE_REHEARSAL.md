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
