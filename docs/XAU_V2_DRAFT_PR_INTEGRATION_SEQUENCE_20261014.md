# XAU V2 — architecture PR integration sequence (historical review snapshot)

**Snapshot 2026-10-14. Planning only — NOT a live board, merge authorization, deployment permission or REC-1 approval.**

At this snapshot, main = ec9cde542d6b51b68391462ee8fa474e650b389f. All architectural PRs below remain open drafts, unmerged. Re-read GitHub refs, CI and the production Human Gate before any future authorized action.

## Integration graph (no execution authorized)

| Stream | Draft PRs | Integration constraint |
| --- | --- | --- |
| Architecture and runtime boundary | #105 ARCH-1/ARCH-1B; #109 ARCH-2; #113 ARCH-3 | Independently review the pure gates and legacy Worker import boundaries first |
| Structural evidence | #112 EVIDENCE-0 | Structural evidence claims remain UNVERIFIED, never official-source attestation |
| Institutional chain | #106 → #107 → #108 → #110 → #111 | Ordered stacked history; reconcile and rebase in order, do not replace hardened descendants with older file snapshots |
| UI and advisory-only transport | #116 UI-0 → #119 TR-0 | #119 branch includes #116; isolate only TR-0 changes after separately approved #116 review |
| OBS calendar correction | #118 | Started from old #107. Forward-port only strict cutoff validation and new tests onto the latest hardened #110 lineage |
| Governance | #114 | Completion board is historical; distinguish verified encrypted backup from unproven isolated restore |
| Agent proposal | #104 | Inactive configuration only; no production permissions or branch-protection changes activated |
| Shared temporal contracts | #120 TIME-0 | Pure Gregorian/UTC parser; independent review before replacing any existing module timestamp validator |
| Temporal composite rehearsal | #121 | NEVER MERGE; forward-ports #120 into hardened OBS-0, EVIDENCE-0, UI-0 and tests all boundaries without source runtime changes |
| Methodology research gates | #122 METH-0 | Documentation and tests only. Eight stages remain UNAPPROVED; no invented signal, threshold, provider or risk policy |
| Combined CI experiments | #115, #117, #121 | NEVER MERGE these composite branches; they contain overlapping source histories |

## Terminal CHAIN-0 / TV-0 / TV-1 / TV-2: stacked architecture review (2026-10-14)

The institutional local terminal is a **separate, overlapping development stream**, not a deployed runtime or a second approved decision engine. The source PR chain is:

`#123 CHAIN-0 → #124 TV-0 → #125 TV-1 → #126 TV-2`.

- **#123** inherits development history from #104 (inactive agent proposal). Compare the actual decision-chain dry-run with #106/#111 and reconcile source contracts **before** selecting any implementation. Never retain competing decision-chain orchestrators silently.
- **#124** depends on #123; **#125** depends on #124; **#126** depends on #125. Their PR diffs target `main` to run Quality Gate but include inherited changes; green CI is **not** permission to merge independently or in bulk.
- Reconcile `backend/decision_chain/dry_run.ts`, shared market/as-of contracts, frontend files, and `scripts/run_ci_tests.mjs` against #105/#109/#113 architecture guards, #110 OBS hardening, #112 EVIDENCE, #116 UI, #119 TR, #120 TIME and #121 temporal integration before combining. **Forward-port reviewed deltas; do not overwrite newer hardened files with older snapshots.**
- #126 can explain HOLD, blocked gates, timestamps and provenance in the **LOCAL SIMULATION**; it is not evidence of live prices, authentic news, provider use, approved trading methods, broker connectivity or a production approval. Demo market panels and fictional directional news must remain explicitly labeled as simulated and never become action authority.
- **Exact-commit GitHub check snapshot:** #123 `08caf726`, #124 `8c4e14eb`, #125 `dd4040c2`, #126 `64ba1fde`: all showed **10/10 completed successful check runs** on 2026-10-14. This is source-branch CI only; combined integration and cross-browser/UI acceptance remain unproven.
- **Do not merge #123/#124/#125/#126, do not deploy, and do not modify main without new explicit authorization.** Retain HOLD / ABSTAIN / FORBIDDEN and the REC-1 Human Gate.

## Exact cross-stream overlap evidence (file paths only)

Comparison of changed **filenames** reported by GitHub on 2026-10-14 (snapshot, not a merge-conflict diagnosis):

| PR pair | Shared changed paths | Review consequence |
| --- | ---: | --- |
| #115 vs #126 | 4 | Both touch `backend/decision_chain/dry_run.ts`, `tests/test_decision_chain_dry_run.mjs`, `package.json` and `scripts/run_ci_tests.mjs`; inspect source semantics, fixtures and CI registration in a combined branch |
| #117 vs #126 | 4 | The same four shared paths; preserve hardened OBS-0 from #110 rather than an older #118 snapshot |
| #121 vs #126 | 4 | The same four shared paths; TIME-0 strict cutoff code must be reconciled on the selected chain |
| #119 vs #126 | 1 | Shared `scripts/run_ci_tests.mjs`; append every required test without losing existing registrations |
| #123 vs #124 | 67 | Expected inherited changes in stacked PRs — **not** 67 proven Git merge conflicts |
| #124 vs #125 | 76 | Inherited changes; review only TV-1-specific delta after TV-0 |
| #125 vs #126 | 79 | Inherited changes; review only TV-2-specific delta after TV-1 |

A shared path is a **review signal**, not proof that Git cannot merge the files. CI green on independent branch heads likewise does not establish combined integrity. An acceptable future reconciliation must run AST runtime-boundary checks, CHAIN-0 negative and spoof corpus, as-of timestamp cases, demo-news isolation, governance checks, TypeScript and the complete deterministic/PostgreSQL-ephemeral CI on the exact final tree. Do not deactivate any regression guard simply to resolve a collision.

## CHAIN-0 API divergence requiring one explicit integration choice

A direct source comparison on 2026-10-14 shows **two incompatible implementations of the same file and exported function**:

| Implementation | `backend/decision_chain/dry_run.ts` | Current entrypoint | Responsibility |
| --- | --- | --- | --- |
| #106 (offline contract stream) | ~131 lines, blob `3a8f3e9e` | `runDecisionChainDryRun(input: ChainDryRunInput)` | Combines already-materialized Market Pricing/Positioning gates with ten downstream abstaining stages |
| #123 (terminal stream) | ~780 lines, blob `61a770e0` | `runDecisionChainDryRun(input: DecisionChainDryRunInput, knowledgeCutoff: string)` plus `evaluateDecisionChain` | Builds Market Pricing and Positioning, then 10 downstream stages; validates input shapes, knowledge cutoff, traces and replay digest |

**These are not drop-in replacements.** Their input contract, entrypoint arity, envelope names and stages differ. A bare Git rebase/cherry-pick can silently drop validation or consumers even when the TypeScript tree compiles. The candidate for the interactive local terminal is #123 because TV-0/TV-1/TV-2 already depend on it, **but this is a review recommendation, not a merged architecture decision**. Preserve #106/#107/#108/#110/#111 negative-only capabilities through explicit adapters or vetted forward-ports; do **not** keep two public functions with the same name and divergent semantics as competing decision authorities.

Future acceptance requires (a) one canonical CHAIN-0 entrypoint and versioned input/output identity, (b) one shared strict as-of cutoff, (c) preservation of hardening and provenance guarantees from the other stream, (d) all 12 stage traces, (e) replay determinism and zero positive output, and (f) exact-tree combined CI, not simply two green PRs. No decision, execution, credential, alert or runtime is authorized by this comparison.

## REC-1 frozen-reference drift (reconciliation required)

The REC-1 instruction names `a4bdd6d43d048f98dc7e506537a82d4f7488d119` as its frozen main reference, but the observed main head on 2026-10-14 is `ec9cde542d6b51b68391462ee8fa474e650b389f`, **6 commits ahead**. The additional commits are the REC-1-related #97/#98/#99/#101/#102/#103 changes dated 2026-10-12. This records GitHub history, **not** proof of operator approval, production state or correctness of a restore.

Do not silently reinterpret the frozen reference as the later commit, reset `main`, or use this snapshot to authorize an operation. Reconcile the six GitHub commits against the authorized recovery scope and explicit Human Gate before any subsequent merge, migration, deploy or restore.

Other unrelated open PRs (#96, #100) remain outside this approval scope.

## Discovered source conflict — mandatory future regression

The composite #117 rehearsal found that copying the older OBS-0 file from #118 wholesale over the hardened OBS-0 from #110 removed later anti-spoof protections. Its negative test caught a forged runtime deployment ID receiving a VALID_HOLD checksum. The experimental branch was corrected by forward-porting only the calendar predicate and added tests onto the fully hardened OBS-0. Every future combination must preserve the hardened fake-approval/runtime/alert/order rejection corpus.

## Review-only sequence — DO NOT EXECUTE NOW

1. Refresh current main and all source PR head SHAs, branch protections and exact CI results; this document is not a permanent live truth source.
2. Compare any unpublished local CHAIN-0 dry-run variant before integration, avoiding duplicate orchestrators.
3. Review #105, #109 and #113 guards first. A new path from Worker/cron/legacy Committee to decision-only V2 requires a separate architecture review, not disabling a failed guard.
4. Reconcile #106 → #107 → #108 → #110 → #111 in dependency order. Keep every version, cutoff and anti-spoof test. Forward-port only the #118 calendar validation after the hardened OBS-0 state.
5. Review TIME-0 (#120), then EVIDENCE-0, UI-0 and TR-0. Use #121 only as proof of the integration hypothesis, not as merge code. A structurally valid offline packet is still UNVERIFIED, NOT_CONNECTED, HOLD / ABSTAIN / FORBIDDEN.
6. Independently review METH-0 (#122) research requirements; no positive market methodology may be enabled without Human Gate approval. Re-run exact-commit TypeScript, negative regression and combined CI. Verify fake authority, deployment/correlation IDs, bad dates, order injection, alert delivery, future evidence and downstream terminal abstention stay rejected.
7. Only separate explicit human authorization permits individual source PR merges. Do NOT merge #115/#117/#121 or infer deployment, production access or broker permissions from passing CI.
8. REC-1 isolated restore, production migrations, source/vintage attestation, staging, positive market methods, risk/portfolio policies and live operational acceptance remain independent Human Gates.

## Stop conditions

Stop on any weakening of spoof guards, second source of truth, invalid as-of cutoff, runtime wiring, provider/broker activation, fabricated production evidence or attempt to treat green CI as execution approval. The only currently authorized institutional state is HOLD / ABSTAIN / FORBIDDEN.

**Documentation only; main, runtime and production remain unchanged.**