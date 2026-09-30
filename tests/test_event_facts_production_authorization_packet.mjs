import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packet = readFileSync(
  new URL('../docs/XAU_V2_EVENT_FACTS_PRODUCTION_AUTHORIZATION_PACKET.md', import.meta.url),
  'utf8',
);

assert.match(packet, /EF-13 READY FOR HUMAN DECISION — PRODUCTION HOLD/);
assert.match(packet, /ejvwmjgfvhsslqiydwpz/);
assert.match(packet, /20260923133811 gold_transmission_atomic_rpc/);
assert.match(packet, /45 `event_clusters`, 45\s+`event_versions`, and 0 `event_cluster_identity_claims`/);
console.log('PASS production target, migration tail, and read-only counts are frozen');

for (const [migration, hash] of [
  ['0029_event_facts_ces_v2_persistence.sql', '3fd67ee2678d90038e402058c027329876dcd5473286c1a1b661ee5e284e46bb'],
  ['0030_official_source_artifacts.sql', 'b624446fe304f37b001cececf433dcad78c077d4e0ac372d35157206e4b7b049'],
  ['0031_event_identity_active_lookup.sql', '6283c712421198c2af6c96a29331ed8d3db057794cc19551279c1849e54a1d9c'],
  ['0032_event_facts_atomic_production.sql', '450583dac5df83770c5df8f99b24ba467558d56338e4369c85ba0fef245193b5'],
]) {
  assert.match(packet, new RegExp(`${migration.replaceAll('.', '\\.') }.*${hash}`));
}
console.log('PASS exact migration order and SHA-256 payload are frozen');

for (const evidence of [
  'Supabase `Free` plan',
  'supabase db dump',
  'isolated restore rehearsal',
  'BLOCKED — OPERATOR UNASSIGNED',
  'FINAL_MAIN_SHA=<40-hex SHA>',
  'RUNTIME_AUTHORIZED=NO',
  '6 `security_definer_view` errors',
  '5 mutable-function-search-path',
]) {
  assert.ok(packet.includes(evidence), `missing authorization evidence: ${evidence}`);
}
console.log('PASS recovery blocker, baseline risks, and exact approval record are explicit');

assert.match(packet, /Production remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`/);
assert.doesNotMatch(packet, /PRODUCTION AUTHORIZED|RUNTIME ACTIVATED|LIVE-PROVEN/);
console.log('PASS production and runtime remain unauthorized');
