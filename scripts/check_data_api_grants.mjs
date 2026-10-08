#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_API_DEFAULTS_MARKER = '20261008094133';
export const LAST_LEGACY_MIGRATION = 34;

const APP_ROLE = /\b(?:PUBLIC|anon|authenticated|service_role)\b/i;
const IDENT = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';
const PUBLIC_SCHEMA = '(?:"public"|public)';

function unquoteIdentifier(value) {
  return value.startsWith('"')
    ? value.slice(1, -1).replaceAll('""', '"')
    : value.toLowerCase();
}

function blankChar(char) {
  return char === '\n' || char === '\r' ? char : ' ';
}

export function splitTopLevelSql(sql) {
  const statements = [];
  let current = '';
  let state = 'normal';
  let dollarTag = '';
  let blockDepth = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] ?? '';

    if (state === 'line-comment') {
      current += blankChar(char);
      if (char === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      current += blankChar(char);
      if (char === '/' && next === '*') {
        current += ' ';
        blockDepth += 1;
        index += 1;
      } else if (char === '*' && next === '/') {
        current += ' ';
        blockDepth -= 1;
        index += 1;
        if (blockDepth === 0) state = 'normal';
      }
      continue;
    }
    if (state === 'single-quote') {
      current += blankChar(char);
      if (char === "'" && next === "'") {
        current += ' ';
        index += 1;
      } else if (char === '\\' && next) {
        current += blankChar(next);
        index += 1;
      } else if (char === "'") {
        state = 'normal';
      }
      continue;
    }
    if (state === 'double-quote') {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (char === '"') {
        state = 'normal';
      }
      continue;
    }
    if (state === 'dollar-quote') {
      if (sql.startsWith(dollarTag, index)) {
        current += ' '.repeat(dollarTag.length);
        index += dollarTag.length - 1;
        state = 'normal';
      } else {
        current += blankChar(char);
      }
      continue;
    }

    if (char === '-' && next === '-') {
      current += '  ';
      index += 1;
      state = 'line-comment';
      continue;
    }
    if (char === '/' && next === '*') {
      current += '  ';
      index += 1;
      state = 'block-comment';
      blockDepth = 1;
      continue;
    }
    if (char === "'") {
      current += ' ';
      state = 'single-quote';
      continue;
    }
    if (char === '"') {
      current += char;
      state = 'double-quote';
      continue;
    }
    if (char === '$') {
      const match = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarTag = match[0];
        current += ' '.repeat(dollarTag.length);
        index += dollarTag.length - 1;
        state = 'dollar-quote';
        continue;
      }
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.replace(/\s+/g, ' ').trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (state !== 'normal' && state !== 'line-comment') {
    throw new Error(`unterminated SQL ${state}`);
  }
  if (current.trim()) statements.push(current.replace(/\s+/g, ' ').trim());
  return statements;
}

function createdObject(statement) {
  const patterns = [
    ['table', new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${PUBLIC_SCHEMA}\\s*\\.\\s*(${IDENT})(?=\\s|\\(|$)`, 'i')],
    ['foreign table', new RegExp(`^CREATE\\s+FOREIGN\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${PUBLIC_SCHEMA}\\s*\\.\\s*(${IDENT})(?=\\s|\\(|$)`, 'i')],
    ['view', new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+${PUBLIC_SCHEMA}\\s*\\.\\s*(${IDENT})(?=\\s|$)`, 'i')],
    ['materialized view', new RegExp(`^CREATE\\s+MATERIALIZED\\s+VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${PUBLIC_SCHEMA}\\s*\\.\\s*(${IDENT})(?=\\s|$)`, 'i')],
    ['sequence', new RegExp(`^CREATE\\s+SEQUENCE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${PUBLIC_SCHEMA}\\s*\\.\\s*(${IDENT})(?=\\s|$)`, 'i')],
    ['routine', new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\s+${PUBLIC_SCHEMA}\\s*\\.\\s*(${IDENT})\\s*\\(`, 'i')],
  ];
  for (const [kind, pattern] of patterns) {
    const match = statement.match(pattern);
    if (match) return { kind, name: unquoteIdentifier(match[1]) };
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function targetsApplicationRole(statement) {
  const granteeClause = statement.match(/\b(?:TO|FROM)\s+([\s\S]+)$/i);
  return granteeClause !== null && APP_ROLE.test(granteeClause[1]);
}

function hasExplicitAcl(statements, object) {
  const rawName = escapeRegExp(object.name);
  const quotedName = escapeRegExp(`"${object.name.replaceAll('"', '""')}"`);
  const reference = new RegExp(
    `\\bON\\s+(?:(?:TABLE|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE)\\s+)?${PUBLIC_SCHEMA}\\s*\\.\\s*(?:${rawName}|${quotedName})(?=\\s|\\(|,|$)`,
    'i',
  );
  return statements.some(statement =>
    /^(?:GRANT|REVOKE)\b/i.test(statement)
    && reference.test(statement)
    && targetsApplicationRole(statement));
}

export function auditMigrationSql(sql, filename = '<memory>') {
  let statements;
  try {
    statements = splitTopLevelSql(sql);
  } catch (error) {
    return [`${filename}: ${error.message}`];
  }
  const errors = [];

  for (const statement of statements) {
    if (/^ALTER\s+DEFAULT\s+PRIVILEGES\b[\s\S]*\bGRANT\b/i.test(statement)
        && targetsApplicationRole(statement)) {
      errors.push(`${filename}: broad application-role default GRANT is forbidden after SB-3`);
    }
    if (/^GRANT\b[\s\S]*\bON\s+ALL\s+(?:TABLES|FUNCTIONS|ROUTINES|SEQUENCES)\s+IN\s+SCHEMA\s+(?:"public"|public)\b/i.test(statement)
        && targetsApplicationRole(statement)) {
      errors.push(`${filename}: schema-wide application-role GRANT is forbidden after SB-3`);
    }
  }

  const objects = statements.map(createdObject).filter(Boolean);
  for (const statement of statements) {
    const object = createdObject(statement);
    if (object?.kind === 'table'
        && /\b(?:smallserial|serial|bigserial)\b|\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i.test(statement)) {
      errors.push(`${filename}: public table ${object.name} uses an implicit sequence; create and grant a named sequence explicitly`);
    }
  }
  for (const object of objects) {
    if (!hasExplicitAcl(statements, object)) {
      errors.push(`${filename}: public ${object.kind} ${object.name} has no explicit application-role GRANT/REVOKE`);
    }
  }
  return [...new Set(errors)];
}

export function auditMigrationDirectory(directory) {
  const resolvedDirectory = directory instanceof URL ? fileURLToPath(directory) : directory;
  const errors = [];
  const files = readdirSync(resolvedDirectory).filter(name => name.endsWith('.sql')).sort();
  for (const filename of files) {
    const match = filename.match(/^(\d+)_/);
    if (!match) {
      errors.push(`${filename}: migration filename must start with a numeric version`);
      continue;
    }
    const version = match[1];
    if (version.length === 4) {
      if (Number(version) > LAST_LEGACY_MIGRATION) {
        errors.push(`${filename}: legacy four-digit versions ended at 0034; generate a timestamped Supabase migration`);
      }
      continue;
    }
    if (version.length !== 14) {
      errors.push(`${filename}: migration version must use the 14-digit Supabase CLI timestamp format`);
      continue;
    }
    if (version <= DATA_API_DEFAULTS_MARKER) continue;
    errors.push(...auditMigrationSql(readFileSync(path.join(resolvedDirectory, filename), 'utf8'), filename));
  }
  return errors;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repoRoot, 'database', 'migrations');
  const errors = auditMigrationDirectory(directory);
  if (errors.length > 0) {
    for (const error of errors) console.error(`FAIL ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${directory}: future Data API objects have explicit ACL dispositions`);
  }
}
