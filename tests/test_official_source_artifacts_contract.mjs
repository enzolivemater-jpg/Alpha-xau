import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../database/migrations/0030_official_source_artifacts.sql', import.meta.url),
  'utf8',
);

assert.match(migration, /content_bytes\s+BYTEA NOT NULL/);
assert.match(migration, /content_sha256\s+TEXT GENERATED ALWAYS AS/);
assert.match(migration, /observation_hash\s+TEXT GENERATED ALWAYS AS/);
assert.match(migration, /BEFORE UPDATE OR DELETE/);
assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /REVOKE ALL ON public\.official_source_artifacts FROM PUBLIC, anon, authenticated, service_role/);
assert.match(migration, /GRANT SELECT, INSERT ON public\.official_source_artifacts TO service_role/);
assert.doesNotMatch(migration, /\bfacts\s+(?:JSON|JSONB)|\bprojection\s+(?:JSON|JSONB)|release_identity\s+/i);
assert.match(migration, /octet_length\(content_bytes\) BETWEEN 1 AND 10485760/);

console.log('PASS official artifacts retain bounded exact bytes outside canonical state');
