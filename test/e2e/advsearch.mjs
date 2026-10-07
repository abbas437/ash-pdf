#!/usr/bin/env node
// End-to-end test of Advanced search (renderer/ui/advsearch.js) in Chromium via playwright-core,
// served over HTTP with the browser shim (same pattern as run.mjs). A fake folder of three generated
// PDFs is supplied through window.__ashShim.addFolder. Prints "ADVSEARCH OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

/** PDF whose page k shows lines[k]. */
async function makePdf(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of lines) doc.addPage([612, 792]).drawText(text, { x: 72, y: 700, size: 20, font });
  return [...await doc.save()];
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const files = [
    { name: 'alpha.pdf', bytes: await makePdf(['Intro page', 'The pump station is ready']), mtimeMs: 3000 },
    { name: 'gamma.pdf', bytes: await makePdf(['Nothing relevant here']), mtimeMs: 1000 },
    { name: 'beta.pdf', dir: 'sub', bytes: await makePdf(['One', 'Two', 'Old pump station and new pump station']), mtimeMs: 2000 },
  ];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const idle = () => page.waitForFunction(() => document.querySelector('.as-progress').hidden && /hits? in \d+ files?|Index up to date/.test(document.querySelector('.as-status').textContent), null, { timeout: 15_000 });
  // [[file name, [page labels]]] as shown in the panel.
  const shown = () => page.evaluate(() => [...document.querySelectorAll('.as-file')].map((s) => [s.querySelector('.as-file-title').textContent,
    [...s.querySelectorAll('.search-hit')].map((b) => `${b.querySelector('.sh-page').textContent}: ${b.querySelector('mark').textContent}`)]));

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await page.evaluate((list) => window.__ashShim.addFolder('/fake', list.map((f) => ({ ...f, bytes: new Uint8Array(f.bytes) }))), files);

  step = 'Ctrl+Shift+F opens the panel, not the find bar';
  await page.keyboard.press('Control+Shift+F');
  await page.waitForSelector('.as-panel', { state: 'visible' });
  eq(await ev('return [app.state.sidebarTab, document.activeElement.dataset.as, document.querySelector(".find-bar").hidden];'), ['advsearch', 'query', true], 'panel state');

  step = 'folder search (with subfolders) finds hits in 2 files';
  check(await page.locator('[data-as="chooseFolder"]').isHidden(), 'folder controls shown for current-document scope');
  await page.selectOption('[data-as="scope"]', 'folder');
  await page.click('[data-as="chooseFolder"]');
  await page.waitForFunction(() => document.querySelector('.as-folder').textContent === '/fake');
  await page.check('[data-as="recursive"]');
  await page.fill('[data-as="query"]', 'pump station');
  await page.click('[data-as="search"]');
  await idle();
  const live = await shown();
  eq(live, [['alpha.pdf', ['Page 2: pump station']], ['beta.pdf', ['Page 3: pump station', 'Page 3: pump station']]], 'folder hits');
  eq(await page.textContent('.as-status'), '3 hits in 2 files', 'status');

  step = 'without subfolders only the top level is searched';
  await page.uncheck('[data-as="recursive"]');
  await page.click('[data-as="search"]');
  await idle();
  eq((await shown()).map((r) => r[0]), ['alpha.pdf'], 'non-recursive files');
  await page.check('[data-as="recursive"]');
  await page.click('[data-as="search"]');
  await idle();

  step = 'sort by hits and by modified date';
  await page.selectOption('[data-as="sort"]', 'hits');
  eq((await shown()).map((r) => r[0]), ['beta.pdf', 'alpha.pdf'], 'sorted by hits');
  await page.selectOption('[data-as="sort"]', 'mtime');
  eq((await shown()).map((r) => r[0]), ['alpha.pdf', 'beta.pdf'], 'sorted by date');
  await page.selectOption('[data-as="sort"]', 'name');

  step = 'clicking a hit opens the file at that page with the hit highlighted';
  await page.locator('.as-file').nth(1).locator('.search-hit').nth(1).click();
  await page.waitForFunction(() => {
    const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId);
    const r = t && a.search.getResults(t);
    return t?.name === 'beta.pdf' && r?.done && r.current >= 0;
  }, null, { timeout: 10_000 });
  eq(await ev('const r = app.search.getResults(tab); return [tab.path, tab.currentPage, r.hits[r.current].pageIndex, r.current, app.state.sidebarTab];'),
    ['/fake/sub/beta.pdf', 2, 2, 1, 'advsearch'], 'opened tab, page and current highlight');
  await page.waitForSelector('.textLayer .hl', { timeout: 10_000 });
  eq(await ev('return [app.search.options.caseSensitive, app.search.options.wholeWord];'), [false, false], 'find bar options restored');
  // A second click on the same file switches to its tab instead of opening it again.
  await page.locator('.as-file').nth(0).locator('.search-hit').first().click();
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 2 && window.ashStudio.state.tabs.find((x) => x.id === window.ashStudio.state.activeId)?.name === 'alpha.pdf');
  await page.locator('.as-file').nth(1).locator('.search-hit').first().click();
  await page.waitForFunction(() => window.ashStudio.state.tabs.find((x) => x.id === window.ashStudio.state.activeId)?.name === 'beta.pdf');
  eq(await ev('return app.state.tabs.length;'), 2, 'no duplicate tab');

  step = 'a document opened from a hit saves via Save As (folder grants are read-only)';
  await ev('await app.pageTools.rotate(tab, [2], 90);');
  check(await ev('return !!tab.dirty;'), 'edit did not mark the tab dirty');
  const saveDl = page.waitForEvent('download', { timeout: 10_000 });
  await page.keyboard.press('Control+s');
  eq((await saveDl).suggestedFilename(), 'beta.pdf', 'save dialog file name');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t && !t.dirty && t.path.startsWith('browser-file:'); }, null, { timeout: 10_000 });
  eq(await ev('return [tab.name, tab.path.endsWith("/beta.pdf")];'), ['beta.pdf', true], 'tab renamed to the saved path');

  step = 'export results to CSV';
  const download = page.waitForEvent('download');
  await page.click('[data-as="export"]');
  const dl = await download;
  eq(dl.suggestedFilename(), 'search-results.csv', 'csv name');
  const csv = await readFile(await dl.path(), 'utf8');
  eq(csv.split('\r\n'), ['﻿file,path,page,snippet', 'alpha.pdf,/fake/alpha.pdf,2,The pump station is ready',
    'beta.pdf,/fake/sub/beta.pdf,3,Old pump station and new pump station', 'beta.pdf,/fake/sub/beta.pdf,3,Old pump station and new pump station', ''], 'csv rows');

  step = 'build index, then indexed search returns the same hits';
  await page.click('[data-as="buildIndex"]');
  await idle();
  eq(await page.textContent('.as-status'), 'Index up to date: 3 files (3 re-read).', 'index status');
  check((await page.evaluate(() => window.__ashShim.cacheKeys())).some((k) => k.includes('/fake')), 'index not stored via cacheSet');
  await page.click('[data-as="buildIndex"]');
  await idle();
  eq(await page.textContent('.as-status'), 'Index up to date: 3 files (0 re-read).', 'incremental index status');
  await page.check('[data-as="useIndex"]');
  for (const ww of [false, true]) {
    await page.setChecked('[data-as="wholeWords"]', ww);
    await page.click('[data-as="search"]');
    await idle();
    eq(await shown(), live, `indexed hits (whole words ${ww})`);
  }

  step = 'screenshots in light and dark themes';
  await page.click('.as-file-name');
  await page.screenshot({ path: join(OUT, 'advsearch-light.png') });
  await ev('await app.setTheme("dark");');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: join(OUT, 'advsearch-dark.png') });
  // Legibility: text colour differs from its background in both themes (computed, not eyeballed).
  const contrast = await page.evaluate(() => {
    const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bg = (el) => { for (; el; el = el.parentElement) { const c = getComputedStyle(el).backgroundColor; if (!/rgba\(.*, 0\)|transparent/.test(c)) return c; } return 'rgb(255,255,255)'; };
    return ['.as-file-title', '.as-panel .sh-text', '.as-panel label', '[data-as="query"]'].map((sel) => {
      const el = document.querySelector(sel); const a = lum(getComputedStyle(el).color), b = lum(bg(el));
      return `${Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10} ${sel} ${getComputedStyle(el).color} on ${bg(el)}`;
    });
  });
  check(contrast.every((r) => parseFloat(r) >= 4.5), `dark theme contrast too low: ${contrast.join('; ')}`);
  await ev('await app.setTheme("light");');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('ADVSEARCH FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('ADVSEARCH OK');
