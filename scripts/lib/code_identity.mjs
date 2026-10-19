/**
 * Which code a local terminal runs: the checkout's commit, branch and whether
 * tracked files differ from it. Read once, with read-only git commands and no
 * shell; without git (or outside a repository) every field is null.
 */

import { execFileSync } from 'node:child_process';

const git = (root, args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return null;
  }
};

/** `{ commit, branch, dirty }`: full SHA or null, branch name or null (detached), true when tracked files changed. */
export function codeIdentity(root) {
  const commit = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) return { commit: null, branch: null, dirty: null };
  const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']) || null;
  const status = git(root, ['status', '--porcelain', '--untracked-files=no']);
  return { commit, branch, dirty: status === null ? null : status !== '' };
}

/** One line for people: `d969986 (feat/x)`, `+ modifications non commitées` when dirty, `inconnu` without git. */
export function describeCode(code) {
  if (!code || typeof code.commit !== 'string') return 'inconnu';
  return `${code.commit.slice(0, 7)}${code.branch ? ` (${code.branch})` : ' (détaché)'}${code.dirty ? ' + modifications non commitées' : ''}`;
}
