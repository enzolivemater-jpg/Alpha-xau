// Static parity between the PostgreSQL enums (schema.sql + migrations) and
// the TypeScript unions whose values the engines write into those columns.
// A value the code can emit but the enum lacks fails the insert at run time;
// for closed sets owned on both sides the two must be equal.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '');

const sql = [read('database/schema.sql'),
  ...readdirSync(new URL('database/migrations/', root)).sort().map((name) => read(`database/migrations/${name}`))]
  .map(stripSqlComments).join('\n');

const enums = new Map();
for (const [, name, body] of sql.matchAll(/CREATE TYPE\s+(?:public\.)?([a-z_]+)\s+AS\s+ENUM\s*\(([^)]*)\)/gi)) {
  const values = [...body.matchAll(/'([^']+)'/g)].map(([, value]) => value);
  const prior = enums.get(name);
  assert.ok(!prior || prior.join() === values.join(), `${name} redefined with different values`);
  enums.set(name, values);
}
for (const [, name, value] of sql.matchAll(/ALTER TYPE\s+(?:public\.)?([a-z_]+)\s+ADD VALUE(?:\s+IF NOT EXISTS)?\s+'([^']+)'/gi)) {
  assert.ok(enums.has(name), `ADD VALUE on unknown enum ${name}`);
  if (!enums.get(name).includes(value)) enums.get(name).push(value);
}

function union(source, typeName) {
  const match = new RegExp(`type ${typeName}\\s*=([^;]+);`).exec(source);
  assert.ok(match, `type ${typeName} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, value]) => value);
}

const ingest = read('backend/ingest.ts');
const committee = read('backend/ai_engine/committee_orchestrator.ts');
const horizons = /HORIZONS:\s*\[([^\]]+)\]/.exec(committee);
assert.ok(horizons, 'CONFIG.HORIZONS not found');

const sorted = (values) => [...values].sort();
const equal = [
  ['risk_verdict_t', union(committee, 'Verdict')],
  ['execution_status_t', union(committee, 'ExecutionStatus')],
  ['committee_event_t', union(committee, 'CommitteeEventType')],
  ['news_action_t', union(ingest, 'NewsAction')],
  ['risk_level_t', union(ingest, 'RiskLevel')],
  ['region_t', union(ingest, 'Region')],
  ['news_category_t', union(ingest, 'NewsCategory')],
  ['direction_t', union(committee, 'Direction')],
  ['horizon_t', [...horizons[1].matchAll(/'([^']+)'/g)].map(([, value]) => value)],
];
for (const [name, values] of equal) {
  assert.ok(enums.has(name), `enum ${name} not found`);
  assert.deepEqual(sorted(values), sorted(enums.get(name)), name);
}
// The news engine classifies into a subset of the stored classes.
for (const value of union(ingest, 'Classification')) assert.ok(enums.get('news_class_t').includes(value), value);
for (const value of union(ingest, 'GoldDirection')) assert.ok(enums.get('direction_t').includes(value), value);
// Prompts ask the model for regime labels the column can store.
let promptLabels = 0;
for (const prompt of ['backend/ai_engine/prompts.ts', 'backend/ai_engine/prompts/portfolio_manager.txt',
  'backend/ai_engine/prompts/macro_analyst.txt']) {
  for (const [, labels] of read(prompt).matchAll(/"(?:market|macro)_regime":\s*"([^"]+)"/g)) {
    for (const label of labels.split('|')) {
      assert.ok(enums.get('market_regime_t').includes(label), `${prompt}: ${label}`);
      promptLabels++;
    }
  }
}
assert.ok(promptLabels >= 32, `regime labels found in prompts: ${promptLabels}`);
console.log(`PASS ${equal.length + 3} TypeScript value sets match their PostgreSQL enums`);
