# ARCH-3 — transitive institutional import closure

Status: `STATIC CI GUARD; NO RUNTIME OR PRODUCTION CHANGE`.

ARCH-1 documents the current modular architecture and checks direct
entry-point boundaries. ARCH-2 checks a set of known side-effectful
operations in decision modules. ARCH-3 supplies the missing **transitive
import graph control**:

- Start at the ten current institutional decision gates.
- Follow every static TypeScript import and re-export recursively.
- Require every reachable module to remain on an explicitly reviewed
  allowlist, and exist at its expected `backend/.../*.ts` path.
- Reject cycles, dynamic imports, CommonJS `require`, bare imports or
  dependency additions that have not been architecturally reviewed.
- Include CHAIN-0, OBS-0 and EVIDENCE-0 roots automatically **if** their
  independent PRs become present in a future checkout.
- Preserve a small positive and negative self-test corpus to prove that
  violations are actually caught.

The as-checked existing closed graph has 15 modules (ten roots and five
support modules). Changing a dependency is a reviewed architectural
event, not an occasion to disable tests. The allowlist may be extended
only when the new dependency's trust and side effects have been audited.

**Trust limit:** the static graph cannot prove that a permitted
helper's implementation is pure, that a published artifact is authentic,
or that a real deployment is safe. It must be combined with ARCH-2,
module tests and Human Gate evidence. It does not perform a provider
call, modify runtime schedules, deploy, migrate, connect to broker or
interact with REC-1.
