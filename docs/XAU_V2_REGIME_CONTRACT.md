# XAU V2 — Regime dependency contract (R-0)

Status: `CONTRACT_CI_PROVEN — REGIME INFERENCE FORBIDDEN`

R-0 creates the deterministic boundary between versioned Market Pricing,
Positioning evidence and any future regime assessment. It does not reuse the
legacy Committee's free-text/LLM `market_regime` as V2 evidence.

Frozen versions:

- `xau.regime-assessment.v1`;
- `regime-dependency-gate-1.0.0`.

## Dependency gate

The gate requires exact MP-0 and P-0 schema/algorithm versions and one identical
explicit knowledge cutoff across all inputs. It abstains on an invalid cutoff,
version drift, upstream abstention or positioning-evidence failure. Degraded
Market Pricing and an unavailable Positioning signal are preserved explicitly.

R-0 always emits:

```text
regime=UNAVAILABLE
confidence=null
reason=REGIME_METHODOLOGY_NOT_APPROVED
```

No fallback label such as `range_bound`, `risk_on` or `risk_off` is allowed.
Absence of evidence cannot become a neutral market view.

## Closure requirements

R-1 requires an approved deterministic methodology defining its complete input
set, observation windows, revision/as-of behavior, thresholds, conflicting
signals, missing-data rules, confidence calibration, validation corpus and
replay acceptance. It must keep an explicit abstention path.

R-0 authorizes no semantic activation, LLM inference, provider use, purchase,
database change, migration, runtime wiring, deployment, schedule, broker
connection or trading action.

