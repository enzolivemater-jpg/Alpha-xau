import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateDataApiDefaultAclPreflight } from '../scripts/evaluate_data_api_default_acl_preflight.mjs';

const sql = readFileSync(new URL('../scripts/data_api_default_acl_preflight.sql', import.meta.url), 'utf8');
assert.match(sql, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/i);
assert.match(sql, /ROLLBACK;/i);
assert.doesNotMatch(
  sql.replace(/^\s*--.*$/gm, ''),
  /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|COPY|CALL)\b/i,
);
console.log('PASS preflight SQL is an explicit read-only repeatable-read transaction');

const frontend = [
  'public.v_market_latest',
  'public.v_news_high_impact',
  'public.v_ai_latest',
  'public.market_ticks',
  'public.news_events',
].map(object_name => ({
  object_name,
  role_name: 'anon',
  privilege_type: 'SELECT',
  object_exists: true,
  relation_kind: object_name.startsWith('public.v_') ? 'v' : 'r',
  owner: 'postgres',
  allowed: true,
}));

const base = {
  contract_version: 'data-api-default-acl-preflight-v1',
  server_version_num: 170006,
  database: 'postgres',
  session_user: 'postgres',
  required_roles: [
    { role_name: 'postgres', exists: true },
    { role_name: 'anon', exists: true },
    { role_name: 'authenticated', exists: true },
    { role_name: 'service_role', exists: true },
    { role_name: 'supabase_admin', exists: false },
  ],
  frontend_privileges: frontend,
  default_acl_app_grants: [{
    owner: 'postgres', schema_name: 'public', object_type: 'TABLES',
    grantee: 'anon', privilege_type: 'SELECT', is_grantable: false,
  }],
};

const ready = evaluateDataApiDefaultAclPreflight(base);
assert.equal(ready.verdict, 'READY_FOR_SCOPED_AUTHORIZATION');
assert.equal(ready.authorization_granted, false);
assert.equal(ready.production_change_performed, false);
assert.equal(ready.postgres_default_grants_targeted_by_sb3.length, 1);
assert.deepEqual(ready.blockers, []);
console.log('PASS postgres-owned target grants do not masquerade as an authorization blocker');

const managed = structuredClone(base);
managed.required_roles.find(item => item.role_name === 'supabase_admin').exists = true;
managed.default_acl_app_grants.push({
  owner: 'supabase_admin', schema_name: 'public', object_type: 'TABLES',
  grantee: 'anon', privilege_type: 'SELECT', is_grantable: false,
});
const heldManaged = evaluateDataApiDefaultAclPreflight(managed);
assert.equal(heldManaged.verdict, 'HOLD');
assert.deepEqual(
  heldManaged.blockers.map(item => item.code),
  ['SUPABASE_ADMIN_DEFAULT_ACL_DISPOSITION_REQUIRED'],
);
console.log('PASS managed-role default grants fail closed');

const implicitManaged = structuredClone(base);
implicitManaged.required_roles.find(item => item.role_name === 'supabase_admin').exists = true;
const heldImplicitManaged = evaluateDataApiDefaultAclPreflight(implicitManaged);
assert.equal(heldImplicitManaged.verdict, 'HOLD');
assert.equal(
  heldImplicitManaged.blockers[0].code,
  'SUPABASE_ADMIN_DEFAULT_ACL_DISPOSITION_REQUIRED',
);
assert.deepEqual(heldImplicitManaged.blockers[0].explicit_app_grants, []);
console.log('PASS managed-role existence alone keeps the implicit function default unresolved');

const regressed = structuredClone(base);
regressed.required_roles.find(item => item.role_name === 'anon').exists = false;
regressed.frontend_privileges[0].allowed = false;
const heldRegression = evaluateDataApiDefaultAclPreflight(regressed);
assert.equal(heldRegression.verdict, 'HOLD');
assert.deepEqual(
  heldRegression.blockers.map(item => item.code),
  ['REQUIRED_ROLE_MISSING', 'FRONTEND_ACL_BASELINE_NOT_PROVEN'],
);
assert.throws(
  () => evaluateDataApiDefaultAclPreflight({ ...base, contract_version: 'unknown' }),
  /unsupported contract_version/,
);
const duplicated = structuredClone(base);
duplicated.frontend_privileges[0] = structuredClone(duplicated.frontend_privileges[1]);
assert.equal(evaluateDataApiDefaultAclPreflight(duplicated).verdict, 'HOLD');
console.log('PASS missing roles, ACL regressions, and contract drift fail closed');
