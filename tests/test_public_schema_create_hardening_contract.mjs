import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../database/migrations/0034_public_schema_create_hardening.sql', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8');
const dossier = readFileSync(new URL('../docs/XAU_V2_PUBLIC_SCHEMA_CREATE_HARDENING.md', import.meta.url), 'utf8');
const hash = createHash('sha256').update(migration).digest('hex');

assert.equal((migration.match(/REVOKE CREATE ON SCHEMA public/g) ?? []).length, 2);
assert.match(migration, /FROM PUBLIC;/);
assert.match(migration, /FROM anon, authenticated, service_role;/);
assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
assert.doesNotMatch(migration, /DEFAULT PRIVILEGES/i);
assert.doesNotMatch(migration, /event_fact|official_source_artifact/i);
console.log('PASS SB-2 payload contains only bounded schema CREATE revocations');

for (const statement of [
  'REVOKE CREATE ON SCHEMA public FROM PUBLIC;',
  'REVOKE CREATE ON SCHEMA public FROM anon, authenticated, service_role;',
  'GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;',
]) assert.ok(schema.includes(statement), `fresh schema missing ${statement}`);
console.log('PASS fresh-install parity preserves application schema usage');

assert.match(dossier, /SB-2 CODE CANDIDATE — NOT LIVE-APPLIED/);
assert.equal(hash, '8ea129a10a5776bcde5e4786fabcacafa0c73295a74d4eb07dcc192fc9d55327');
assert.ok(dossier.includes(hash));
assert.match(dossier, /PUBLIC_SCHEMA_MIGRATION_SHA256=8ea129a10a5776bcde5e4786fabcacafa0c73295a74d4eb07dcc192fc9d55327/);
assert.match(dossier, /APPLY_ONLY_0034=YES/);
assert.match(dossier, /Production status remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`/);
assert.equal(hash.length, 64);
console.log(`PASS SB-2 authorization dossier freezes fail-closed scope (${hash})`);
