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

## Commits (local only, never pushed)

The first session had no git identity (commits blocked); the operator then
configured one. Resolved. Commits on top of `e1e70225`:

| Change | Commit |
|---|---|
| 1 terminal Host guard | `f3e98ae` |
| 2 timestamp parity | `c96d34e` |
| 3 + 5 capture lock/fsync, `--out` guard | `7641c9a` |
| 4 RC-0 scenario parity test | `031c928` |

## Changes

| # | Domain | Defect (demonstrated) | Fix | Files |
|---|---|---|---|---|
| 1 | Terminal / security | Local server bound to loopback but served any `Host`; a rebound hostname could read the CHAIN-0 view | `403` unless `Host` is exactly `127.0.0.1:<port>` or `localhost:<port>`, including a missing Host | `scripts/serve_terminal_local.mjs`, `tests/test_terminal_local_host_guard.mjs` (new), `scripts/run_ci_tests.mjs`, `docs/XAU_V2_TERMINAL_LOCAL_VIEW_CONTRACT.md` |
| 2 | Time / gates | `shared/strict_timestamp.ts` (CHAIN-0, market, positioning, V2 gates) accepted year `0000`, `-00:00` and offsets to `±23:59`, which TIME-0 `parseStrictInstant` rejects | Same year/zone policy; 4480-string parity sweep requires identical accept/reject and identical millisecond instants | `backend/shared/strict_timestamp.ts`, `tests/test_strict_timestamp.mjs`, `docs/XAU_V2_TIME_0_STRICT_TEMPORAL_CONTRACT.md` |
| 3 | DATA capture | `market_evidence_capture.mjs init/append` rewrote the whole log with no lock: concurrent writers could silently drop a capture; log not fsynced before rename | Exclusive `<log>.lock` (`O_EXCL`, fail fast, never auto-removed), `fsync` before rename; test covers held lock, independent logs, no leftovers, 6 concurrent appends with no lost success | `scripts/market_evidence_capture.mjs`, `tests/test_market_evidence_capture.mjs`, `docs/XAU_V2_MARKET_EVIDENCE_REPLAY_CONTRACT.md` |

| 4 | Integration (RC-0) | Cross-system smoke covered the golden fixture only; the plan requires the same accepted receipt and HOLD across every scenario | `tests/test_rc0_cross_system_contract.mjs` now runs all 6 non-archive terminal scenarios through both the local terminal and the unified rehearsal: identical terminal view, deterministic replay, HOLD/FORBIDDEN, no trade ticket, packet actionability NONE. Finding: `everything-granted` completes CHAIN-0 but OBS-0 refuses its receipt (`UNSAFE_OUTPUT_PRESENT`), so no fingerprint is shown (by design, now asserted). Test only, no production code change | `tests/test_rc0_cross_system_contract.mjs` |
| 5 | DATA tooling | `validate_evidence_captures.mjs` `--out` guard used a string prefix (`startsWith(dirname)`), so a sibling directory such as `<dir>-sibling` was refused as if inside the source directory | Path-segment check via `path.relative`; the source directory itself is still refused | `scripts/validate_evidence_captures.mjs`, `tests/test_market_evidence_capture.mjs` |

## Validation (real runs, this worktree)

- After change 1: `npm test` 116/116, `npm run typecheck` clean.
- After change 2: `npm test` 116/116, `npm run typecheck` clean. First run of the new
  sweep failed only on my own coverage threshold (not on parser disagreement); fixed.
- After change 3: `npm test` 116/116. (Typecheck covers `.ts` only; the `.mjs` script is exercised by the test.)
- After changes 4–5: `npm test` 116/116.
- Red-before-fix was **not** observed in isolation for change 1 (the first run
  failed with output truncated, so which assertion failed was not seen) or for
  changes 2–3. Direct `node tests/...` runs are refused by the session policy; only
  `npm test` / `npm run typecheck` run.
- Not run: the 17 PostgreSQL tests (need an ephemeral database / CI), and the 8
  documented exemptions.

## Domain status (unchanged unless stated)

| Domain | Status |
|---|---|
| DATA (4A–4G, capture, archives) | OFFLINE_ONLY, HISTORICAL_UNVERIFIED; capture log now writer-locked (change 3). Real captures, DXY/bid/ask, supplier rights absent |
| Macro / Event Impact / Gold Transmission | NOT_APPROVED; insufficiency preserved, no consensus provider |
| Market Pricing, horizons, committee, PM, risk, action | HOLD / FORBIDDEN; contract-level only |
| Terminal | READ_ONLY, simulated/origin labelled; Host guard added (change 1) |
| Time contracts | Two parsers now in parity by test (change 2); not consolidated |
| Database / migrations | NOT_MIGRATED; none touched |
| Recovery / security | FROZEN; REC-1 human gate |

## Remaining / next

1. Create the commits above (needs a git identity).
2. Confirm in CI (ephemeral PostgreSQL included) on the exact head commit.
3. Known and left alone: `validate_evidence_captures.mjs` picks each source's
   latest `ingestedAt` with a lexical `sort()`, which mis-orders `…:00Z` against
   `…:00.500Z`; it only affects which cutoff the per-source check replays at.
4. Not yet examined: frontend degraded modes, committee/orchestrator paths,
   `backend/worker.ts` routes (runtime, deploy-gated).
