import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const proof = readFileSync(
  new URL('../docs/XAU_V2_EVENT_FACTS_STAGING_PROOF.md', import.meta.url),
  'utf8',
);

assert.match(proof, /EF-12 PROVEN — SCHEMA READY ON ISOLATED STAGING \/ RUNTIME OFF/);
assert.match(proof, /viskjhkkcnzqxkuvibdx/);
assert.match(proof, /PostgreSQL: `17\.11`/);
assert.match(proof, /second Free project, `\$0\/month`/);
console.log('PASS staging target, platform version, and cost boundary are explicit');

for (const [migration, hash] of [
  ['0029_event_facts_ces_v2_persistence.sql', '3fd67ee2678d90038e402058c027329876dcd5473286c1a1b661ee5e284e46bb'],
  ['0030_official_source_artifacts.sql', 'b624446fe304f37b001cececf433dcad78c077d4e0ac372d35157206e4b7b049'],
  ['0031_event_identity_active_lookup.sql', '6283c712421198c2af6c96a29331ed8d3db057794cc19551279c1849e54a1d9c'],
  ['0032_event_facts_atomic_production.sql', '450583dac5df83770c5df8f99b24ba467558d56338e4369c85ba0fef245193b5'],
]) {
  assert.match(proof, new RegExp(`${migration.replaceAll('.', '\\.') }.*${hash}`));
}
assert.match(proof, /0029 → 0030 → 0031 → 0032/);
console.log('PASS frozen migration order and reviewed SHA-256 hashes are recorded');

for (const evidence of [
  'CES V1',
  'one-byte-different content',
  'collision (`>1`) cardinalities',
  'operation_replayed=true',
  'EF8_OPERATION_IDEMPOTENCY_CONFLICT',
  'forced failure on downstream Event Version insertion',
  'all Event Cluster and Event Facts row counts are zero',
  'no Edge Function is deployed',
  '`cron.job` table is absent',
  '48/48 deterministic test files',
]) {
  assert.ok(proof.includes(evidence), `missing staging evidence: ${evidence}`);
}
console.log('PASS replay, rollback, empty-state, advisor, and runtime-off evidence are recorded');

assert.match(proof, /not represented as a full production-schema\s+clone/i);
assert.match(proof, /Production remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`/);
assert.doesNotMatch(proof, /PRODUCTION AUTHORIZED|RUNTIME ACTIVATED|LIVE-PROVEN/);
console.log('PASS staging limitation is explicit and production remains unauthorized');

