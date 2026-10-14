#!/usr/bin/env node
/**
 * Optional local layout check of the terminal in a real browser (not run in
 * CI, which has no browser). For each workspace and viewport it reports:
 * - elements whose content is clipped by overflow hidden/clip, or that
 *   overflow the viewport outside a horizontal scroller;
 * - visible text below WCAG AA contrast (4.5:1, or 3:1 for large text).
 *
 *   XAU_PLAYWRIGHT=/path/to/node_modules/playwright-core \
 *   XAU_CHROMIUM=/path/to/chromium node scripts/check_terminal_layout.mjs
 *
 * Neither dependency is part of package.json. Exit 0 when nothing is found,
 * 1 when a problem is found, 2 when the browser is unavailable.
 */

import { pathToFileURL } from 'node:url';
import { createTerminalServer } from './serve_terminal_local.mjs';

const VIEWPORTS = [[320, 640], [390, 844], [1024, 768], [1280, 720], [1440, 900]];
const WORKSPACES = ['marche', 'chaine'];

/** Runs in the page: clipped and overflowing elements. */
function findClipping() {
  const out = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('[hidden], .sr-only') || !e.getClientRects().length) continue;
    const cs = getComputedStyle(e);
    const clipX = ['hidden', 'clip'].includes(cs.overflowX);
    const clipY = ['hidden', 'clip'].includes(cs.overflowY);
    if ((clipX && e.scrollWidth > e.clientWidth + 1) || (clipY && e.scrollHeight > e.clientHeight + 1)) {
      out.push(`clipped ${e.tagName.toLowerCase()}.${e.className}#${e.id}`);
    }
    // Content inside a scrolling container is reachable, not lost.
    let scroller = false;
    for (let n = e.parentElement; n; n = n.parentElement) {
      const o = getComputedStyle(n);
      if (['auto', 'scroll'].includes(o.overflowX)) { scroller = true; break; }
    }
    if (!scroller && e.getBoundingClientRect().right > window.innerWidth + 1) {
      out.push(`overflows viewport ${e.tagName.toLowerCase()}.${e.className}#${e.id}`);
    }
  }
  return [...new Set(out)];
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
  let problems = 0;
  try {
    for (const [width, height] of VIEWPORTS) {
      for (const workspace of WORKSPACES) {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.goto(`${base}#${workspace}`, { waitUntil: 'load' });
        await page.waitForTimeout(800);
        const found = [...await page.evaluate(findClipping), ...await page.evaluate(findLowContrast)];
        problems += found.length;
        process.stdout.write(`${found.length ? 'FAIL' : 'OK  '} ${workspace} ${width}x${height}${found.length ? `\n  ${found.join('\n  ')}` : ''}\n`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  return problems === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
