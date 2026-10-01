#!/usr/bin/env node

/**
 * Capture and compare read-only PostgreSQL recovery manifests.
 *
 * Credentials are read exclusively through libpq environment variables. The
 * script never accepts or prints a database URL. Capture runs with
 * default_transaction_read_only=on and records counts and catalog metadata,
 * never row contents.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FORMAT_VERSION = 1;
const PRODUCTION_PROJECT_REF = 'ejvwmjgfvhsslqiydwpz';
const SAFE_REF = /^[a-z0-9]{20}$/;
const SAFE_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

function fail(message) {
  console.error(`RECOVERY MANIFEST STOP: ${message}`);
  process.exit(1);
}

function requireBinary(name) {
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore', timeout: 5000 });
  } catch {
    fail(`${name} is required and was not found`);
  }
}

function psql(query) {
  const pgoptions = [
    process.env.PGOPTIONS ?? '',
    '-c default_transaction_read_only=on',
    '-c statement_timeout=60000',
    '-c lock_timeout=5000',
  ].filter(Boolean).join(' ');
  try {
    return execFileSync('psql', [
      '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query,
    ], {
      encoding: 'utf8',
      env: { ...process.env, PGOPTIONS: pgoptions },
      timeout: 70000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    fail(`read-only database query failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function jsonQuery(query) {
  const raw = psql(query);
  try {
    return JSON.parse(raw || 'null');
  } catch {
    fail('database returned invalid JSON');
  }
}

function quoteIdent(identifier) {
  if (!SAFE_IDENTIFIER.test(identifier)) fail('unsafe database identifier returned by catalog');
  return `"${identifier.replaceAll('"', '""')}"`;
}

function captureGuard() {
  const role = process.env.RECOVERY_MANIFEST_ROLE;
  const projectRef = process.env.RECOVERY_PROJECT_REF;
  if (!['source', 'target'].includes(role)) {
    fail('RECOVERY_MANIFEST_ROLE must be source or target');
  }
  if (!SAFE_REF.test(projectRef ?? '')) {
    fail('RECOVERY_PROJECT_REF must be a 20-character lowercase project ref');
  }

  const localHost = ['127.0.0.1', 'localhost'].includes(process.env.PGHOST);
  const localTest = process.env.RECOVERY_ALLOW_LOCAL_TEST === 'YES' && localHost;
  if (role === 'source') {
    if (projectRef !== PRODUCTION_PROJECT_REF) {
      fail('source project ref does not match the frozen production project');
    }
    if (process.env.RECOVERY_ALLOW_PRODUCTION_READ_ONLY !== 'YES' && !localTest) {
      fail('source capture requires RECOVERY_ALLOW_PRODUCTION_READ_ONLY=YES');
    }
  } else {
    if (projectRef === PRODUCTION_PROJECT_REF) {
      fail('production can never be a recovery rehearsal target');
    }
    if (process.env.RECOVERY_REHEARSAL !== 'YES') {
      fail('target capture requires RECOVERY_REHEARSAL=YES');
    }
  }
  return { role, projectRef };
}

const catalogQueries = {
  relations: `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'name',c.relname,'kind',c.relkind,
      'persistence',c.relpersistence,'rls',c.relrowsecurity,
      'force_rls',c.relforcerowsecurity,'options',coalesce(to_jsonb(c.reloptions),'[]'::jsonb)
    ) ORDER BY n.nspname,c.relname),'[]'::jsonb)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')`,
  columns: `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',a.attname,'position',a.attnum,
      'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
      'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
      'identity',a.attidentity,'generated',a.attgenerated
    ) ORDER BY n.nspname,c.relname,a.attnum),'[]'::jsonb)
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND a.attnum>0 AND NOT a.attisdropped`,
  functions: `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'name',p.proname,
      'args',pg_catalog.pg_get_function_identity_arguments(p.oid),
      'result',pg_catalog.pg_get_function_result(p.oid),'language',l.lanname,
      'volatility',p.provolatile,'strict',p.proisstrict,'security_definer',p.prosecdef,
      'parallel',p.proparallel,'config',coalesce(to_jsonb(p.proconfig),'[]'::jsonb),
      'definition_md5',md5(pg_catalog.pg_get_functiondef(p.oid))
    ) ORDER BY n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)),'[]'::jsonb)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public'`,
  constraints: `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',x.conname,'type',x.contype,
      'definition',pg_catalog.pg_get_constraintdef(x.oid,true)
    ) ORDER BY n.nspname,c.relname,x.conname),'[]'::jsonb)
    FROM pg_catalog.pg_constraint x JOIN pg_catalog.pg_class c ON c.oid=x.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`,
  indexes: `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'table',t.relname,'name',i.relname,
      'definition',pg_catalog.pg_get_indexdef(i.oid)
    ) ORDER BY n.nspname,t.relname,i.relname),'[]'::jsonb)
    FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid=x.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'`,
  policies: `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',schemaname,'table',tablename,'name',policyname,'permissive',permissive,
      'roles',roles,'command',cmd,'using',qual,'check',with_check
    ) ORDER BY schemaname,tablename,policyname),'[]'::jsonb) FROM pg_catalog.pg_policies
    WHERE schemaname='public'`,
  triggers: `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'table',c.relname,'name',t.tgname,
      'definition',pg_catalog.pg_get_triggerdef(t.oid,true)
    ) ORDER BY n.nspname,c.relname,t.tgname),'[]'::jsonb)
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal`,
  views: `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',schemaname,'name',viewname,'definition_md5',md5(definition)
    ) ORDER BY schemaname,viewname),'[]'::jsonb) FROM pg_catalog.pg_views
    WHERE schemaname='public'`,
  enums: `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'type',t.typname,'label',e.enumlabel,'position',e.enumsortorder
    ) ORDER BY n.nspname,t.typname,e.enumsortorder),'[]'::jsonb)
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    JOIN pg_catalog.pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='public'`,
  extensions: `SELECT coalesce(jsonb_agg(e.extname ORDER BY e.extname),'[]'::jsonb)
    FROM pg_catalog.pg_extension e`,
};

function capture() {
  const { role, projectRef } = captureGuard();
  requireBinary('psql');

  const identity = jsonQuery(`SELECT jsonb_build_object(
    'database',current_database(),'user',current_user,
    'server_version_num',current_setting('server_version_num'),
    'transaction_read_only',current_setting('transaction_read_only'))`);
  if (identity.transaction_read_only !== 'on') fail('read-only session guard was not applied');

  const tables = jsonQuery(`SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'name',c.relname) ORDER BY n.nspname,c.relname),'[]'::jsonb)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','supabase_migrations') AND c.relkind IN ('r','p')
      AND NOT c.relispartition`);
  const rowCounts = {};
  for (const table of tables) {
    const key = `${table.schema}.${table.name}`;
    rowCounts[key] = Number(psql(`SELECT count(*) FROM ${quoteIdent(table.schema)}.${quoteIdent(table.name)}`));
    if (!Number.isSafeInteger(rowCounts[key]) || rowCounts[key] < 0) fail(`invalid row count for ${key}`);
  }

  const catalog = Object.fromEntries(
    Object.entries(catalogQueries).map(([key, query]) => [key, jsonQuery(query)]),
  );
  const migrationHistory = jsonQuery(`SELECT CASE
      WHEN pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NULL THEN '[]'::jsonb
      ELSE (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'version',version,'name',coalesce(name,'')) ORDER BY version),'[]'::jsonb)
        FROM supabase_migrations.schema_migrations) END`);

  process.stdout.write(`${JSON.stringify({
    formatVersion: FORMAT_VERSION,
    capturedAt: new Date().toISOString(),
    role,
    projectRef,
    identity,
    migrationHistory,
    rowCounts,
    catalog,
  }, null, 2)}\n`);
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read manifest ${path}: ${error.message}`);
  }
}

function compare(sourcePath, targetPath) {
  const source = readManifest(sourcePath);
  const target = readManifest(targetPath);
  assert.equal(source.formatVersion, FORMAT_VERSION, 'unsupported source manifest format');
  assert.equal(target.formatVersion, FORMAT_VERSION, 'unsupported target manifest format');
  assert.equal(source.role, 'source', 'first manifest must have source role');
  assert.equal(source.projectRef, PRODUCTION_PROJECT_REF, 'source manifest is not production');
  assert.equal(target.role, 'target', 'second manifest must have target role');
  assert.notEqual(target.projectRef, PRODUCTION_PROJECT_REF, 'target manifest points to production');
  assert.equal(
    String(target.identity.server_version_num).slice(0, 2),
    String(source.identity.server_version_num).slice(0, 2),
    'PostgreSQL major versions differ',
  );

  const checks = ['migrationHistory', 'rowCounts', 'catalog'];
  for (const key of checks) {
    try {
      assert.deepEqual(target[key], source[key]);
    } catch (error) {
      fail(`${key} mismatch: ${error.message}`);
    }
  }
  console.log(JSON.stringify({
    status: 'PASS',
    sourceProjectRef: source.projectRef,
    targetProjectRef: target.projectRef,
    sourceCapturedAt: source.capturedAt,
    targetCapturedAt: target.capturedAt,
    verifiedTableCount: Object.keys(source.rowCounts).length,
    verifiedMigrationCount: source.migrationHistory.length,
  }, null, 2));
}

const [command, ...args] = process.argv.slice(2);
if (command === 'capture' && args.length === 0) capture();
else if (command === 'compare' && args.length === 2) compare(args[0], args[1]);
else fail('usage: recovery_manifest.mjs capture | compare <source.json> <target.json>');

