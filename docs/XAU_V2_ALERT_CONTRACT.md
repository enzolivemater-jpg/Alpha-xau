# XAU V2 — alert suppression contract (AL-0)

Status: `CONTRACT_CI_PROVEN — DELIVERY FORBIDDEN`

AL-0 freezes the boundary between the read-only Command Center and any future
notification. It validates the exact CC-0 schema/algorithm identity and shared
knowledge cutoff, then produces a deterministic deduplication key from the
versioned upstream state and sorted reason codes.

Frozen versions:

- `xau.alert-suppression.v1`;
- `alert-suppression-gate-1.0.0`.

The current result is always `SUPPRESSED` with delivery and escalation
forbidden. Expiry, acknowledgement, recipient, channel and payload remain
unavailable rather than receiving invented defaults. The dedupe key is an
internal deterministic identity, not a delivery instruction.

AL-1 must separately freeze alert eligibility, severity, horizon/expiry,
dedupe retention, acknowledgement, escalation, quiet hours, recipient and
channel policy, redaction, retry limits, delivery evidence and replay behavior.
Positive delivery requires explicit alert, recipient and delivery authority.

AL-0 authorizes no secret use, persistence, migration, runtime wiring,
deployment, external message, broker connection, order or trading.
