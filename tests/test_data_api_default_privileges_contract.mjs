import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const migration = read('../database/migrations/20261008094133_data_api_default_privileges.sql');
const schema = read('../database/schema.sql');
const dossier = read('../docs/XAU_V2_DATA_API_DEFAULT_PRIVILEGES.md');
const dashboard = read('../frontend/js/dashboard.js');
const hash = createHash('sha256').update(migration).digest('hex');

const statements = migration
  .replace(/^\s*--.*$/gm, '')
  .split(';')
  .map(value => value.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

assert.deepEqual(statements, [
  'BEGIN',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated, service_role',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated, service_role',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
  'COMMIT',
]);
assert.doesNotMatch(migration, /\b(?:CREATE|DROP|TRUNCATE)\b/i);
console.log('PASS SB-3 payload is limited to future-object default privilege revocations');

for (const statement of statements.slice(1, -1)) {
  assert.ok(
    schema.replace(/\s+/g, ' ').includes(`${statement};`),
    `fresh schema missing ${statement}`,
  );
}
console.log('PASS fresh-install schema has opt-in Data API defaults');

for (const relation of ['v_market_latest', 'v_news_high_impact', 'v_ai_latest']) {
  assert.match(dashboard, new RegExp(`['\"]${relation}\\?select=`));
}
assert.match(dashboard, /SUPABASE_ANON_KEY/);
assert.doesNotMatch(dashboard, /service_role/i);
console.log('PASS browser Data API inventory remains three reviewed anon views');

for (const path of [
  '../database/migrations/0030_official_source_artifacts.sql',
  '../database/migrations/0032_event_facts_atomic_production.sql',
  '../database/migrations/20261002085845_market_pricing_history_as_of.sql',
  '../database/migrations/20261002092118_positioning_evidence_history_as_of.sql',
]) {
  const sql = read(path);
  assert.match(sql, /GRANT (?:SELECT, INSERT|EXECUTE)/);
  assert.match(sql, /TO service_role;/);
}
console.log('PASS pending new-object migrations carry explicit service-role grants');

assert.match(dossier, /SB-3 CODE CANDIDATE — NOT LIVE-APPLIED/);
assert.equal(hash, 'ac67440e06be6283e1da22487b554e9ceeb84094ebbb26c83da09d33e24b4905');
assert.ok(dossier.includes(hash));
assert.match(dossier, /APPLY_ONLY_20261008094133=YES/);
assert.match(dossier, /SUPABASE_ADMIN_DEFAULT_ACL_DISPOSITION=/);
assert.match(dossier, /Production status remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`/);
console.log(`PASS SB-3 authorization dossier freezes fail-closed scope (${hash})`);
