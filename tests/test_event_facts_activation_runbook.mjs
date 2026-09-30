import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runbook = readFileSync(new URL('../docs/XAU_V2_EVENT_FACTS_ACTIVATION_RUNBOOK.md', import.meta.url), 'utf8');
const migrations = [
  '0029_event_facts_ces_v2_persistence.sql',
  '0030_official_source_artifacts.sql',
  '0031_event_identity_active_lookup.sql',
  '0032_event_facts_atomic_production.sql',
];
let cursor = -1;
for (const migration of migrations) {
  const next = runbook.indexOf(`1. \`${migration}\``, cursor + 1) >= 0
    ? runbook.indexOf(`1. \`${migration}\``, cursor + 1)
    : runbook.indexOf(`\`${migration}\``, cursor + 1);
  assert.ok(next > cursor, `${migration} must appear in dependency order`);
  cursor = next;
}
console.log('PASS activation runbook freezes migrations 0029-0032 in dependency order');

for (const gate of ['Staging choice', 'Recovery readiness', 'Migration authority',
  'Fingerprint ownership', 'Consensus boundary', 'Runtime authority']) {
  assert.match(runbook, new RegExp(`\\*\\*${gate}:\\*\\*`));
}
assert.match(runbook, /SCHEMA_READY_RUNTIME_OFF/);
assert.match(runbook, /HOLD — NOT AUTHORIZED FOR LIVE EXECUTION/);
console.log('PASS schema deployment and runtime activation have separate Human Gates');

for (const proof of ['rollback-wrapped', 'exact replay', 'divergent-fingerprint rejection',
  'downstream rollback', 'RLS enabled', 'zero client policies', 'empty row counts']) {
  assert.match(runbook, new RegExp(proof, 'i'));
}
console.log('PASS runbook requires replay, rollback, privilege, and empty-state proofs');

assert.match(runbook, /do not retry blindly/i);
assert.match(runbook, /Never delete migration-history rows/i);
assert.match(runbook, /forbidden after any committed\s+production Event Facts write/i);
assert.doesNotMatch(runbook, /Status: `AUTHORIZED|Status: `LIVE|AUTO_ACTIVATE/);
console.log('PASS failure policy is forward-fix-first and contains no activation authorization');

for (const migration of migrations) {
  const sql = readFileSync(new URL(`../database/migrations/${migration}`, import.meta.url), 'utf8');
  assert.match(sql, /^BEGIN;/m, `${migration} must start an explicit transaction`);
  assert.match(sql, /^COMMIT;/m, `${migration} must commit explicitly`);
}
console.log('PASS every frozen migration owns an explicit transaction boundary');
