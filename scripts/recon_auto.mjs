#!/usr/bin/env node
/**
 * RECON-AUTO-1: reconciles explicitly declared cloud and local branches onto an
 * explicitly declared canonical candidate, in a throwaway worktree.
 *
 *   node scripts/recon_auto.mjs --plan plan.json [--repo DIR] [--out DIR] [--work-root DIR]
 *     [--verify inventory,typecheck,full] [--apply] [--recover-stale-lock]
 *
 * The plan names every ref and its exact SHA; nothing is discovered or guessed.
 * For each candidate, in order, on top of the canonical commit (or the previous
 * candidate's result):
 *   - the ref must resolve to the declared SHA, the declared base must be an
 *     ancestor of the candidate and of the current head, and the range must hold
 *     no merge commit;
 *   - a candidate already contained (ancestor, or every commit patch-equivalent)
 *     is ALREADY_INTEGRATED; one that contains the head is a FAST_FORWARD;
 *   - otherwise its pending commits are cherry-picked (-x, committer and date
 *     fixed, so the same inputs give the same commits) in a detached worktree
 *     under --work-root. A textual conflict is aborted and reported; a file both
 *     sides changed that is a contract (backend TS, database, fixtures,
 *     docs/XAU_V2_*.md, workflows) stops integration even if git could merge it.
 * Requested checks (the repository's own CI inventory, typecheck, full suite)
 * then run in that worktree. The result is PASS, CONFLICT or BLOCKED.
 *
 * DRY_RUN by default: no ref is written, the worktree is removed. --apply, on
 * PASS only, creates one new local branch refs/heads/recon/<name>, never
 * overwriting one. There is no push, fetch, merge, rebase or reset, no shell,
 * no network, no secret. A lock (<git-common-dir>/recon-auto.lock, O_EXCL) stops
 * concurrent runs; a lock left by an interrupted run blocks until
 * --recover-stale-lock, which removes only this tool's own worktrees.
 *
 * Exit: 0 PASS, 1 CONFLICT, 2 BLOCKED, 64 usage.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RECON_PLAN_SCHEMA_VERSION = 'xau.recon-auto-plan.v1';
export const RECON_REPORT_SCHEMA_VERSION = 'xau.recon-auto-report.v1';
export const RECON_ALGORITHM_VERSION = 'recon-auto-1.0.0';

/** Every git subcommand this tool can issue. Nothing reaches a remote or moves an existing ref. */
export const ALLOWED_GIT_COMMANDS = Object.freeze([
  'rev-parse', 'cat-file', 'merge-base', 'rev-list', 'cherry', 'diff', 'diff-tree', 'log', 'show',
  'worktree', 'cherry-pick', 'checkout', 'update-ref',
]);
const WORKTREE_SUBCOMMANDS = new Set(['add', 'remove', 'prune', 'list']);

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF = /^refs\/(heads|remotes\/origin)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const INTEGRATION_REF = /^refs\/heads\/recon\/[a-z0-9][a-z0-9._-]{0,63}$/;
const PROTECTED_REF = /^refs\/(heads|remotes\/origin)\/(main|master)$/;
const ORIGINS = new Set(['CLOUD', 'LOCAL']);
const MAX_CANDIDATES = 20;
const PLAN_KEYS = ['candidates', 'canonical', 'integrationBranch', 'schemaVersion'];
const CANONICAL_KEYS = ['name', 'ref', 'sha'];
const CANDIDATE_KEYS = ['base', 'name', 'origin', 'ref', 'sha'];
/** Files whose meaning is a contract: changed on both sides, they stop integration. */
const CONTRACT_PATHS = [/^backend\/.+\.ts$/, /^database\//, /^tests\/fixtures\//, /^docs\/XAU_V2_.+\.md$/, /^\.github\/workflows\//];
/** Shared manifests: a clean textual merge is accepted, then checked by the CI inventory. */
const MANIFEST_PATHS = [/^scripts\/run_ci_tests\.mjs$/];
const VERIFY_STEPS = {
  inventory: ['tests/test_ci_inventory.mjs'],
  typecheck: ['node_modules/typescript/bin/tsc', '--noEmit'],
  full: ['scripts/run_ci_tests.mjs'],
};
const COMMITTER = { GIT_COMMITTER_NAME: 'RECON-AUTO-1', GIT_COMMITTER_EMAIL: 'recon-auto@localhost.invalid' };

const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Key-sorted JSON, so equal values give equal digests whatever the key order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && Object.keys(value).sort().every((key, i) => key === keys[i]);

function validRef(ref) {
  return typeof ref === 'string' && REF.test(ref) && !PROTECTED_REF.test(ref)
    && !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.')
    && !ref.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'));
}

/** The plan, copied field by field, or null. Never throws, runs no command. */
export function validatePlan(raw) {
  try {
    if (!exactKeys(raw, PLAN_KEYS) || raw.schemaVersion !== RECON_PLAN_SCHEMA_VERSION) return null;
    if (typeof raw.integrationBranch !== 'string' || !INTEGRATION_REF.test(raw.integrationBranch)) return null;
    const c = raw.canonical;
    if (!exactKeys(c, CANONICAL_KEYS) || typeof c.name !== 'string' || !NAME.test(c.name) || !validRef(c.ref)
        || typeof c.sha !== 'string' || !SHA.test(c.sha)) return null;
    if (!Array.isArray(raw.candidates) || raw.candidates.length === 0 || raw.candidates.length > MAX_CANDIDATES) return null;
    const candidates = [];
    const names = new Set([c.name]);
    const refs = new Set([c.ref]);
    for (const k of raw.candidates) {
      if (!exactKeys(k, CANDIDATE_KEYS) || typeof k.name !== 'string' || !NAME.test(k.name) || !validRef(k.ref)
          || typeof k.sha !== 'string' || !SHA.test(k.sha) || typeof k.base !== 'string' || !SHA.test(k.base)
          || !ORIGINS.has(k.origin) || names.has(k.name) || refs.has(k.ref)) return null;
      names.add(k.name);
      refs.add(k.ref);
      candidates.push({ name: k.name, ref: k.ref, sha: k.sha, base: k.base, origin: k.origin });
    }
    return {
      schemaVersion: RECON_PLAN_SCHEMA_VERSION,
      canonical: { name: c.name, ref: c.ref, sha: c.sha },
      candidates,
      integrationBranch: raw.integrationBranch,
    };
  } catch {
    return null; // hostile accessors are an invalid plan
  }
}

/** Runs one allowed git command without a shell; every call is recorded. */
export function runGit(ctx, args, { cwd = ctx.repo, env = {}, allowFailure = true } = {}) {
  const [command, sub] = args;
  if (!ALLOWED_GIT_COMMANDS.includes(command)) throw new Error(`git ${command} is not allowed`);
  if (command === 'worktree' && !WORKTREE_SUBCOMMANDS.has(sub)) throw new Error(`git worktree ${sub} is not allowed`);
  if (command === 'update-ref' && !INTEGRATION_REF.test(sub ?? '')) throw new Error(`git update-ref ${sub} is not allowed`);
  ctx.commands.push({ cwd: cwd === ctx.repo ? '.' : path.relative(ctx.workRoot, cwd) || '<work-root>', argv: ['git', ...args] });
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', ...env },
  });
  const out = { status: result.status ?? 128, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
  if (!allowFailure && out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out;
}

function lines(text) {
  return text === '' ? [] : text.split('\n');
}

function isAncestor(ctx, ancestor, descendant) {
  const out = runGit(ctx, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (out.status === 0) return true;
  if (out.status === 1) return false;
  throw new Error(`merge-base failed: ${out.stderr}`);
}

const resolveRef = (ctx, ref) => {
  const out = runGit(ctx, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return out.status === 0 && SHA.test(out.stdout) ? out.stdout : null;
};
const commitExists = (ctx, sha) => runGit(ctx, ['cat-file', '-e', `${sha}^{commit}`]).status === 0;
const changedFiles = (ctx, from, to) => new Set(lines(runGit(ctx, ['diff', '--name-only', '--no-renames', from, to], { allowFailure: false }).stdout));
const commitFiles = (ctx, sha) => lines(runGit(ctx, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '--root', sha], { allowFailure: false }).stdout);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Exclusive run lock; a lock from a dead run is removed only on explicit recovery. */
function acquireLock(ctx, lockPath, recover) {
  const recovery = { removedWorktrees: [] };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fsyncSync(fd);
      closeSync(fd);
      return { ok: true, recovery };
    } catch (error) {
      if (error.code !== 'EEXIST') return { ok: false, reason: 'LOCK_UNAVAILABLE', recovery };
    }
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch { /* unreadable */ }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return { ok: false, reason: 'LOCK_UNREADABLE', recovery };
    if (pidAlive(owner.pid)) return { ok: false, reason: 'LOCK_HELD', recovery };
    if (!recover || attempt > 0) return { ok: false, reason: 'STALE_LOCK', recovery };
    // Recovery: remove only this tool's worktrees under the work root, then the stale lock.
    const listed = lines(runGit(ctx, ['worktree', 'list', '--porcelain'], { allowFailure: false }).stdout)
      .filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
    for (const dir of listed) {
      if (dir.startsWith(ctx.workRoot + path.sep) && path.basename(dir).startsWith('recon-auto-wt-')) {
        runGit(ctx, ['worktree', 'remove', '--force', dir]);
        recovery.removedWorktrees.push(dir);
      }
    }
    runGit(ctx, ['worktree', 'prune']);
    unlinkSync(lockPath);
  }
  return { ok: false, reason: 'STALE_LOCK', recovery };
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export function renderMarkdown(report) {
  const rows = report.candidates.map((c) => `| ${c.name} | ${c.origin} | \`${c.ref}\` | \`${c.declaredSha}\` | ${c.status}${c.detail ? ` (${c.detail})` : ''} | ${c.reasons.join(', ') || '—'} |`);
  const picked = report.candidates.flatMap((c) => c.integratedCommits.map((p) => `- ${c.name}: \`${p.source}\` → \`${p.result}\``));
  return [
    `# RECON-AUTO-1 — ${report.classification} (${report.mode})`,
    '',
    `Schema \`${report.schemaVersion}\`, algorithm \`${report.algorithmVersion}\`, plan \`${report.planDigest ?? 'invalid'}\`.`,
    report.reasons.length ? `Reasons: ${report.reasons.join(', ')}.` : 'Reasons: none.',
    '',
    report.canonical
      ? `Canonical **${report.canonical.name}** \`${report.canonical.ref}\` = \`${report.canonical.declaredSha}\` (resolved \`${report.canonical.resolvedSha ?? 'unresolved'}\`, unchanged: ${report.canonical.unchanged}).`
      : 'Canonical: not evaluated.',
    '',
    '| Candidate | Origin (declared) | Ref | Declared SHA | Status | Reasons |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...(report.drift.length
      ? ['## Plan drift — review required', '', 'These refs moved since the plan was written; nothing was simulated.'
        + ' Review the new commits, then update the plan by hand:', '',
      ...report.drift.map((d) => `- ${d.name} \`${d.ref}\`: declared \`${d.declaredSha}\`, now \`${d.currentSha}\``), '']
      : []),
    `Simulated head: \`${report.result.head ?? 'none'}\`.`,
    ...(picked.length ? ['', 'Cherry-picked:', ...picked] : []),
    ...report.candidates.filter((c) => c.conflictedFiles.length || c.contractOverlap.length || c.manifestOverlap.length)
      .map((c) => `- ${c.name}: conflicts ${c.conflictedFiles.join(', ') || '—'}; contract overlap ${c.contractOverlap.join(', ') || '—'}; manifest overlap ${c.manifestOverlap.join(', ') || '—'}`),
    '',
    'Verification:',
    ...(report.result.verification.length
      ? report.result.verification.map((v) => `- ${v.name}: exit ${v.exitCode} (\`${v.command.join(' ')}\`)${v.stdoutTail.length ? ` — ${v.stdoutTail.at(-1)}` : ''}`)
      : ['- none requested']),
    '',
    `Apply: ${report.apply.outcome}${report.apply.ref ? ` \`${report.apply.ref}\`` : ''}.`,
    `Trust: CI ${report.trust.ci}; candidate origin ${report.trust.candidateOrigin}; result ${report.trust.result}.`,
    '',
    'Guarantees: ' + report.guarantees.join('; ') + '.',
    '',
    `Git commands (${report.commands.length}):`,
    ...report.commands.map((c) => `- [${c.cwd}] \`${c.argv.join(' ')}\``),
    '',
  ].join('\n');
}

/**
 * Runs one reconciliation. Never throws for an expected failure: the report
 * carries the classification and the reasons.
 */
export async function reconcile({
  repo = process.cwd(), plan: rawPlan, outDir = null, workRoot = path.join(process.env.TMPDIR || tmpdir(), 'recon-auto-work'),
  verify = [], apply = false, recoverStaleLock = false, env = process.env,
} = {}) {
  const ctx = { repo: path.resolve(repo), workRoot: path.resolve(workRoot), env, commands: [] };
  const report = {
    schemaVersion: RECON_REPORT_SCHEMA_VERSION,
    algorithmVersion: RECON_ALGORITHM_VERSION,
    mode: apply ? 'APPLY_LOCAL_BRANCH' : 'DRY_RUN',
    classification: 'BLOCKED',
    reasons: [],
    planDigest: null,
    plan: null,
    canonical: null,
    candidates: [],
    /** Declared refs that now point elsewhere: the plan needs a human review and new SHAs. */
    drift: [],
    result: { head: null, verification: [] },
    apply: { outcome: apply ? 'NOT_ATTEMPTED' : 'NOT_REQUESTED', ref: null, sha: null },
    trust: { ci: 'NOT_VERIFIED', candidateOrigin: 'DECLARED_UNVERIFIED', result: 'SIMULATED_LOCAL' },
    guarantees: [
      'no push, fetch, merge, rebase or reset', 'no shell, network, secret or provider call',
      'canonical and candidate refs never written', 'conflicts never resolved automatically',
      'apply only creates a new refs/heads/recon/* branch on PASS',
    ],
    recovery: { removedWorktrees: [] },
    commands: ctx.commands,
    resultDigest: null,
  };
  const finish = () => {
    report.resultDigest = sha256(canonicalJson({
      classification: report.classification, reasons: report.reasons, planDigest: report.planDigest,
      canonical: report.canonical, candidates: report.candidates, head: report.result.head,
      verification: report.result.verification.map((v) => [v.name, v.exitCode]), apply: report.apply.outcome,
    }));
    if (outDir !== null) {
      mkdirSync(outDir, { recursive: true });
      writeAtomic(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      writeAtomic(path.join(outDir, 'report.md'), renderMarkdown(report));
    }
    return report;
  };

  const plan = validatePlan(rawPlan);
  if (plan === null) {
    report.reasons.push('INVALID_PLAN');
    return finish();
  }
  report.plan = plan;
  report.planDigest = sha256(canonicalJson(plan));
  report.apply.ref = apply ? plan.integrationBranch : null;
  const common = runGit(ctx, ['rev-parse', '--git-common-dir']);
  if (common.status !== 0) {
    report.reasons.push('NOT_A_REPOSITORY');
    return finish();
  }
  mkdirSync(ctx.workRoot, { recursive: true });
  const lockPath = path.resolve(ctx.repo, common.stdout, 'recon-auto.lock');
  const lock = acquireLock(ctx, lockPath, recoverStaleLock);
  report.recovery = lock.recovery;
  if (!lock.ok) {
    report.reasons.push(lock.reason);
    return finish();
  }

  let worktree = null;
  try {
    const canonicalSha = resolveRef(ctx, plan.canonical.ref);
    report.canonical = { ...plan.canonical, declaredSha: plan.canonical.sha, resolvedSha: canonicalSha, unchanged: null };
    delete report.canonical.sha;
    if (canonicalSha === null) report.reasons.push('UNKNOWN_REF');
    else if (canonicalSha !== plan.canonical.sha) report.reasons.push('REF_SHA_MISMATCH');

    // Every candidate is checked before anything is simulated.
    for (const k of plan.candidates) {
      const entry = {
        name: k.name, ref: k.ref, origin: k.origin, declaredSha: k.sha, resolvedSha: null, base: k.base,
        status: 'BLOCKED', detail: null, reasons: [], pendingCommits: [], integratedCommits: [],
        conflictedFiles: [], contractOverlap: [], manifestOverlap: [],
      };
      report.candidates.push(entry);
      entry.resolvedSha = resolveRef(ctx, k.ref);
      if (entry.resolvedSha === null) entry.reasons.push('UNKNOWN_REF');
      else if (entry.resolvedSha !== k.sha) entry.reasons.push('REF_SHA_MISMATCH');
      else if (!commitExists(ctx, k.base)) entry.reasons.push('UNKNOWN_BASE');
      else if (!isAncestor(ctx, k.base, k.sha)) entry.reasons.push('BASE_NOT_ANCESTOR');
      else if (runGit(ctx, ['rev-list', '--min-parents=2', `${k.base}..${k.sha}`], { allowFailure: false }).stdout !== '') {
        entry.reasons.push('MERGE_COMMIT_UNSUPPORTED');
      } else {
        entry.status = 'PENDING';
      }
    }
    for (const declared of [{ name: report.canonical.name, ref: report.canonical.ref, declaredSha: report.canonical.declaredSha,
      currentSha: report.canonical.resolvedSha }, ...report.candidates.map((c) => ({ name: c.name, ref: c.ref,
      declaredSha: c.declaredSha, currentSha: c.resolvedSha }))]) {
      if (declared.currentSha !== null && declared.currentSha !== declared.declaredSha) report.drift.push(declared);
    }
    if (report.reasons.length || report.candidates.some((c) => c.status === 'BLOCKED')) {
      report.reasons.push('INPUT_NOT_VERIFIED');
      return finish();
    }

    let head = canonicalSha;
    const ensureWorktree = () => {
      if (worktree !== null) return worktree;
      worktree = path.join(ctx.workRoot, `recon-auto-wt-${report.planDigest.slice(7, 19)}-${process.pid}`);
      runGit(ctx, ['worktree', 'add', '--detach', worktree, head], { allowFailure: false });
      return worktree;
    };
    for (const [index, k] of plan.candidates.entries()) {
      const entry = report.candidates[index];
      if (!isAncestor(ctx, k.base, head)) {
        entry.status = 'BLOCKED';
        entry.reasons.push('BASE_NOT_IN_CANONICAL');
        report.reasons.push('BASE_NOT_IN_CANONICAL');
        return finish();
      }
      if (isAncestor(ctx, k.sha, head)) {
        Object.assign(entry, { status: 'ALREADY_INTEGRATED', detail: 'ANCESTOR' });
        continue;
      }
      const cherry = lines(runGit(ctx, ['cherry', head, k.sha, k.base], { allowFailure: false }).stdout);
      const pending = cherry.filter((line) => line.startsWith('+ ')).map((line) => line.slice(2));
      entry.pendingCommits = pending;
      if (pending.length === 0) {
        Object.assign(entry, { status: 'ALREADY_INTEGRATED', detail: 'PATCH_EQUIVALENT' });
        continue;
      }
      if (isAncestor(ctx, head, k.sha)) {
        Object.assign(entry, { status: 'FAST_FORWARD', detail: null });
        head = k.sha;
        if (worktree !== null) runGit(ctx, ['checkout', '-q', '--detach', head], { cwd: worktree, allowFailure: false });
        continue;
      }
      // Both sides moved: shared contracts stop integration; shared manifests are noted.
      const ours = changedFiles(ctx, k.base, head);
      const theirs = new Set(pending.flatMap((sha) => commitFiles(ctx, sha)));
      const overlap = [...theirs].filter((file) => ours.has(file)).sort();
      entry.contractOverlap = overlap.filter((file) => CONTRACT_PATHS.some((re) => re.test(file)));
      entry.manifestOverlap = overlap.filter((file) => MANIFEST_PATHS.some((re) => re.test(file)));
      if (entry.contractOverlap.length) {
        Object.assign(entry, { status: 'CONFLICT', reasons: ['CONTRACT_OVERLAP'] });
        report.reasons.push('CONTRACT_OVERLAP');
        report.classification = 'CONFLICT';
        return finish();
      }
      const wt = ensureWorktree();
      for (const sha of pending) {
        const date = runGit(ctx, ['log', '-1', '--format=%cd', '--date=raw', sha], { allowFailure: false }).stdout;
        const picked = runGit(ctx, ['cherry-pick', '-x', sha], { cwd: wt, env: { ...COMMITTER, GIT_COMMITTER_DATE: date } });
        if (picked.status !== 0) {
          const unmerged = lines(runGit(ctx, ['diff', '--name-only', '--diff-filter=U'], { cwd: wt }).stdout).sort();
          runGit(ctx, ['cherry-pick', '--abort'], { cwd: wt });
          if (unmerged.length === 0 && /empty/i.test(picked.stderr + picked.stdout)) {
            entry.integratedCommits.push({ source: sha, result: null });
            continue; // the change is already present
          }
          Object.assign(entry, { status: 'CONFLICT', reasons: ['TEXT_CONFLICT'], conflictedFiles: unmerged });
          report.reasons.push('TEXT_CONFLICT');
          report.classification = 'CONFLICT';
          return finish();
        }
        entry.integratedCommits.push({ source: sha, result: runGit(ctx, ['rev-parse', 'HEAD'], { cwd: wt, allowFailure: false }).stdout });
      }
      entry.status = 'CHERRY_PICKED';
      head = runGit(ctx, ['rev-parse', 'HEAD'], { cwd: wt, allowFailure: false }).stdout;
    }
    report.result.head = head;

    for (const name of verify) {
      const wt = ensureWorktree();
      const modules = path.join(ctx.repo, 'node_modules');
      if (!existsSync(modules)) {
        report.reasons.push('VERIFY_ENV_MISSING');
        return finish();
      }
      if (!existsSync(path.join(wt, 'node_modules'))) symlinkSync(modules, path.join(wt, 'node_modules'));
      const command = [process.execPath, ...VERIFY_STEPS[name]];
      const run = spawnSync(command[0], command.slice(1), { cwd: wt, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: ctx.env });
      const tail = (text) => (text ?? '').trim().split('\n').filter(Boolean).slice(-6);
      report.result.verification.push({
        name, command: ['node', ...VERIFY_STEPS[name]], exitCode: run.status ?? 128,
        stdoutTail: tail(run.stdout), stderrTail: tail(run.stderr),
      });
      if (run.status !== 0) {
        report.reasons.push(`VERIFY_FAILED_${name.toUpperCase()}`);
        return finish();
      }
    }

    report.classification = 'PASS';
    if (apply) {
      const existing = resolveRef(ctx, plan.integrationBranch);
      if (existing === head) {
        report.apply = { outcome: 'UNCHANGED', ref: plan.integrationBranch, sha: head };
      } else if (existing !== null) {
        report.apply = { outcome: 'BLOCKED', ref: plan.integrationBranch, sha: existing };
        report.classification = 'BLOCKED';
        report.reasons.push('INTEGRATION_BRANCH_EXISTS');
      } else {
        runGit(ctx, ['update-ref', plan.integrationBranch, head, '0'.repeat(40)], { allowFailure: false });
        report.apply = { outcome: 'CREATED', ref: plan.integrationBranch, sha: head };
      }
    }
    return finish();
  } catch (error) {
    report.classification = 'BLOCKED';
    report.reasons.push('GIT_ERROR');
    report.error = String(error.message).slice(0, 500);
    return finish();
  } finally {
    if (worktree !== null) {
      runGit(ctx, ['worktree', 'remove', '--force', worktree]);
      runGit(ctx, ['worktree', 'prune']);
    }
    if (report.canonical && report.canonical.resolvedSha !== null) {
      report.canonical.unchanged = resolveRef(ctx, report.canonical.ref) === report.canonical.resolvedSha;
    }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    if (outDir !== null) finish();
  }
}

export function parseArgs(argv) {
  const options = { repo: process.cwd(), planFile: null, outDir: null, workRoot: undefined, verify: [], apply: false, recoverStaleLock: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--recover-stale-lock') options.recoverStaleLock = true;
    else if (['--repo', '--plan', '--out', '--work-root', '--verify'].includes(flag) && value !== undefined) {
      i += 1;
      if (flag === '--repo') options.repo = path.resolve(value);
      if (flag === '--plan') options.planFile = path.resolve(value);
      if (flag === '--out') options.outDir = path.resolve(value);
      if (flag === '--work-root') options.workRoot = path.resolve(value);
      if (flag === '--verify') {
        const steps = value.split(',');
        if (!steps.every((step) => Object.hasOwn(VERIFY_STEPS, step))) return null;
        options.verify = steps;
      }
    } else {
      return null;
    }
  }
  return options.planFile === null ? null : options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    process.stderr.write('usage: node scripts/recon_auto.mjs --plan plan.json [--repo DIR] [--out DIR] [--work-root DIR]'
      + ' [--verify inventory,typecheck,full] [--apply] [--recover-stale-lock]\n');
    return 64;
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(options.planFile, 'utf8'));
  } catch {
    plan = null; // reported as INVALID_PLAN
  }
  const outDir = options.outDir ?? path.join(process.env.TMPDIR || tmpdir(), 'recon-auto-report');
  const report = await reconcile({ ...options, plan, outDir, ...(options.workRoot ? {} : { workRoot: undefined }) });
  process.stdout.write(`${report.classification} (${report.mode})${report.reasons.length ? `: ${report.reasons.join(', ')}` : ''}`
    + ` — head ${report.result.head ?? 'none'} — report ${path.join(outDir, 'report.md')}\n`);
  return { PASS: 0, CONFLICT: 1, BLOCKED: 2 }[report.classification];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
