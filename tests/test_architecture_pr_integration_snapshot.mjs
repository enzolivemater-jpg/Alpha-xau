import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('../docs/XAU_V2_DRAFT_PR_INTEGRATION_SEQUENCE_20261014.md', import.meta.url), 'utf8');

// Historical architectural snapshot: no live CI, production or GitHub state implied.
assert.match(text, /historical review snapshot/);
assert.match(text, /Planning only — NOT a live board/);
assert.match(text, /#123 CHAIN-0 → #124 TV-0 → #125 TV-1 → #126 TV-2/);
assert.match(text, /#123[^\n]*inherits development history from #104/);
assert.match(text, /#124[^\n]*depends on #123/);
assert.match(text, /#125[^\n]*depends on #124/);
assert.match(text, /#126[^\n]*depends on #125/);
assert.match(text, /Compare the actual decision-chain dry-run with #106\/#111/);
assert.match(text, /Forward-port reviewed deltas; do not overwrite newer hardened files/);
assert.match(text, /Demo market panels and fictional directional news/);
assert.match(text, /LOCAL SIMULATION/);
assert.match(text, /cross-browser\/UI acceptance remain unproven/);
assert.match(text, /Do not merge #123\/#124\/#125\/#126, do not deploy/);
assert.match(text, /#115, #117, #121[\s\S]*?NEVER MERGE/);
assert.match(text, /a4bdd6d43d048f98dc7e506537a82d4f7488d119/);
assert.match(text, /ec9cde542d6b51b68391462ee8fa474e650b389f/);
assert.match(text, /6 commits ahead/);
assert.match(text, /not.*proof of operator approval/i);
assert.match(text, /Reconcile the six GitHub commits/);
assert.match(text, /REC-1 Human Gate/);
assert.doesNotMatch(text, /production is ready|live trading is authorized/i);
assert.match(text, /Exact cross-stream overlap evidence/);
assert.match(text, /#115 vs #126 \| 4/);
assert.match(text, /#119 vs #126 \| 1/);
assert.match(text, /#125 vs #126 \| 79/);
assert.match(text, /backend\/decision_chain\/dry_run\.ts/);
assert.match(text, /scripts\/run_ci_tests\.mjs/);
assert.match(text, /not proof that Git cannot merge/);
console.log('PASS GOV-1 terminal PR stack and REC-1 frozen-ref drift snapshot');
