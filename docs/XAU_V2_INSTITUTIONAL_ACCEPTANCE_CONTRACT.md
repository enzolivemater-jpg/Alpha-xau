# XAU V2 — institutional acceptance manifest (E2E-0)

Status: `CONTRACT_CI_PROVEN — NOT ACCEPTED / PRODUCTION HOLD`

E2E-0 freezes the final evidence manifest without executing an acceptance run
or claiming production readiness. It consumes only the exact AL-0 identity and
shared cutoff and lists every missing proof in stable order.

Frozen versions:

- `xau.institutional-acceptance.v1`;
- `institutional-acceptance-gate-1.0.0`.

The required evidence set covers a restorable recovery point, live migrations,
one official live bundle, runtime deployment, provider and semantic approvals,
portfolio/risk policies, alert-delivery policy, golden-path replay, incident
recovery and execution authority. Contract or CI evidence cannot satisfy a
live-production item.

The current result is always `NOT_ACCEPTED` and `HOLD`; acceptance run and
report are null. E2E-1 requires a separately authorized bounded execution plan,
named operators, exact deployment/database identities, observation logs,
rollback/containment and independent review.

E2E-0 authorizes no backup extraction, migration, provider purchase, runtime
deployment, live data write, alert delivery, broker connection, order or trade.
