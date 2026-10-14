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