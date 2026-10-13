#!/usr/bin/env node
/**
 * CHAIN-0 local simulation: runs the V2 decision chain on a JSON input and
 * prints the per-stage trace, integrity verdict and replay digest.
 *
 *   node scripts/run_decision_chain_dry_run.mjs [input.json]
 *
 * The input file has the golden-fixture shape `{ knowledgeCutoff, input }`;
 * without an argument the golden fixture is used. Nothing is persisted and
 * no network, provider or broker is reached.
 *
 * Exit codes: 0 consistent, 2 integrity violated, 1 usage or input error.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
export const GOLDEN_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'decision_chain_dry_run_baseline.json');

/**
 * Transpiles `backend/decision_chain/dry_run.ts` and its relative import
 * closure into a temporary directory and imports it.
 */
export async function loadDecisionChainModule() {
  const temp = mkdtempSync(path.join(tmpdir(), 'decision-chain-dry-run-'));
  try {
    const pending = ['decision_chain/dry_run.ts'];
    const seen = new Set();
    while (pending.length > 0) {
      const relative = pending.pop();
      if (seen.has(relative)) continue;
      seen.add(relative);
      const source = readFileSync(path.join(BACKEND, relative), 'utf8');
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      // Only runtime imports survive transpilation; type-only imports are erased.
      const rewritten = output.replaceAll(/(from\s+|import\s*\(\s*)(['"])(\.\.?\/[^'"]+)\.js\2/g,
        (_match, prefix, quote, specifier) => {
          pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${specifier}.ts`)));
          return `${prefix}${quote}${specifier}.mjs${quote}`;
        });
      const destination = path.join(temp, relative.replace(/\.ts$/, '.mjs'));
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, rewritten, 'utf8');
    }
    return await import(pathToFileURL(path.join(temp, 'decision_chain', 'dry_run.mjs')).href);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main(argv) {
  if (argv.length > 1) {
    process.stderr.write('usage: node scripts/run_decision_chain_dry_run.mjs [input.json]\n');
    return 1;
  }
  let document;
  try {
    document = JSON.parse(readFileSync(argv[0] ?? GOLDEN_FIXTURE, 'utf8'));
  } catch (error) {
    process.stderr.write(`input error: ${error.message}\n`);
    return 1;
  }
  if (document === null || typeof document !== 'object' || typeof document.knowledgeCutoff !== 'string'
      || document.input === null || typeof document.input !== 'object') {
    process.stderr.write('input error: expected { knowledgeCutoff: string, input: object }\n');
    return 1;
  }

  const chain = await loadDecisionChainModule();
  let result;
  try {
    result = chain.runDecisionChainDryRun(document.input, document.knowledgeCutoff);
  } catch (error) {
    process.stderr.write(`input error: ${error.message}\n`);
    return 1;
  }
  const summary = {
    schemaVersion: result.schemaVersion,
    algorithmVersion: result.algorithmVersion,
    mode: result.mode,
    chainState: result.chainState,
    execution: result.execution,
    knowledgeCutoff: result.knowledgeCutoff,
    integrity: result.integrity,
    violations: result.violations,
    inputFindings: result.inputFindings,
    digest: await chain.computeDecisionChainDigest(result),
    trace: result.trace.map(({ stage, state, reasonCodes }) => ({ stage, state, reasonCodes })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return result.integrity === 'CONSISTENT' ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
