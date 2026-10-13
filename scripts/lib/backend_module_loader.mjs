/**
 * Loads a backend TypeScript module and its relative import closure for
 * local scripts and deterministic tests, without a build step.
 *
 * Each reachable `backend/**.ts` file is transpiled into a temporary
 * directory with relative `.js` specifiers rewritten to `.mjs`; type-only
 * imports are erased by the transpiler and are not followed. The directory
 * is removed once the module graph has been imported.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend');
const RELATIVE_SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"]+)\.js\2/g;

/** @param {string} entry path relative to `backend/`, e.g. `regime_engine/contract.ts` */
export async function loadBackendModule(entry) {
  const temp = mkdtempSync(path.join(tmpdir(), 'backend-module-'));
  try {
    const pending = [path.posix.normalize(entry)];
    const seen = new Set();
    while (pending.length > 0) {
      const relative = pending.pop();
      if (seen.has(relative)) continue;
      if (relative.startsWith('..')) throw new Error(`import escapes backend/: ${relative}`);
      seen.add(relative);
      const source = readFileSync(path.join(BACKEND, relative), 'utf8');
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const rewritten = output.replaceAll(RELATIVE_SPECIFIER, (_match, prefix, quote, specifier) => {
        pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${specifier}.ts`)));
        return `${prefix}${quote}${specifier}.mjs${quote}`;
      });
      const destination = path.join(temp, relative.replace(/\.ts$/, '.mjs'));
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, rewritten, 'utf8');
    }
    return await import(pathToFileURL(path.join(temp, entry.replace(/\.ts$/, '.mjs'))).href);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
