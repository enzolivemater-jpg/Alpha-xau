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

// acceptEdits is the only non-default mode, and only for the isolated agent
// distribution documented in the workflow.
assert.equal(permissions.defaultMode, 'acceptEdits');
assert.equal(permissions.disableBypassPermissionsMode, 'disable');
assert.equal(permissions.disableAutoMode, 'disable');
assert.doesNotMatch(JSON.stringify(proposal), /"(?:bypassPermissions|auto|dontAsk)"/);
assert.match(workflow, /`acceptEdits` scope:\*\* the proposal's `defaultMode: acceptEdits` is\s+intended only for this isolated distribution/);
assert.match(workflow, /`\.claude\/settings\.local\.json`/);
console.log('PASS Auto mode and bypassPermissions stay disabled; acceptEdits is scoped to the isolated agent');

const deny = new Set(permissions.deny);
for (const rule of ['Bash(gh pr merge*)', 'Bash(gh pr ready*)', 'Bash(gh pr review *)',
  'Bash(gh api *)', 'Bash(gh secret *)', 'Bash(gh workflow *)', 'Bash(supabase *)',
  'Bash(npx supabase *)', 'Bash(wrangler *)', 'Bash(npx wrangler *)', 'Bash(npm run deploy*)',
  'Bash(git push * main)', 'Bash(git push * HEAD:main)', 'Bash(git push --force*)',
  'Edit(/database/migrations/**)',
  'Read(~/.supabase/**)', 'Read(~/.config/.wrangler/**)', 'Read(~/**/.env)']) {
  assert.ok(deny.has(rule), `deny must contain ${rule}`);
}
const pushAllow = /^Bash\(git push origin (?:feat|fix|docs|chore|test|refactor)\/\*\)$/;
const risky = /merge|deploy|supabase|wrangler|gh api|gh secret|gh auth|psql|docker|rm |main/;
for (const rule of permissions.allow) {
  assert.doesNotMatch(rule, risky, `allow rule is too broad: ${rule}`);
  assert.ok(!deny.has(rule), `rule both allowed and denied: ${rule}`);
  if (rule.startsWith('Bash(git push')) assert.match(rule, pushAllow, `push allow too broad: ${rule}`);
  if (rule.startsWith('Bash(gh pr create')) assert.equal(rule, 'Bash(gh pr create --draft *)');
}
assert.equal(permissions.allow.filter(r => pushAllow.test(r)).length, 6);
for (const rule of ['Edit(/.github/**)', 'Edit(/.claude/**)', 'Edit(/scripts/run_ci_tests.mjs)',
  'Edit(/package.json)', 'Bash(git config *)']) {
  assert.ok(permissions.ask.includes(rule), `ask must contain ${rule}`);
}
for (const shadowing of ['Bash(git push *)', 'Bash(gh pr create *)']) {
  assert.ok(!permissions.ask.includes(shadowing), `${shadowing} in ask would shadow the narrow allow`);
}
console.log('PASS push and draft-PR allows are narrow; merge, ready, production, migrations denied');

// Model of the documented rule semantics (deny > ask > allow; `*` matches any
// text; a trailing " *" also matches the bare command). It checks the intent
// of the rule set on concrete commands; it is not proof of Claude Code's
// matcher, and the workflow states that patterns are not a security boundary.
const toRegex = pattern => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped.endsWith(' .*') ? `${escaped.slice(0, -3)}(?: .*)?` : escaped}$`);
};
const bashRules = list => list.filter(r => r.startsWith('Bash(')).map(r => toRegex(r.slice(5, -1)));
const [denyRx, askRx, allowRx] = [permissions.deny, permissions.ask, permissions.allow].map(bashRules);
const decide = cmd => denyRx.some(r => r.test(cmd)) ? 'deny'
  : askRx.some(r => r.test(cmd)) ? 'ask' : allowRx.some(r => r.test(cmd)) ? 'allow' : 'prompt';
const expected = {
  'git push origin feat/ef-14-replay': 'allow',
  'git push origin chore/infra-agent-2-x': 'allow',
  'gh pr create --draft --base main --head feat/x --title t --body-file r.md': 'allow',
  'npm test': 'allow',
  'git push origin main': 'deny',
  'git push origin feat/x:main': 'deny',
  'git push origin HEAD:main': 'deny',
  'git push origin feat/x main': 'deny',
  'git push origin refs/heads/main': 'deny',
  'git push origin feat/x --force': 'deny',
  'git push --force origin feat/x': 'deny',
  'git push origin +feat/x': 'deny',
  'git push origin --delete feat/x': 'deny',
  'git push origin feat/x --tags': 'deny',
  'git push origin gh-pages': 'deny',
  'gh pr merge 104': 'deny',
  'gh pr ready 104': 'deny',
  'gh api repos/x/y/branches/main/protection': 'deny',
  'supabase db push': 'deny',
  'npx wrangler deploy': 'deny',
  'npm run deploy': 'deny',
  'git config --global core.hooksPath /tmp/h': 'ask',
  'gh pr create --base main --head feat/x': 'prompt',
  'git push upstream feat/x': 'prompt',
  'git push origin experiment/x': 'prompt',
};
for (const [cmd, want] of Object.entries(expected)) {
  assert.equal(decide(cmd), want, `${cmd} → expected ${want}`);
}
console.log(`PASS ${Object.keys(expected).length} concrete commands resolve as intended under the documented rule model`);

assert.match(workflow, /## 9\. Push and draft-PR autonomy — restrictions and independent controls/);
assert.match(workflow, /they are \*\*not\*\* a security guarantee/);
for (const control of ['enforce_admins', 'require_last_push_approval', 'Workflows',
  'environment branch policy']) {
  assert.ok(workflow.includes(control), `independent control must be documented: ${control}`);
}
assert.match(workflow, /## 10\. GitHub Actions exposure to agent branches and PRs/);
for (const fact of ['pull_request_target', 'CI executes agent-controlled code',
  'Workflow injection', 'Supply chain']) {
  assert.ok(workflow.includes(fact), `Actions risk review must cover: ${fact}`);
}
console.log('PASS independent controls and GitHub Actions risks are documented');

assert.equal(sandbox.enabled, true);
assert.equal(sandbox.failIfUnavailable, true);
assert.equal(sandbox.allowUnsandboxedCommands, false);
assert.equal(sandbox.credentials, undefined,
  'sandbox.credentials is ignored in project settings; it belongs in user scope');
assert.deepEqual(sandbox.excludedCommands, ['git *', 'gh *'],
  'only git and gh may run outside the sandbox');
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
