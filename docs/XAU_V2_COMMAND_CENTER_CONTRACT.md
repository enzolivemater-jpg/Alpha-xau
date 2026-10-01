# XAU V2 — read-only Command Center contract (CC-0)

Status: `CONTRACT_CI_PROVEN — RUNTIME NOT DEPLOYED`

CC-0 freezes a read-only projection of the current institutional chain. It
accepts only the exact A-0 identity and shared cutoff and exposes the honest
current state: `HOLD`, `EVIDENCE_INCOMPLETE`, `ABSTAIN`, execution forbidden,
scenario tree unavailable and no trade ticket.

Frozen versions:

- `xau.command-center-projection.v1`;
- `command-center-read-only-projection-1.0.0`.

The projection carries a deterministic lineage of Market Pricing, Positioning,
Regime, H1–H5, AI Committee, pre-PM, Portfolio Manager, Final Action Risk and
Action schema/algorithm identities. Missing correlation and deployment IDs
remain visible as observability blockers; they are never fabricated.

CC-0 is a backend contract only. It does not modify the legacy terminal,
publish a site, connect runtime data, imply live observability or display a
scenario tree whose inputs do not exist. CC-1 requires a reviewed UI mapping,
runtime correlation propagation, deployment proof, accessibility and failure
containment tests.

CC-0 authorizes no persistence, migration, runtime wiring, deployment, alert,
broker connection, order construction or trading.
