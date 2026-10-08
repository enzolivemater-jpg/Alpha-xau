#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONTRACT_VERSION = 'data-api-default-acl-preflight-v1';
const REQUIRED_ROLES = ['postgres', 'anon', 'authenticated', 'service_role'];
const REQUIRED_FRONTEND = [
  'anon:SELECT:public.v_market_latest',
  'anon:SELECT:public.v_news_high_impact',
  'anon:SELECT:public.v_ai_latest',
  'anon:SELECT:public.market_ticks',
  'anon:SELECT:public.news_events',
].sort();

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export function evaluateDataApiDefaultAclPreflight(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('preflight snapshot must be a JSON object');
  }
  if (snapshot.contract_version !== CONTRACT_VERSION) {
    throw new Error(`unsupported contract_version: ${snapshot.contract_version ?? '<missing>'}`);
  }

  const roles = assertArray(snapshot.required_roles, 'required_roles');
  const frontend = assertArray(snapshot.frontend_privileges, 'frontend_privileges');
  const defaults = assertArray(snapshot.default_acl_app_grants, 'default_acl_app_grants');
  const roleMap = new Map(roles.map(item => [item.role_name, item.exists === true]));
  const blockers = [];

  const missingRoles = REQUIRED_ROLES.filter(role => roleMap.get(role) !== true);
  if (missingRoles.length > 0) {
    blockers.push({ code: 'REQUIRED_ROLE_MISSING', detail: missingRoles });
  }

  const frontendKeys = frontend.map(
    item => `${item.role_name}:${item.privilege_type}:${item.object_name}`,
  );
  const missingFrontend = REQUIRED_FRONTEND.filter(key => !frontendKeys.includes(key));
  const duplicateFrontend = sortedUnique(
    frontendKeys.filter((key, index) => frontendKeys.indexOf(key) !== index),
  );
  const unexpectedFrontend = sortedUnique(
    frontendKeys.filter(key => !REQUIRED_FRONTEND.includes(key)),
  );
  const deniedFrontend = frontend
    .filter(item => item.object_exists !== true || item.allowed !== true)
    .map(item => `${item.role_name}:${item.privilege_type}:${item.object_name}`);
  if (missingFrontend.length > 0 || duplicateFrontend.length > 0
      || unexpectedFrontend.length > 0 || deniedFrontend.length > 0) {
    blockers.push({
      code: 'FRONTEND_ACL_BASELINE_NOT_PROVEN',
      missing: missingFrontend,
      duplicate: duplicateFrontend,
      unexpected: unexpectedFrontend,
      denied_or_absent: sortedUnique(deniedFrontend),
    });
  }

  const managedRoleGrants = defaults.filter(item => item.owner === 'supabase_admin');
  if (roleMap.get('supabase_admin') === true || managedRoleGrants.length > 0) {
    blockers.push({
      code: 'SUPABASE_ADMIN_DEFAULT_ACL_DISPOSITION_REQUIRED',
      role_exists: roleMap.get('supabase_admin') === true,
      explicit_app_grants: managedRoleGrants,
      implicit_public_function_default_observable_in_pg_default_acl: false,
    });
  }

  const postgresTargetedGrants = defaults.filter(item => item.owner === 'postgres');
  return {
    contract_version: CONTRACT_VERSION,
    verdict: blockers.length === 0 ? 'READY_FOR_SCOPED_AUTHORIZATION' : 'HOLD',
    authorization_granted: false,
    production_change_performed: false,
    database: snapshot.database ?? null,
    session_user: snapshot.session_user ?? null,
    server_version_num: snapshot.server_version_num ?? null,
    postgres_default_grants_targeted_by_sb3: postgresTargetedGrants,
    blockers,
  };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node scripts/evaluate_data_api_default_acl_preflight.mjs <snapshot.json>');
    process.exitCode = 2;
  } else {
    try {
      const result = evaluateDataApiDefaultAclPreflight(
        JSON.parse(readFileSync(inputPath, 'utf8')),
      );
      console.log(JSON.stringify(result, null, 2));
      if (result.verdict !== 'READY_FOR_SCOPED_AUTHORIZATION') process.exitCode = 1;
    } catch (error) {
      console.error(`INVALID_PREFLIGHT ${error.message}`);
      process.exitCode = 2;
    }
  }
}
