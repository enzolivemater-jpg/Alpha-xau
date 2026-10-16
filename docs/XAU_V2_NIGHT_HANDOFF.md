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
| 12 DOL claims text parser borrowed another statement's figures | `6a9ed5b` |
| 13 BLS employment HTML parser, bounded check | `3120fc5` |
| 14 advisory UI / transport / evidence manifest sweep, manifest cutoff echo | `2cbaa92` |
| 15 provider parsers (FRED / Twelve Data) | `02c5038` |
| 16 MP-1 / MP-2 / P-0 / P-1 / validatePoint / capture hardening | `2031ac2` |
| 17 identity-key ambiguity and non-JSON state at the write boundary | `ba0b0f5` |
| 18 deterministic nesting bound (`canonicalJson`, CPI writer) | `19dd94d` |

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

| 12 | Macro facts (DOL) | **Wrong facts accepted.** The lazy `.*?` gaps of the claims text parser could cross into the next paragraph: with the initial-claims "previous week's level was revised" sentence missing, initial claims silently got the continuing-claims revision (1,719,000 → 1,712,000) and the adapter resolved it. Same gaps cost ~7 s on a 900,000-character repeated prefix | Gaps bounded to 800 chars and unable to cross `In the week ending` / `The advance `; now fails closed (`MALFORMED`). Value integrity stays the manifest hash's job (documented) | `backend/event_facts/dol_ui_weekly_claims_text_parser.ts`, `tests/test_official_text_parser_mutation.mjs` |
| 13 | Macro facts (BLS) | none found | Bounded check only (14 cases). An exhaustive HTML sweep is **not run**: jsdom retains ~90 MB per parsed 1 MB page even after `window.close()` (measured with forced GC, raw JSDOM x4 = +370 MB). Operator script, not a service | `tests/test_official_html_parser_mutation.mjs` |
| 14 | Presentation | `buildEvidenceEligibilityManifest` echoed a non-string cutoff into an unhashable value. UI-0 / TR-0: none found (3086 writer round trips always non-actionable; 1765 mutated packets, 57 accepted, all canonical and safe) | Invalid cutoff with empty echo | `backend/observability/evidence_manifest.ts`, `tests/test_advisory_surface_mutation.mjs` |
| 15 | DATA providers | `parseFred` / `parseFredObservations` threw `TypeError` on a non-text `date`; `parseTwelveData` could return a year-275760 timestamp no strict gate accepts | Explicit unavailable points; available points always finite with strict timestamps | `backend/market_engine/providers.ts`, `tests/test_provider_parsers_mutation.mjs` |
| 16 | DATA / positioning | MP-2 and P-1 RPC normalizers: `TypeError` on a non-array result; text NUMERIC read with `Number()` (`"0x10"` → 16); `RegExp.test()` coerced `undefined`/arrays into valid text in **P-0 and P-1** (an undefined source authority reached the evidence set); MP-1 threw on a non-iterable history; `validatePoint` threw on a symbol with no rule; `appendProviderCapture` / `mergeCaptureArchives` threw on a log holding `null`/array; non-string cutoffs echoed into hashed envelopes | `typeof` before every regex, plain-decimal text values, named refusals, own-property symbol lookup, structure check on logs, empty echo for non-string cutoffs | `backend/market_engine/{as_of_snapshot,persisted_as_of,validate,evidence_capture}.ts`, `backend/positioning_engine/{evidence_contract,persisted_evidence}.ts`, `tests/test_market_data_ingest_mutation.mjs` |
| 17 | Event facts write boundary | The strong identity key joins namespace/type/value with U+001F (also `chr(31)` in frozen SQL), so two different triples hash alike; the CPI writer's "JSON" check let `Map`, `Set`, `Date`, class instances, getters and sparse arrays through | Application boundary refuses U+001F in identity fields (no adapter emits it); strictly plain JSON required. **SQL not changed** (migration gate) | `backend/event_facts/{release_identity_lookup,bls_cpi_production_writer}.ts`, `tests/test_event_facts_write_boundary_mutation.mjs` |
| 18 | Shared | `canonicalJson` recursed unbounded: deep or circular input overflowed the stack with a host-dependent `RangeError`; the new strict-JSON check did too | Fixed bound (256 levels; 64 for the CPI writer state) with a typed `TypeError` / `false`; 30 entry points fed 2,000–300,000 levels | `backend/shared/canonical_json.ts`, `tests/test_deep_nesting.mjs` |

Mutation sweeps (6–18) share `tests/lib/mutation_cases.mjs` (deterministic: node
replacement by 25 hostile values, removal, unknown key, own `__proto__` key; no
randomness, clock or I/O).

## Validation (real runs, this worktree)

- Final state of this handoff: `npm run typecheck` clean; `npm test` **129/129**
  test files at the last run (all code commits included; later commits are docs-only).
  Baseline was 115; the 14 new files are the mutation/boundary sweeps above plus the
  Host-guard test.
- The `.mjs` scripts (capture CLI, terminal server) are covered by tests, not by `tsc`.
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
3. Not yet swept: BLS CPI raw artifact parser (`bls_cpi_artifact_parser.ts`: regex gaps
   over XML are tag-delimited, but unclosed tags look quadratic on a 2 MB cap; the
   raw artifacts are not in the repository), the CPI producer planner and
   orchestrator, frontend rendering under hostile views (jsdom retains ~90 MB per
   instance), committee / orchestrator legacy paths, news collectors, and
   `backend/worker.ts` routes (deploy-gated).
4. Open design question, not changed: the SQL key derivation (`chr(31)` join) stays
   ambiguous in the database; only the application boundary refuses U+001F. A SQL
   `CHECK` or a length-prefixed key is a schema decision for the migration gate.
