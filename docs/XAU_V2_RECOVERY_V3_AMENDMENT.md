# XAU V2 — REC-1 V3 recovery amendment

Status: `READY FOR FRESH HUMAN DECISION — NOT AUTHORIZED`

This amendment supersedes the stale V2 REC-1 execution packet only for the V3
recovery rehearsal. It does not authorize production restore, migrations,
runtime, routes, schedules, providers, broker actions, or trading.

Frozen V3 payload:

- `scripts/recovery_manifest.mjs`: `fd95a49fbd7eca3938d4044e47d16b6fab7f86317362e173d8482096b06bac31`
- `docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md`: `3e72e17ac4230affcde2de1ed61eb00f83546f4e24f5ce7bda2c648c906cb121`

The second REC-1 attempt completed source capture, logical backup, encryption,
decryption verification, and off-site copy. It then stopped fail-closed during
the isolated target restore on the generated managed-platform statement
`GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";`.

Read-only reconciliation proved the source and target already expose the same
managed parameter privilege, granted by `supabase_admin`. V3 therefore allows
only the fail-closed compatibility transform frozen in the runbook: preserve
the original role dump, verify the exact single managed parameter statement and
target privilege, derive `roles-restore.sql` by omitting only that exact line,
and record the derived SHA-256.

A bounded resume may reuse the already encrypted artifact from the failed V2
run. Resume must decrypt into a new private workdir, verify the recorded
plaintext SHA-256 values, request no production credential, perform no new
production capture/dump, restore only to the approved isolated target, and
require the exact manifest comparator to return PASS.

Any mismatch, additional parameter ACL, different grantee/grantor, failed
checksum, restore error, or comparator mismatch means STOP.

A fresh human decision must bind the current main SHA, the two frozen hashes,
the prior workdir, the encrypted-artifact SHA-256, target ref, review mode,
maintenance window, and confirm that source recapture is not authorized for a
resume.
