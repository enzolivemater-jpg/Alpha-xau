# XAU V2 — UI-0 offline advisory projection

**State: code + offline CI contract only. NOT deployed, not wired into the terminal, not production.**

## Purpose and trust boundary

UI-0 lives in \`backend/advisory_ui/contract.ts\` and derives a non-actionable **view model**, not an operational dashboard, from *claimed* CC-0, AL-0, and E2E-0 envelopes at one explicit caller-supplied knowledge cutoff. It imports the authoritative contract versions and H1-H5 identifiers rather than copying them.

**Structural claims are not authenticated evidence.** Even if all incoming fields match the versioned gate contracts, UI-0 never claims source authenticity, observed prices, live deployment, production acceptance, provider authorization, or trade readiness. \`claimedKnowledgeCutoff\` is explicitly a caller claim; it is not a validated live-event timestamp.

There are no fetches, secrets, network, runtime clock, database reads, DOM writes, broker access, notifications or execution paths. UI-0 is an independent pure function and is **not imported** by \`backend/worker.ts\` or the existing \`frontend/js/dashboard.js\`. A successful UI-0 Quality Gate does not activate any interface.

## Stable fields and safety invariants

- \`OFFLINE_CONTRACT_ONLY\`, \`UNVERIFIED\` and \`NOT_CONNECTED\` are unconditional.
- \`HOLD / ABSTAIN / FORBIDDEN\` remain unconditional; no executable recommendation, size, trade ticket or alert payload can be emitted.
- H1-H5 are placeholders with \`UNAVAILABLE\` direction and null targets/confidence, not forecasts.
- Alerts are \`SUPPRESSED\`; E2E acceptance/production readiness stays \`HOLD\`.
- Caller-provided dates require full offset and valid calendar fields but cannot be interpreted as attested vintage, publication time or replay proof.
- CC-0/AL-0/E2E-0 malformed or approval-spoofed envelopes are rejected **structurally**; reasons are UI-0-owned fixed codes, never forwarded from arbitrary caller text.
- Even structurally coherent envelopes always report \`SOURCE_ATTESTATION_NOT_AVAILABLE\` and \`UI_RUNTIME_NOT_AUTHORIZED\`.

## How to review without production access

\`npm run typecheck\` and \`node --experimental-strip-types tests/test_advisory_ui_0_contract.mjs\` check the contract in an isolated temporary JS transpilation directory. The test constructs CC, alert and acceptance envelopes using their real approved abstention builders, checks deterministic replay and exercises adversarial alterations. The ordinary deterministic runner includes this test.

**No merge / no deploy / no migration / no REC-1 restore / no provider activation / no broker or live trade.**

## Future integration gates (not part of this PR)

1. Independent review of the institutional model and the real UI's distinction between historical V1 and V2.
2. Provenance and as-of lineage attestation outside UI-0; a structurally coherent payload alone never suffices.
3. A versioned API transport contract and authentication model, explicitly approved before binding an actual browser surface.
4. Human approval of positive regime, horizon, committee, portfolio and risk semantics; later model version must not silently relax UI-0's fixed abstention.
5. Separate verified staging and production acceptance including REC-1, not inferred from GitHub CI.

UI-0 does not overwrite the existing terminal or claim that REC-1 has passed.
