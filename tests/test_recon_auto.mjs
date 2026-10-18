// RECON-AUTO-1 (scripts/recon_auto.mjs): reconciliation of explicitly declared
// cloud and local branches onto an explicitly declared canonical candidate, in a
// throwaway worktree. Every case runs on a temporary git repository built here;
// nothing touches this repository's refs, and no network command exists.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/recon_auto.mjs', import.meta.url));
const recon = await import(SCRIPT);
const ROOT = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'recon-auto-test-'));
const ENV = {
  ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
let clock = 1_790_000_000;
const git = (cwd, ...args) => {
  clock += 60;
  const date = `${clock} +0000`;
  const out = spawnSync('git', ['-c', 'init.defaultBranch=trunk', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8', env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
let n = 0;
/** A fresh repository with one base commit; returns helpers. */
function repo() {
  const dir = path.join(ROOT, `repo-${++n}`);
  mkdirSync(dir);
  git(dir, 'init', '-q');
  const write = (file, text) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text); };
  const commit = (message, files) => {
    for (const [file, text] of Object.entries(files)) write(file, text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const base = commit('base', { 'a.txt': 'a1\na2\na3\n', 'scripts/run_ci_tests.mjs': 'const TEST_FILES = [\n  \'x\',\n  \'y\',\n  \'z\',\n];\n',
    'docs/XAU_V2_SAMPLE_CONTRACT.md': 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n' });
  const branch = (name, from) => git(dir, 'branch', name, from);
  const checkout = (name) => git(dir, 'checkout', '-q', name);
  const sha = (ref) => git(dir, 'rev-parse', ref);
  return { dir, base, commit, branch, checkout, sha, git: (...a) => git(dir, ...a) };
}
const plan = (canonical, candidates, extra = {}) => ({
  schemaVersion: 'xau.recon-auto-plan.v1',
  canonical,
  candidates,
  integrationBranch: 'refs/heads/recon/test',
  ...extra,
});
const ref = (r, name, refName = `refs/heads/${name}`) => ({ name, ref: refName, sha: r.sha(refName) });
const cand = (r, name, base, origin = 'LOCAL') => ({ ...ref(r, name), base, origin });
const run = (r, p, options = {}) => recon.reconcile({ repo: r.dir, plan: p, outDir: path.join(ROOT, `out-${++n}`),
  workRoot: path.join(ROOT, 'work'), env: ENV, ...options });
const listWorktrees = (r) => r.git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

try {
  // --- 1. Linear advance: the candidate extends the canonical commit.
  let r = repo();
  r.branch('canon', r.base);
  r.commit('c2', { 'b.txt': 'b\n' });
  r.branch('cand', 'HEAD');
  let report = await run(r, plan(ref(r, 'canon'), [cand(r, 'cand', r.base)]));
  assert.equal(report.classification, 'PASS');
  assert.equal(report.candidates[0].status, 'FAST_FORWARD');
  assert.equal(report.result.head, r.sha('cand'));
  assert.equal(report.mode, 'DRY_RUN');
  assert.equal(report.canonical.unchanged, true);
  assert.equal(listWorktrees(r), 1, 'no worktree left behind');
  console.log('PASS linear advance is a fast-forward, nothing written');

  // --- 2. Divergent branch, clean: cherry-picked in a throwaway worktree, deterministic, idempotent.
  r = repo();
  r.commit('h1', { 'h.txt': 'h\n' });
  r.branch('canon', 'HEAD');
  r.git('checkout', '-q', '-b', 'cand', r.base);
  r.commit('k1', { 'k.txt': 'k\n', 'scripts/run_ci_tests.mjs': 'const TEST_FILES = [\n  \'x\',\n  \'y\',\n  \'z\',\n  \'k\',\n];\n' });
  r.git('checkout', '-q', 'canon');
  r.commit('h2', { 'scripts/run_ci_tests.mjs': 'const TEST_FILES = [\n  \'h\',\n  \'x\',\n  \'y\',\n  \'z\',\n];\n' });
  const before = { canon: r.sha('canon'), cand: r.sha('cand') };
  const p = plan(ref(r, 'canon'), [cand(r, 'cand', r.base, 'CLOUD')]);
  const first = await run(r, p);
  assert.equal(first.classification, 'PASS', JSON.stringify(first.candidates));
  assert.equal(first.candidates[0].status, 'CHERRY_PICKED');
  assert.deepEqual(first.candidates[0].manifestOverlap, ['scripts/run_ci_tests.mjs'], 'shared manifest reported');
  assert.equal(r.git('cat-file', '-p', `${first.result.head}:scripts/run_ci_tests.mjs`),
    "const TEST_FILES = [\n  'h',\n  'x',\n  'y',\n  'z',\n  'k',\n];");
  assert.match(r.git('log', '-1', '--format=%B', first.result.head), /cherry picked from commit/);
  const second = await run(r, p);
  assert.equal(second.result.head, first.result.head, 'same inputs, same simulated commit');
  assert.equal(second.resultDigest, first.resultDigest, 'idempotent report');
  assert.deepEqual({ canon: r.sha('canon'), cand: r.sha('cand') }, before, 'branches untouched');
  assert.equal(first.trust.candidateOrigin, 'DECLARED_UNVERIFIED');
  assert.equal(first.trust.ci, 'NOT_VERIFIED');
  console.log('PASS divergent branch: clean cherry-pick in a throwaway worktree, deterministic and idempotent');

  // --- 3. Apply: a new local integration branch only; rerun is a no-op; a moved branch blocks.
  const applied = await run(r, p, { apply: true });
  assert.equal(applied.apply.outcome, 'CREATED');
  assert.equal(r.sha('refs/heads/recon/test'), first.result.head);
  assert.equal((await run(r, p, { apply: true })).apply.outcome, 'UNCHANGED');
  r.git('update-ref', 'refs/heads/recon/test', r.base);
  const moved = await run(r, p, { apply: true });
  assert.equal(moved.classification, 'BLOCKED');
  assert.ok(moved.reasons.includes('INTEGRATION_BRANCH_EXISTS'));
  assert.equal(r.sha('refs/heads/recon/test'), r.base, 'an existing branch is never overwritten');
  assert.deepEqual({ canon: r.sha('canon'), cand: r.sha('cand') }, before);
  console.log('PASS apply creates only a new local branch, is idempotent, never overwrites');

  // --- 4. Already present: ancestor, and patch-equivalent (cherry-picked earlier).
  r = repo();
  const c2 = r.commit('c2', { 'b.txt': 'b\n' });
  r.branch('cand', 'HEAD');
  r.commit('c3', { 'c.txt': 'c\n' });
  r.branch('canon', 'HEAD');
  report = await run(r, plan(ref(r, 'canon'), [cand(r, 'cand', r.base)]));
  assert.equal(report.candidates[0].status, 'ALREADY_INTEGRATED');
  assert.equal(report.candidates[0].detail, 'ANCESTOR');
  assert.equal(report.result.head, r.sha('canon'));
  r = repo();
  r.git('checkout', '-q', '-b', 'cand');
  const picked = r.commit('k1', { 'k.txt': 'k\n' });
  r.git('checkout', '-q', '-b', 'canon', r.base);
  r.commit('h1', { 'h.txt': 'h\n' });
  r.git('cherry-pick', picked);
  report = await run(r, plan(ref(r, 'canon'), [cand(r, 'cand', r.base)]));
  assert.equal(report.candidates[0].status, 'ALREADY_INTEGRATED');
  assert.equal(report.candidates[0].detail, 'PATCH_EQUIVALENT');
  void c2;
  console.log('PASS commits already present (ancestor or patch-equivalent) are detected, not re-applied');

  // --- 5. Real conflict: same line on both sides; nothing kept, even with --apply.
  r = repo();
  r.git('checkout', '-q', '-b', 'cand');
  r.commit('k1', { 'a.txt': 'a1\nCLOUD\na3\n' });
  r.git('checkout', '-q', '-b', 'canon', r.base);
  r.commit('h1', { 'a.txt': 'a1\nLOCAL\na3\n' });
  const canonBefore = r.sha('canon');
  report = await run(r, plan(ref(r, 'canon'), [cand(r, 'cand', r.base)]), { apply: true });
  assert.equal(report.classification, 'CONFLICT');
  assert.equal(report.candidates[0].status, 'CONFLICT');
  assert.deepEqual(report.candidates[0].conflictedFiles, ['a.txt']);
  assert.equal(report.apply.outcome, 'NOT_ATTEMPTED');
  assert.equal(r.sha('canon'), canonBefore);
  assert.throws(() => r.sha('refs/heads/recon/test'));
  assert.equal(listWorktrees(r), 1, 'aborted worktree removed');
  assert.equal(r.git('status', '--porcelain'), '', 'main checkout untouched');
  console.log('PASS a real conflict is reported with its files, aborted, and nothing is written');

  // --- 6. Contract overlap: both sides change the same contract file, even on different lines.
  r = repo();
  r.git('checkout', '-q', '-b', 'cand');
  r.commit('k1', { 'docs/XAU_V2_SAMPLE_CONTRACT.md': 'line1\nCLOUD\nline3\nline4\nline5\nline6\nline7\nline8\n' });
  r.git('checkout', '-q', '-b', 'canon', r.base);
  r.commit('h1', { 'docs/XAU_V2_SAMPLE_CONTRACT.md': 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nLOCAL\n' });
  report = await run(r, plan(ref(r, 'canon'), [cand(r, 'cand', r.base)]));
  assert.equal(report.classification, 'CONFLICT');
  assert.equal(report.candidates[0].status, 'CONFLICT');
  assert.ok(report.candidates[0].reasons.includes('CONTRACT_OVERLAP'));
  assert.deepEqual(report.candidates[0].contractOverlap, ['docs/XAU_V2_SAMPLE_CONTRACT.md']);
  console.log('PASS a shared contract file stops integration even when git could merge it');

  // --- 7. Unknown reference, SHA mismatch, base not an ancestor, merge commit, stacked candidates.
  r = repo();
  r.branch('canon', r.base);
  r.commit('k1', { 'k.txt': 'k\n' });
  r.branch('cand', 'HEAD');
  const good = cand(r, 'cand', r.base);
  const blocked = async (candidate, reason, canonical = ref(r, 'canon')) => {
    const out = await run(r, plan(canonical, [candidate]));
    assert.equal(out.classification, 'BLOCKED', reason);
    assert.ok(out.reasons.includes(reason) || out.candidates.some((c) => c.reasons.includes(reason)), `${reason}: ${JSON.stringify(out.reasons)}`);
    return out;
  };
  await blocked({ ...good, ref: 'refs/heads/missing' }, 'UNKNOWN_REF');
  const drifted = await blocked({ ...good, sha: r.base }, 'REF_SHA_MISMATCH');
  // 1.1.0: the drift is reviewed (ADVANCED: new commits listed) and a plan is proposed, never written over the plan.
  assert.deepEqual(drifted.drift, [{ name: 'cand', ref: good.ref, declaredSha: r.base, currentSha: good.sha, kind: 'ADVANCED',
    newCommits: [{ sha: good.sha, subject: 'k1' }], commitsTruncated: false, changedFiles: ['k.txt'], filesTruncated: false,
    contractFilesChanged: [], mergeCommits: 0 }], 'drift reported and reviewed');
  assert.equal(drifted.result.head, null, 'nothing simulated on drift');
  assert.deepEqual(drifted.proposedPlan, plan(ref(r, 'canon'), [good]), 'proposed plan carries the current SHA');
  {
    const out = path.join(ROOT, 'drift-out');
    const driftPlan = plan(ref(r, 'canon'), [{ ...good, sha: r.base }]);
    const again = await recon.reconcile({ repo: r.dir, plan: driftPlan, outDir: out, workRoot: path.join(ROOT, 'work'), env: ENV });
    assert.equal(again.classification, 'BLOCKED');
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'proposed-plan.json'), 'utf8')), again.proposedPlan);
    assert.match(readFileSync(path.join(out, 'report.md'), 'utf8'), /\*\*ADVANCED\*\* \(1 new commit\(s\), 1 file\(s\)\)[\s\S]*k1[\s\S]*Proposed plan: `proposed-plan.json`/);
    assert.deepEqual(driftPlan.candidates[0].sha, r.base, 'the input plan object is not modified');
    // The proposed plan is valid and, run as is, passes: one review replaces finding and copying SHAs by hand.
    assert.notEqual(recon.validatePlan(again.proposedPlan), null);
    assert.equal((await run(r, again.proposedPlan)).classification, 'PASS');
  }
  await blocked(good, 'REF_SHA_MISMATCH', { ...ref(r, 'canon'), sha: good.sha });
  await blocked({ ...good, base: good.sha.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) }, 'UNKNOWN_BASE');
  r.git('checkout', '-q', '-b', 'side', r.base);
  const side = r.commit('side', { 's.txt': 's\n' });
  await blocked({ ...good, base: side }, 'BASE_NOT_ANCESTOR');
  // A declared commit that is no longer in the history (rebase / force-push) or unknown: no proposed plan.
  const rewritten = await blocked({ ...good, sha: side }, 'REF_SHA_MISMATCH');
  assert.equal(rewritten.drift[0].kind, 'REWRITTEN');
  assert.deepEqual(rewritten.drift[0].newCommits, []);
  assert.equal(rewritten.proposedPlan, null);
  const unknown = await blocked({ ...good, sha: '0123456789abcdef0123456789abcdef01234567' }, 'REF_SHA_MISMATCH');
  assert.equal(unknown.drift[0].kind, 'DECLARED_UNKNOWN');
  assert.equal(unknown.proposedPlan, null);
  // Mixed drift (one ADVANCED, one REWRITTEN): still no proposed plan, both reviewed.
  const mixed = await run(r, plan({ ...ref(r, 'canon'), sha: side }, [{ ...good, sha: r.base }]));
  assert.deepEqual(mixed.drift.map((d) => d.kind), ['REWRITTEN', 'ADVANCED']);
  assert.equal(mixed.proposedPlan, null);
  r.git('checkout', '-q', '-b', 'merged', 'cand');
  r.git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
  await blocked(cand(r, 'merged', r.base), 'MERGE_COMMIT_UNSUPPORTED');
  // Stacked: the second candidate builds on the first.
  r.git('checkout', '-q', '-b', 'cand2', 'cand');
  r.commit('k2', { 'k2.txt': 'k2\n' });
  report = await run(r, plan(ref(r, 'canon'), [good, cand(r, 'cand2', good.sha)]));
  assert.equal(report.classification, 'PASS');
  assert.deepEqual(report.candidates.map((c) => c.status), ['FAST_FORWARD', 'FAST_FORWARD']);
  assert.equal(report.result.head, r.sha('cand2'));
  console.log('PASS unknown refs, SHA mismatches, foreign bases and merge commits block; stacked candidates chain');

  // --- 7b. 1.1.0 --init-plan: named refs only, current SHAs, stacked bases; the proposal runs as is.
  {
    const proposed = recon.initPlan({ repo: r.dir, env: ENV, integrationBranch: 'refs/heads/recon/test',
      canonical: { name: 'canon', ref: 'refs/heads/canon' },
      candidates: [{ name: 'cand', ref: 'refs/heads/cand', origin: 'LOCAL' }, { name: 'cand2', ref: 'refs/heads/cand2', origin: 'CLOUD' }] });
    assert.deepEqual(proposed.problems, []);
    assert.deepEqual(proposed.plan, plan(ref(r, 'canon'), [good, cand(r, 'cand2', good.sha, 'CLOUD')]), 'merge-base, then the stacked parent');
    assert.equal((await run(r, proposed.plan)).classification, 'PASS');
    const side2 = recon.initPlan({ repo: r.dir, env: ENV, integrationBranch: 'refs/heads/recon/test',
      canonical: { name: 'canon', ref: 'refs/heads/canon' }, candidates: [{ name: 'side', ref: 'refs/heads/side', origin: 'LOCAL' }] });
    assert.equal(side2.plan.candidates[0].base, r.base, 'an unrelated branch is based on its merge-base with the canonical');
    for (const [name, args, problem] of [
      ['unknown ref', { canonical: { name: 'canon', ref: 'refs/heads/canon' }, candidates: [{ name: 'x', ref: 'refs/heads/nope', origin: 'LOCAL' }] }, /UNKNOWN_REF/],
      ['protected ref', { canonical: { name: 'canon', ref: 'refs/heads/main' }, candidates: [{ name: 'cand', ref: 'refs/heads/cand', origin: 'LOCAL' }] }, /INVALID_REF/],
      ['bad origin', { canonical: { name: 'canon', ref: 'refs/heads/canon' }, candidates: [{ name: 'cand', ref: 'refs/heads/cand', origin: 'MAYBE' }] }, /INVALID_PLAN/],
      ['bad branch', { canonical: { name: 'canon', ref: 'refs/heads/canon' }, candidates: [{ name: 'cand', ref: 'refs/heads/cand', origin: 'LOCAL' }], integrationBranch: 'refs/heads/main' }, /INVALID_PLAN/],
    ]) {
      const out = recon.initPlan({ repo: r.dir, env: ENV, integrationBranch: 'refs/heads/recon/test', ...args });
      assert.equal(out.plan, null, name);
      assert.match(out.problems.join(), problem, name);
    }
    // CLI: written create-only, never over an existing file.
    const outPlan = path.join(ROOT, 'init-plan.json');
    const init = (...extra) => spawnSync(process.execPath, [SCRIPT, '--init-plan', '--repo', r.dir, '--canonical', 'canon=refs/heads/canon',
      '--candidate', 'cand=refs/heads/cand@LOCAL', '--integration-branch', 'refs/heads/recon/test', '--out-plan', outPlan, ...extra],
    { encoding: 'utf8', env: ENV });
    assert.equal(init().status, 0);
    assert.deepEqual(JSON.parse(readFileSync(outPlan, 'utf8')), plan(ref(r, 'canon'), [good]));
    const again = init();
    assert.equal(again.status, 2);
    assert.match(again.stderr, /EEXIST/);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--init-plan', '--canonical', 'canon=refs/heads/canon'], { encoding: 'utf8' }).status, 64);
  }
  console.log('PASS --init-plan proposes a valid plan from named refs (current SHAs, stacked bases), create-only');

  // --- 8. Malicious or malformed plans are refused before any git command.
  const okPlan = plan(ref(r, 'canon'), [good]);
  for (const [label, mutate] of [
    ['option injection in ref', (p) => { p.candidates[0].ref = '--upload-pack=touch /tmp/x'; }],
    ['parent traversal', (p) => { p.candidates[0].ref = 'refs/heads/../../etc'; }],
    ['reflog syntax', (p) => { p.candidates[0].ref = 'refs/heads/cand@{1}'; }],
    ['non-local namespace', (p) => { p.candidates[0].ref = 'refs/tags/v1'; }],
    ['short sha', (p) => { p.candidates[0].sha = good.sha.slice(0, 7); }],
    ['uppercase sha', (p) => { p.candidates[0].sha = good.sha.toUpperCase(); }],
    ['shell in name', (p) => { p.candidates[0].name = 'x;rm -rf /'; }],
    ['unknown origin', (p) => { p.candidates[0].origin = 'TRUSTED'; }],
    ['extra key', (p) => { p.candidates[0].autoResolve = true; }],
    ['extra plan key', (p) => { p.push = true; }],
    ['wrong schema', (p) => { p.schemaVersion = 'xau.recon-auto-plan.v0'; }],
    ['integration onto main', (p) => { p.integrationBranch = 'refs/heads/main'; }],
    ['integration outside recon/', (p) => { p.integrationBranch = 'refs/heads/feat/x'; }],
    ['canonical is main', (p) => { p.canonical.ref = 'refs/heads/main'; }],
    ['duplicate candidate', (p) => { p.candidates.push({ ...p.candidates[0] }); }],
    ['no candidate', (p) => { p.candidates = []; }],
    ['candidates not a list', (p) => { p.candidates = { 0: good }; }],
    ['getter that throws', (p) => { Object.defineProperty(p.candidates[0], 'name', { get() { throw new Error('x'); }, enumerable: true }); }],
  ]) {
    const p = structuredClone(okPlan);
    mutate(p);
    const out = await run(r, p);
    assert.equal(out.classification, 'BLOCKED', label);
    assert.ok(out.reasons.includes('INVALID_PLAN'), `${label}: ${out.reasons}`);
    assert.deepEqual(out.commands, [], `${label}: no git command ran`);
  }
  assert.equal((await run(r, null)).reasons[0], 'INVALID_PLAN');
  // The committed RC tracking plan is a valid plan on remote-tracking refs only.
  const rcPlan = JSON.parse(readFileSync(new URL('../docs/recon/plan-rc-offline.json', import.meta.url), 'utf8'));
  assert.notEqual(recon.validatePlan(rcPlan), null);
  assert.ok([rcPlan.canonical, ...rcPlan.candidates].every((x) => x.ref.startsWith('refs/remotes/origin/')));
  console.log('PASS malicious or malformed plans are refused before any git command');

  // --- 9. Interruption and resume: a held or stale lock blocks; recovery clears only its own leftovers.
  const lockPath = path.join(r.dir, '.git', 'recon-auto.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 'x' }));
  let out = await run(r, okPlan, { recoverStaleLock: true });
  assert.equal(out.classification, 'BLOCKED');
  assert.ok(out.reasons.includes('LOCK_HELD'), 'a live owner is never displaced');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(lockPath, JSON.stringify({ pid: dead, startedAt: 'x' }));
  const leftover = path.join(ROOT, 'work', 'recon-auto-wt-leftover');
  r.git('worktree', 'add', '-q', '--detach', leftover, r.base);
  out = await run(r, okPlan);
  assert.equal(out.classification, 'BLOCKED');
  assert.ok(out.reasons.includes('STALE_LOCK'), 'an interrupted run is not resumed silently');
  assert.ok(existsSync(lockPath));
  out = await run(r, okPlan, { recoverStaleLock: true });
  assert.equal(out.classification, 'PASS', JSON.stringify(out.reasons));
  assert.ok(out.recovery.removedWorktrees.includes(leftover));
  assert.equal(existsSync(lockPath), false, 'lock released');
  assert.equal(listWorktrees(r), 1);
  const outsider = path.join(ROOT, 'not-ours');
  r.git('worktree', 'add', '-q', '--detach', outsider, r.base);
  writeFileSync(lockPath, JSON.stringify({ pid: dead, startedAt: 'x' }));
  out = await run(r, okPlan, { recoverStaleLock: true });
  assert.equal(out.classification, 'PASS');
  assert.ok(existsSync(outsider), 'a worktree outside the work root is never removed');
  console.log('PASS interruption: held and stale locks block; recovery removes only its own leftovers, then resumes');

  // --- 10. Reports: JSON and Markdown written; the CLI exits by classification.
  const outDir = path.join(ROOT, 'cli-out');
  const planFile = path.join(ROOT, 'plan.json');
  writeFileSync(planFile, JSON.stringify(okPlan));
  const cli = spawnSync(process.execPath, [SCRIPT, '--repo', r.dir, '--plan', planFile, '--out', outDir,
    '--work-root', path.join(ROOT, 'work')], { encoding: 'utf8', env: ENV });
  assert.equal(cli.status, 0, cli.stderr);
  const json = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8'));
  assert.equal(json.schemaVersion, 'xau.recon-auto-report.v1');
  assert.equal(json.classification, 'PASS');
  assert.match(readFileSync(path.join(outDir, 'report.md'), 'utf8'), /^# RECON-AUTO-1 — PASS \(DRY_RUN\)/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--repo', r.dir, '--plan', path.join(ROOT, 'missing.json'), '--out', outDir],
    { encoding: 'utf8', env: ENV }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8', env: ENV }).status, 64);
  console.log('PASS the CLI writes report.json and report.md and exits 0 PASS / 1 CONFLICT / 2 BLOCKED / 64 usage');

  // --- 11. Safety by construction: no network or remote-writing git command can be issued.
  const source = readFileSync(SCRIPT, 'utf8');
  for (const sub of ['push', 'fetch', 'pull', 'clone', 'remote', 'merge', 'rebase', 'reset']) {
    assert.ok(!recon.ALLOWED_GIT_COMMANDS.includes(sub), sub);
  }
  assert.doesNotMatch(source, /shell:\s*true|execSync|exec\(/, 'no shell');
  assert.throws(() => recon.runGit({ repo: r.dir, env: ENV, commands: [] }, ['push', 'origin', 'x']), /not allowed/);
  console.log('PASS no push, fetch, merge, rebase or reset is reachable; git runs without a shell');
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
