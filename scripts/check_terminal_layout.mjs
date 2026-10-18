#!/usr/bin/env node
/**
 * Optional local layout check of the terminal in a real browser (not run in
 * CI, which has no browser). For each workspace and viewport it reports:
 * - elements whose content is clipped by overflow hidden/clip, or that
 *   overflow the viewport outside a horizontal scroller;
 * - visible text below WCAG AA contrast (4.5:1, or 3:1 for large text);
 * - below 900 px, any vertical scroller other than the page itself;
 * - content left behind a horizontal scroller (nothing may need a sideways scroll to be read).
 * The chain workspace is also checked with every section and the legend
 * expanded, and on a degraded and a rejected scenario.
 *
 *   XAU_PLAYWRIGHT=/path/to/node_modules/playwright-core \
 *   XAU_CHROMIUM=/path/to/chromium node scripts/check_terminal_layout.mjs
 *
 * Neither dependency is part of package.json. Exit 0 when nothing is found,
 * 1 when a problem is found, 2 when the browser is unavailable.
 */

import { pathToFileURL } from 'node:url';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SYNTHETIC_ARCHIVE, createTerminalServer } from './serve_terminal_local.mjs';

const VIEWPORTS = [[320, 640], [390, 844], [1024, 768], [1280, 720], [1440, 900]];
const VARIANTS = [
  { name: 'marche', hash: 'marche' },
  { name: 'chaine', hash: 'chaine' },
  { name: 'chaine déplié', hash: 'chaine', expand: true },
  { name: 'chaine market-unavailable déplié', hash: 'chaine', scenario: 'market-unavailable', expand: true },
  { name: 'chaine invalid-input', hash: 'chaine', scenario: 'invalid-input' },
  { name: 'chaine archive-synthetic déplié', hash: 'chaine', scenario: 'archive-synthetic', expand: true },
  // --archive mode: the CUTOFF DE REJEU selector is shown; one earlier reception instant is replayed.
  { name: 'chaine --archive rejeu déplié', hash: 'chaine', archive: true, replayIndex: 2, expand: true },
  // --data-root: the DONNÉES LOCALES panel with both cards (archive log and a CFTC file), synthetic data only.
  { name: 'chaine --data-root sources déplié', hash: 'chaine', data: true, expand: true },
];

/** Runs in the page: clipped and overflowing elements. */
function findClipping() {
  // Content of a closed <details> keeps a box in Chromium but is not shown.
  const folded = (e) => { const box = e.closest('details:not([open])'); return box && !e.closest('summary'); };
  const out = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('[hidden], .sr-only') || folded(e) || !e.getClientRects().length) continue;
    // Visually hidden on purpose (1 px, kept for screen readers): clipping is the point.
    if (e.clientWidth <= 1 && e.clientHeight <= 1) continue;
    const cs = getComputedStyle(e);
    const clipX = ['hidden', 'clip'].includes(cs.overflowX);
    const clipY = ['hidden', 'clip'].includes(cs.overflowY);
    if ((clipX && e.scrollWidth > e.clientWidth + 1) || (clipY && e.scrollHeight > e.clientHeight + 1)) {
      out.push(`clipped ${e.tagName.toLowerCase()}.${e.className}#${e.id}`);
    }
    // Content inside a scrolling container is reachable, not lost.
    let scroller = false;
    // The page itself does not count: a page that scrolls sideways is the defect.
    for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n);
      if (['auto', 'scroll'].includes(o.overflowX)) { scroller = true; break; }
    }
    const box = e.getBoundingClientRect();
    if (!scroller && (box.right > window.innerWidth + 1 || box.left < -1)) {
      out.push(`overflows viewport ${e.tagName.toLowerCase()}.${e.className}#${e.id}`);
    }
  }
  return [...new Set(out)];
}

/**
 * Runs in the page: content pushed behind a horizontal scroller. Reachable by scrolling, but a
 * provenance column (SOURCE) that is off-screen on first read is a defect, not a layout choice.
 */
function findHiddenBehindScroll() {
  const out = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('[hidden], .sr-only') || !e.getClientRects().length) continue;
    if (e.closest('details:not([open])') && !e.closest('summary')) continue;
    if (!['auto', 'scroll'].includes(getComputedStyle(e).overflowX)) continue;
    const hidden = e.scrollWidth - e.clientWidth;
    if (hidden > 1) out.push(`${hidden}px behind horizontal scroll ${e.tagName.toLowerCase()}.${e.className}#${e.id}`);
  }
  return out;
}

/** Runs in the page: vertical scrollers other than the page (narrow screens). */
function findNestedScroll() {
  if (window.innerWidth > 900) return [];
  const out = [];
  for (const e of document.querySelectorAll('body *')) {
    if (!e.getClientRects().length) continue;
    const o = getComputedStyle(e).overflowY;
    if (['auto', 'scroll'].includes(o) && e.scrollHeight > e.clientHeight + 1) {
      out.push(`nested scroll ${e.tagName.toLowerCase()}.${e.className}#${e.id}`);
    }
  }
  return out;
}

/** Runs in the page: text below WCAG AA. */
function findLowContrast() {
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const blend = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const background = (e) => {
    const stack = [];
    for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; } }
    let bg = { r: 0, g: 0, b: 0, a: 1 };
    for (const c of stack.reverse()) bg = blend(c, bg);
    return bg;
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const e = walker.currentNode.parentElement;
    if (!walker.currentNode.textContent.trim() || !e || e.closest('[hidden], script, style, .sr-only') || !e.getClientRects().length) continue;
    const cs = getComputedStyle(e);
    const bg = background(e);
    const fg = blend(parse(cs.color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66);
    if (ratio < (large ? 3 : 4.5)) out.push(`contrast ${ratio.toFixed(2)}:1 "${walker.currentNode.textContent.trim().slice(0, 30)}"`);
  }
  return [...new Set(out)];
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import(pathToFileURL(`${process.env.XAU_PLAYWRIGHT ?? 'playwright-core'}/index.mjs`).href)
      .catch(() => import('playwright-core')));
  } catch {
    process.stderr.write('playwright-core unavailable: set XAU_PLAYWRIGHT\n');
    return 2;
  }
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.XAU_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  } catch (error) {
    process.stderr.write(`browser unavailable: ${error.message.split('\n')[0]}\n`);
    return 2;
  }
  const server = await createTerminalServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const dataRoot = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'xau-layout-data-'));
  mkdirSync(path.join(dataRoot, 'evidence', 'synthetic-log'), { recursive: true });
  mkdirSync(path.join(dataRoot, 'positioning'));
  copyFileSync(SYNTHETIC_ARCHIVE, path.join(dataRoot, 'evidence', 'synthetic-log', 'archive.json'));
  const cotFixture = new URL('../tests/fixtures/cftc_cot_disaggregated_synthetic.csv', import.meta.url);
  copyFileSync(cotFixture, path.join(dataRoot, 'positioning', 'gold-synthetic.csv'));
  writeFileSync(path.join(dataRoot, 'positioning', 'gold-synthetic.declaration.json'), JSON.stringify({ schemaVersion: 'xau.cftc-cot-declaration.v1',
    dataset: 'FUTURES_ONLY', publishedAt: '2026-09-25T19:30:00.000Z', receivedAt: '2026-09-25T19:45:00.000Z', reportDate: '2026-09-22' }));
  const dataServer = await createTerminalServer({ dataRoot });
  await new Promise((resolve) => dataServer.listen(0, '127.0.0.1', resolve));
  const dataBase = `http://127.0.0.1:${dataServer.address().port}/`;
  const archiveServer = await createTerminalServer({ archiveFile: SYNTHETIC_ARCHIVE });
  await new Promise((resolve) => archiveServer.listen(0, '127.0.0.1', resolve));
  const archiveBase = `http://127.0.0.1:${archiveServer.address().port}/`;
  let problems = 0;
  try {
    for (const [width, height] of VIEWPORTS) {
      for (const variant of VARIANTS) {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.goto(`${variant.data ? dataBase : variant.archive ? archiveBase : base}#${variant.hash}`, { waitUntil: 'load' });
        await page.waitForTimeout(800);
        if (variant.data) {
          await page.selectOption('#v2-data-market', 'log:evidence:synthetic-log');
          await page.selectOption('#v2-data-positioning', 'cot:gold-synthetic.csv');
          await page.waitForTimeout(600);
        }
        if (variant.replayIndex !== undefined) {
          await page.selectOption('#v2-replay-cutoff', { index: variant.replayIndex });
          await page.waitForTimeout(500);
        }
        if (variant.scenario) {
          await page.selectOption('#v2-scenario', variant.scenario);
          await page.waitForTimeout(500);
        }
        if (variant.expand) {
          await page.evaluate(() => { for (const box of document.querySelectorAll('details')) box.open = true; });
        }
        const found = [...await page.evaluate(findClipping), ...await page.evaluate(findLowContrast),
          ...await page.evaluate(findNestedScroll), ...await page.evaluate(findHiddenBehindScroll)];
        problems += found.length;
        process.stdout.write(`${found.length ? 'FAIL' : 'OK  '} ${variant.name} ${width}x${height}${found.length ? `\n  ${found.join('\n  ')}` : ''}\n`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
    archiveServer.close();
    dataServer.close();
  }
  return problems === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
