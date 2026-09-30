import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../database/migrations/0033_security_baseline_hardening.sql', import.meta.url),
  'utf8',
);
const dossier = readFileSync(
  new URL('../docs/XAU_V2_SECURITY_BASELINE_TRIAGE.md', import.meta.url),
  'utf8',
);

assert.equal(
  createHash('sha256').update(migration).digest('hex'),
  '451c0edf04a3c0c82bbd66f23f52e7aaebae33eb34770519b9e759a629f54355',
);
assert.ok(dossier.includes('451c0edf04a3c0c82bbd66f23f52e7aaebae33eb34770519b9e759a629f54355'));
console.log('PASS candidate migration SHA-256 is frozen in the dossier');

for (const view of [
  'v_news_high_impact',
  'v_news_actionable',
  'v_news_pending_notification',
  'v_engine_last_run',
  'v_ai_latest',
  'v_market_latest',
]) {
  assert.match(migration, new RegExp(`ALTER VIEW public\\.${view}\\s+SET \\(security_invoker = true\\)`));
}
console.log('PASS exactly the six advisor-flagged views become security invoker');

for (const fn of [
  'fn_set_updated_at',
  'fn_news_classify',
  'fn_check_scenario_probability_sum',
  'fn_news_score',
  'fn_news_articles_append_only',
]) {
  assert.ok(migration.includes(`public.${fn}`), `missing function hardening: ${fn}`);
}
assert.equal((migration.match(/search_path\s*=\s*''/g) ?? []).length, 5);
assert.match(migration, /public\.fn_news_score\(/);
assert.match(migration, /public\.ai_scenarios AS s/);
assert.match(migration, /'public\.horizon_t'::pg_catalog\.regtype/);
console.log('PASS all five functions use an empty path and qualified application objects');

assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
assert.doesNotMatch(migration, /event_fact|official_source_artifact/i);
assert.doesNotMatch(migration, /REVOKE\s+CREATE\s+ON\s+SCHEMA/i);
assert.match(dossier, /broad `CREATE` privilege is recorded as a separate P1/);
assert.match(dossier, /APPLY_ONLY_0033=YES/);
assert.match(dossier, /EVENT_FACTS_0029_0032_AUTHORIZED=NO/);
assert.match(dossier, /Production status remains `HOLD — NOT AUTHORIZED FOR LIVE EXECUTION`/);
console.log('PASS SB-1 is bounded, non-DML, and cannot imply Event Facts authority');
