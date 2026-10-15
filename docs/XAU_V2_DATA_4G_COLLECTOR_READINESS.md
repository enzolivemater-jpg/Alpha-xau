# DATA-4G — Collector readiness / institutional human gates

Status: **DRAFT / OFFLINE ONLY / NOT APPROVED**. Parent: DATA-4F commit `e8acd86b28714118dafd260dddae18c3a286b51b`.

Contract versions: `xau.collector-readiness.v1` and `collector-readiness-metadata-1.0.0`.

## Scope and non-goals

This is an operator review contract, **not** a collector, permission grant, supplier schedule, verified quota, migration or trading strategy. Reuse DATA-4E for explicit UTC slots, DATA-4F for synthetic retry rehearsals, DATA-4A for receipt auditing, DATA-4B proposal for persistence, and DATA-1/2/3 for evidence handling. Do not create a parallel audit or coverage engine.

## Independent gates — default DENIED

| Gate | Evidence required | Rejection condition |
|---|---|---|
| Supplier identity and entitlement | Supplier/product, approved series, commercial/API agreement, retention/replay rights, named reviewer and version | Unknown licence, forbidden redistribution or unapproved API usage |
| Calendars | Per-series authoritative schedule, timezone/DST and holiday handling, revisions and provenance of schedule version | Invented slots or unproven completeness |
| Rate and cost | Provider-confirmed rate limits and costs, retry/backoff policy, budget owner, outage/429 handling | Internal DATA-4E/4F budget presented as official quota |
| Credentials and network | Secret-manager design, least privilege, rotation, egress allowlist, audit trail, approved environment | Secret in Git, logs, trace or unapproved provider request |
| Source provenance | Raw response bytes, transport/request metadata, trustworthy first-known time, chain of custody, independent source verification policy | Digest or HTTP success alone claimed to prove authenticity |
| Durable storage | Append-only raw+receipts, plan-scoped as-of, DB-generated recorded_at, RLS, encryption, retention, backup/restore and cost review | SQL proposal treated as deployed schema |
| Recovery | Idempotent crash/restart tests, contradictory replay rejection, missing/late slots and partial outages | Synthetic replay treated as real durability proof |
| Market completeness | DXY/bid/ask source coverage and horizon requirements, real revisions, no temporal leakage, explicit completeness evidence | Missing fields filled by inference |
| Security and operations | Threat model, observability, alerting, incident runbook, CI evidence tied to exact commit | Unreviewed runtime or nonreproducible gate |
| Production authorization | Explicit separate REC-1 clearance, migration/deploy/network approval and rollback plan | Any earlier architectural approval used as production consent |
| Trading authorization | Validated market methods, risk limits, human sign-off, broker controls | Any live BUY/SELL or broker order before approval |

## Acceptance packet

For each gate record: `gate_id`, `status` (PENDING / REJECTED / APPROVED), `evidence_reference`, `evidence_digest`, `reviewer`, `reviewed_at_utc`, `expiry_or_review_due`, `scope`, `version`, `rejection_reasons`. Evidence references must be private-safe; never store credentials or raw supplier responses in Git. An approval is valid only within its documented scope, period and exact reviewed artifact versions.

**Decision rule:** missing, expired, unverifiable, inconsistent or unreviewed evidence => gate NOT APPROVED. A complete packet is necessary but not sufficient for runtime activation: production and trading require independent, explicit human decisions. No self-approval by CI or software. Current state for every gate: **PENDING**. System remains `OFFLINE_ONLY / HOLD / FORBIDDEN`.

## Validation implemented (offline metadata only)

1. `backend/market_engine/collector_readiness.ts`: pure schema validator rejecting unknown fields, invalid UTC, duplicate gate IDs, missing or expired evidence, cross-plan approvals and inconsistent statuses. `evaluateCollectorReadinessForSchedule` additionally validates the declared DATA-4E schedule and requires the packet's `planId` to match; review metadata must not be evaluated against an unrelated plan. All results remain `OFFLINE_ONLY / HOLD / FORBIDDEN`.
2. `tests/test_collector_readiness_contract.mjs` (registered in deterministic CI): invalid evidence digest, expiry, future review, wrong plan scope, duplicate gate, missing metadata and contradictory approval cases. This checks **metadata structure**, not actual supplier entitlement, licence validity, calendar completeness or independent provenance.
3. No provider network, secret access, persistent database, broker, runtime clock or production changes.
4. Follow-up before any real collection: verify underlying evidence externally, perform documented licence/calendar/retention/recovery reviews, and separately authorize changes. A packet marked `READY_FOR_HUMAN_REVIEW` never means `APPROVED_FOR_RUNTIME`.

## Human-gate checklist

- [ ] Supplier legal/technical review
- [ ] Source schedule and quota review
- [ ] Provenance and coverage review
- [ ] Durable-storage/recovery review
- [ ] Security/operations review
- [ ] REC-1 release (separate approval)
- [ ] Deployment/migration/network permission (separate approval)
- [ ] Trading authorization (separate approval)

**No merge, deploy, migration, network collection or trading authorized by this document.**
