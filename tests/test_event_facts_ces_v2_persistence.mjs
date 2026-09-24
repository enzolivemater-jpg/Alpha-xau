import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL(
  '../database/migrations/0029_event_facts_ces_v2_persistence.sql', import.meta.url,
), 'utf8');

assert.match(migration, /^BEGIN;/m);
assert.match(migration, /COMMIT;\s*$/);
assert.match(migration, /fn_event_is_supported_canonical_state\s*\(/);
assert.match(migration, /IMMUTABLE[\s\S]*STRICT[\s\S]*PARALLEL SAFE/);
assert.match(migration, /SECURITY INVOKER/);
assert.match(migration, /SET search_path = ''/);
assert.match(migration, /p_schema_version = 1[\s\S]*NOT \(p_state \? 'facts'\)/);
assert.match(migration, /p_schema_version <> 2/);
assert.match(migration, /\{facts,release_family\}' <> 'US_CPI'/);
assert.match(migration, /jsonb_array_length\(p_state #> '\{facts,metrics\}'\) <> 4/);

for (const code of [
  'CPI_CORE_MOM', 'CPI_CORE_YOY', 'CPI_HEADLINE_MOM', 'CPI_HEADLINE_YOY',
]) {
  assert.match(migration, new RegExp(`'${code}'`));
}
assert.match(migration, /PERCENT_CHANGE_MOM/);
assert.match(migration, /PERCENT_CHANGE_YOY/);
assert.match(migration, /#>> '\{actual,state\}' <> 'KNOWN'/);
assert.match(migration, /#>> '\{consensus,state\}' <> 'UNKNOWN'/);
assert.match(migration, /#> '\{consensus,value\}' <> 'null'::jsonb/);
assert.match(migration, /jsonb_array_length\(v_metric -> 'prior_periods'\) <> 0/);
assert.match(migration, /v_actual_value = '-0'/);
assert.match(migration, /chk_event_versions_supported_canonical_state/);
assert.match(migration, /CHECK \(public\.fn_event_is_supported_canonical_state\(/);
assert.match(migration, /\) NOT VALID;/);
assert.match(migration, /VALIDATE CONSTRAINT chk_event_versions_supported_canonical_state/);
assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/);
assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/);

assert.doesNotMatch(migration, /CREATE\s+TABLE/i);
assert.doesNotMatch(migration, /INSERT\s+INTO/i);
assert.doesNotMatch(migration, /UPDATE\s+public\./i);
assert.doesNotMatch(migration, /DELETE\s+FROM/i);
assert.doesNotMatch(migration, /worker\.ts|wrangler|cron|fetch\s*\(|news_events/i);
assert.doesNotMatch(migration, /event_impact|gold_transmission/i);

console.log('PASS EF-3 is additive, schema-only, US_CPI-only, and fail-closed');
