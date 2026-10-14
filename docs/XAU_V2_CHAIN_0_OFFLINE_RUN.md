# XAU V2 — CHAIN-0 offline decision-chain dry run

Status: `CODE + CI CONTRACT ONLY`; **not a production or positive trade decision**.

`backend/decision_chain/dry_run.ts` composes existing institutional
contracts as pure functions, reusing the actual output of each stage as the
next stage's input. One caller-supplied `knowledgeCutoff` traverses all ten
gates in their actual dependency order:

Regime → H1–H5 Synthesis → Committee V2 → Pre-PM → Portfolio Manager →
Final Action Risk → Action → Command Center → Alerts → Acceptance.

Input Event Impact / Gold Transmission and Market Pricing / Positioning
claims are supplied by the offline test harness. This **does not** call a
provider, read a live database, synthesize a price, imply evidence exists,
or run the production Worker. Approval fields are intentionally fixed to
`UNAUTHORIZED`; absent evidence is recorded as not supplied to the
simulation, not asserted absent in production.

The result always has `OFFLINE_ONLY`, `HOLD`, `FORBIDDEN`. Every gate
remains responsible for validating its own direct input version and cutoff,
and for preserving reason codes and null action/size/stop/order fields.
`tests/test_decision_chain_dry_run.mjs` verifies a fixed replay, no input
mutation, the exact five horizons, 10 gates, version drift, cutoff drift
and invalid timestamp behavior.

**Integration rule:** CHAIN-0 is deliberately not imported from
`backend/worker.ts`, cron, HTTP, UI, the legacy Committee or any broker.
It grants no permission to call AI providers, change portfolio/risk policy,
deploy, migrate, deliver alerts, restore a database or trade.

**Next:** OBS-0 may derive a stable audit receipt from these actual
stage envelopes, but cannot upgrade this simulation's readiness status.
CHAIN-0 should be compared against any unpublished local
`feat/chain-0-decision-chain-dry-run` before further consolidation to
avoid a competing orchestrator. REC-1 remains separately gated.
