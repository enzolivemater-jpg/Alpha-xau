// INFRA-AGENT-1 — agent workflow documents and the inactive Claude Code
// permission proposal stay consistent and fail closed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const proposalPath = 'docs/XAU_V2_AGENT_CLAUDE_SETTINGS_PROPOSAL.json';
const workflow = read('docs/XAU_V2_AGENT_WORKFLOW.md');
const claudeMd = read('CLAUDE.md');
const template = read('.github/pull_request_template.md');
const qualityGate = read('.github/workflows/quality-gate.yml');
const proposal = JSON.parse(read(proposalPath));
const { permissions, sandbox } = proposal;

assert.equal(existsSync(new URL('../.claude/settings.json', import.meta.url)), false,
  'the proposal must not be active as project settings in this repository');
assert.match(workflow, /^Status: `PROPOSAL — NOT ACTIVE`$/m);
console.log('PASS permission proposal is stored outside .claude/ and marked not active');

assert.equal(permissions.defaultMode, 'default');
assert.equal(permissions.disableBypassPermissionsMode, 'disable');
assert.equal(permissions.disableAutoMode, 'disable');
assert.doesNotMatch(JSON.stringify(proposal), /"(?:bypassPermissions|auto|dontAsk|acceptEdits)"/);
console.log('PASS Auto mode and bypassPermissions stay disabled');

const deny = new Set(permissions.deny);
for (const rule of ['Bash(gh pr merge*)', 'Bash(gh pr review *)', 'Bash(gh api *)',
  'Bash(gh secret *)', 'Bash(gh workflow *)', 'Bash(supabase *)', 'Bash(npx supabase *)',
  'Bash(wrangler *)', 'Bash(npx wrangler *)', 'Bash(npm run deploy*)',
  'Bash(git push * main)', 'Bash(git push * HEAD:main)', 'Bash(git push --force*)',
  'Read(~/.supabase/**)', 'Read(~/.config/.wrangler/**)', 'Read(~/**/.env)']) {
  assert.ok(deny.has(rule), `deny must contain ${rule}`);
}
const risky = /merge|deploy|supabase|wrangler|git push|gh api|gh secret|gh auth|psql|docker|rm /;
for (const rule of permissions.allow) {
  assert.doesNotMatch(rule, risky, `allow rule is too broad: ${rule}`);
  assert.ok(!deny.has(rule), `rule both allowed and denied: ${rule}`);
}
for (const rule of ['Bash(git push *)', 'Bash(gh pr create *)', 'Edit(/.github/**)',
  'Edit(/.claude/**)', 'Edit(/database/**)']) {
  assert.ok(permissions.ask.includes(rule), `ask must contain ${rule}`);
}
console.log('PASS merge, deploy, production CLIs and credential reads are denied; pushes ask');

assert.equal(sandbox.enabled, true);
assert.equal(sandbox.failIfUnavailable, true);
assert.equal(sandbox.allowUnsandboxedCommands, false);
assert.equal(sandbox.credentials, undefined,
  'sandbox.credentials is ignored in project settings; it belongs in user scope');
for (const entry of sandbox.excludedCommands) {
  assert.match(entry, / \*$/, `excludedCommands entry must end with " *": ${entry}`);
}
for (const path of ['~/.supabase', '~/.config/.wrangler', '~/**/.env']) {
  assert.ok(sandbox.filesystem.denyRead.includes(path), `denyRead must contain ${path}`);
}
assert.deepEqual(sandbox.network.allowedDomains, ['registry.npmjs.org']);
console.log('PASS sandbox proposal is strict and uses only project-honored keys');

const jobsBlock = qualityGate.slice(qualityGate.search(/^jobs:$/m));
const jobs = [...jobsBlock.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map(m => m[1]);
assert.ok(jobs.length >= 10, 'quality-gate jobs must be discoverable');
for (const job of jobs) {
  assert.match(workflow, new RegExp(`\`${job}\``), `required-check proposal must list ${job}`);
}
console.log(`PASS main-protection proposal lists all ${jobs.length} Quality Gate jobs`);

assert.match(claudeMd, /docs\/XAU_V2_AGENT_WORKFLOW\.md/);
assert.match(claudeMd, /## Definition of DONE/);
assert.match(claudeMd, /guidance, not a security\s+control/);
assert.match(workflow, /not a control/);
for (const section of ['## Mission', '## Changes', '## Tests executed', '## Evidence',
  '## Risks', '## Limits and not verified', '## Decisions requiring human approval',
  '## Commit(s)']) {
  assert.ok(template.includes(section), `PR template must contain ${section}`);
}
console.log('PASS CLAUDE.md, workflow and mission report template are linked and complete');

const secretLike = /sk-ant-|ghp_[A-Za-z0-9]|github_pat_|eyJ[A-Za-z0-9_-]{10,}\.|sbp_[A-Za-z0-9]|postgres(?:ql)?:\/\/[^\s`]*@/;
for (const [name, text] of [[proposalPath, read(proposalPath)], ['CLAUDE.md', claudeMd],
  ['docs/XAU_V2_AGENT_WORKFLOW.md', workflow], ['.github/pull_request_template.md', template]]) {
  assert.doesNotMatch(text, secretLike, `${name} must not contain secret-like values`);
}
console.log('PASS agent workflow files contain no secret-like values');
