// Legibility guard for the terminal theme: every text colour token must
// reach WCAG AA (4.5:1) on every surface token it is drawn on, in the default
// theme and in the prefers-contrast theme. Checked in a real browser during
// TV-1 (headless Chromium); this static check keeps the tokens from regressing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../frontend/css/style.css', import.meta.url), 'utf8');

function tokens(block) {
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(([, k, v]) => [k, v]));
}
const root = /:root\s*\{([^}]*)\}/.exec(css);
assert.ok(root, ':root block');
const base = tokens(root[1]);
const highContrast = /@media \(prefers-contrast: more\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css);
assert.ok(highContrast, 'prefers-contrast block');

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ['bg', 'panel', 'panel-head', 'panel-alt'];
const TEXTS = ['text', 'text-dim', 'text-faint', 'up', 'down', 'major', 'info', 'accent', 'critical'];
let checked = 0;
for (const [name, theme] of [['default', base], ['prefers-contrast', { ...base, ...tokens(highContrast[1]) }]]) {
  for (const surface of SURFACES) {
    assert.ok(theme[surface], `${name}: --${surface} defined`);
    for (const text of TEXTS) {
      assert.ok(theme[text], `${name}: --${text} defined`);
      const value = ratio(theme[text], theme[surface]);
      assert.ok(value >= 4.5, `${name}: --${text} on --${surface} = ${value.toFixed(2)}:1 < 4.5:1`);
      checked += 1;
    }
  }
}
// The hierarchy stays visible: faint < dim < text in luminance.
assert.ok(luminance(base['text-faint']) < luminance(base['text-dim']));
assert.ok(luminance(base['text-dim']) < luminance(base.text));
console.log(`PASS ${checked} text/surface token pairs reach WCAG AA; faint < dim < text`);
