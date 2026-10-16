# XAU V2 — night handoff (offline RC remediation)

Branch `worktree-pr-149`, base `e1e70225a0e178bf2cbafcf19e1804200e818439`
(RC-0 PR #149, verified ancestor of HEAD). Nothing pushed, merged or deployed;
`main` untouched; no migration, secret, provider call, broker or order.

**Nothing here proves production readiness.** Green local tests show the
offline contracts behave as written; every human gate in
`XAU_V2_2026_10_30_WHOLE_SYSTEM_RC_PLAN.md` stays open.

## Baseline (before any change)

- `npm run typecheck`: clean.
- `npm test`: 115/115 test files passed at `e1e70225`.

## Commits (local only, never pushed), oldest first

| Change | Commit |
|---|---|
| 1 terminal Host guard | `f3e98ae` |
| 2 timestamp parity | `c96d34e` |
| 3 + 5 capture lock/fsync, `--out` guard | `7641c9a` |
| 4 RC-0 scenario parity test | `031c928` |
| handoff v1 | `3ec3d22` |
| 6 OBS-0 refuses an unhashable chain, CHAIN-0 mutation sweep | `0f3dadb` |
| 7 DATA-1 replay non-string cutoff/pin, archive mutation sweep | `c07f20b` |
| 8 DATA-4 audit echo, shared mutation helper, DATA-4 sweep | `d6fe8fc` |
| 9 BLS employment adapter `TypeError`, adapters sweep | `b86637b` |
| 10 EI/GT processors sweep | `57362a3` |
| 11 decision gates forged-upstream sweep | `d4c0844` |

## Changes

| # | Domain | Defect (demonstrated) | Fix | Main files |
|---|---|---|---|---|
| 1 | Terminal / security | Loopback server served any `Host`: a rebound hostname could read the CHAIN-0 view | `403` unless `Host` is exactly `127.0.0.1:<port>` / `localhost:<port>`, including no Host | `scripts/serve_terminal_local.mjs`, `tests/test_terminal_local_host_guard.mjs` |
| 2 | Time / gates | `shared/strict_timestamp.ts` accepted year `0000`, `-00:00`, offsets to `±23:59`; TIME-0 rejects them | Same policy; 4480-string parity sweep (accept/reject and millisecond instant) | `backend/shared/strict_timestamp.ts`, `tests/test_strict_timestamp.mjs` |
| 3 | DATA capture | `market_evidence_capture.mjs` init/append: no lock (lost update), no fsync before rename | Exclusive `<log>.lock` (`O_EXCL`, fail fast, never auto-removed) + fsync; 6-process concurrency test | `scripts/market_evidence_capture.mjs` |
| 4 | Integration RC-0 | Cross-system smoke covered the golden fixture only | All 6 non-archive terminal scenarios through terminal and unified rehearsal: identical view, deterministic, HOLD/FORBIDDEN, no ticket. `everything-granted`: CHAIN-0 completes, OBS-0 refuses the receipt (`UNSAFE_OUTPUT_PRESENT`), no fingerprint (by design, now asserted) | `tests/test_rc0_cross_system_contract.mjs` |
| 5 | DATA tooling | `validate_evidence_captures.mjs` `--out` guard used a string prefix | Path-segment check | `scripts/validate_evidence_captures.mjs` |
| 6 | Observability | NaN/Infinity in `marketSnapshot` passes input validation, is echoed by the abstaining MP-0 gate; the result is not hashable and `buildOfflineAuditReceipt` (hence rehearsal and terminal) threw | Receipt is REJECTED with `STAGE_INTEGRITY_INVALID`, never throws | `backend/observability/offline_receipt.ts`, `tests/test_decision_chain_mutation.mjs` |
| 7 | DATA-1 | `replayMarketEvidence` threw on a NaN/Infinity cutoff or pinned digest (echoed into the hashed envelope) | Non-string cutoff = invalid cutoff; non-string pin never matches | `backend/market_engine/evidence_archive.ts`, `tests/test_market_evidence_mutation.mjs` |
| 8 | DATA-4A | `auditCaptureContinuity` echoed a non-string cutoff into an unhashable audit | Invalid cutoff with empty echo | `backend/market_engine/capture_continuity.ts`, `tests/test_capture_chain_mutation.mjs`, `tests/lib/mutation_cases.mjs` |
| 9 | Macro facts | `mapBlsEmploymentReleaseToEventFacts` threw `TypeError` when `summary.payroll` was `undefined` | Falls through to the `MALFORMED` shape check | `backend/event_facts/bls_employment_situation_adapter.ts`, `tests/test_event_facts_adapters_mutation.mjs` |
| 10 | Event Impact / Gold Transmission | none found | Sweep only: 17214 hostile event versions, no throw, no mutation, deterministic, zero interpretations / paths | `tests/test_event_consumers_mutation.mjs` |
| 11 | Decision gates | none found | Sweep only: ten gates called directly with forged upstream envelopes, authorizations, versions and cutoffs on the golden and everything-granted chains: no positive or forbidden-state output | `tests/test_decision_gates_forged_upstream.mjs` |

Mutation sweeps (6–11) share `tests/lib/mutation_cases.mjs` (deterministic: node
replacement by 25 hostile values, removal, unknown key, own `__proto__` key; no
randomness, clock or I/O).

## Validation (real runs, this worktree)

- Final state of this handoff: `npm run typecheck` clean; `npm test` **122/122**
  test files at the last run (all code commits included; later commits are docs-only).
- Each change was followed by a full `npm test` and, for `.ts` edits, `npm run typecheck`.
- Red-before-fix was observed for changes 6, 7, 8, 9 (the new sweep failed first,
  with the stack naming the defect). It was **not** observed in isolation for
  changes 1–3 (first run's output was truncated). Direct `node tests/...` runs are
  refused by the session policy; only `npm test` / `npm run typecheck` run.
- Not run: the 17 PostgreSQL tests (need an ephemeral database / CI), and the 8
  documented exemptions. Frontend layout check (needs headless Chromium) not run.

## Domain status (unchanged unless stated)

| Domain | Status |
|---|---|
| DATA (4A–4G, capture, archives) | OFFLINE_ONLY, HISTORICAL_UNVERIFIED; capture log writer-locked (3); replay/audit harden against non-string cutoffs (7, 8). Real captures, DXY/bid/ask, supplier rights absent |
| Macro / Event Impact / Gold Transmission | NOT_APPROVED; insufficiency preserved, no consensus provider; July 2026 employment stays `UNAVAILABLE` (asserted) |
| Market Pricing, horizons, committee, PM, risk, action, CC, alerts, acceptance | HOLD / FORBIDDEN; contract-level only, no positive output reachable under forged upstream (11) |
| Terminal | READ_ONLY, simulated/origin labelled; Host guard (1) |
| Time contracts | Two parsers in parity by test (2); not consolidated |
| Database / migrations | NOT_MIGRATED; none touched |
| Recovery / security | FROZEN; REC-1 human gate |

## Remaining / next

1. Confirm in CI (ephemeral PostgreSQL included) on the exact head commit.
2. Known and left alone: `validate_evidence_captures.mjs` picks each source's
   latest `ingestedAt` with a lexical `sort()` (mis-orders `…:00Z` against
   `…:00.500Z`); it only affects which cutoff the per-source check replays at.
3. Not yet swept: official artifact parsers (BLS HTML, DOL PDF text, CPI), the
   advisory UI / transport / evidence-manifest gates with direct hostile input,
   terminal view builder with hostile replays, frontend degraded modes,
   committee/orchestrator legacy paths, `backend/worker.ts` routes (deploy-gated).
