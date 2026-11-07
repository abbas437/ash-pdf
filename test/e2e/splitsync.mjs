#!/usr/bin/env node
// Split view "Scroll and zoom together" (ui/splitview.js, splitview-lib.js syncScroll) in Chromium
// with the browser shim: two different documents (5 A4 pages, 4 A3 pages) and the same document in
// both panes. Prints "SPLITSYNC OK" on success. Same harness as splitview.mjs.
// Run `node scripts/vendor.js` first. Chromium path: $CHROMIUM_PATH or the sandbox default.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf(n, size, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) doc.addPage(size).drawText(`${label} page ${i} of ${n}`, { x: 60, y: size[1] - 100, size: 28, font });
  return Buffer.from(await doc.save());
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, tol, msg) => check(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} ±${tol}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const [a4, a3] = await Promise.all([makePdf(5, [595.28, 841.89], 'Rev.00'), makePdf(4, [841.89, 1190.55], 'Rev.01')]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => {
    if (m.type() === 'error' || /\[bus\]|failed to render|Content Security Policy/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));

  const boot = async () => {
    await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  };
  const openFile = async (name, buffer) => {
    const chooser = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction((n) => window.ashStudio.state.tabs.some((t) => t.name === n && t.view), name);
  };
  const menu = async (m, id) => { await page.click(`.menu-btn:text-is("${m}")`); await page.click(`.menu [data-id="${id}"]`); };
  const splitMenu = async (item) => {
    if (await page.evaluate(() => !!document.querySelector('#btn-split').closest('.tb-more-panel'))) await page.click('.tb-more-btn');
    await page.click('#btn-split');
    await page.click(`#btn-split + .tb-dd-menu .menu-item[data-id="${item}"]`);
  };
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
  // Per pane: the page at the top edge and the fraction of it there, the zoom of its holder, scroll.
  const panes = () => page.evaluate(async () => {
    const { splitView } = await import('./ui/splitview.js');
    const { viewer } = await import('./ui/viewer.js');
    const s = splitView.state;
    const tabs = s.ids.map((id) => window.ashStudio.state.tabs.find((t) => t.id === id));
    return Object.fromEntries(['a', 'b'].map((k, i) => {
      const el = document.querySelector(`.viewer-scroll[data-pane="${k}"]`);
      const pages = [...el.querySelectorAll('.page')];
      let p = 0;
      while (p + 1 < pages.length && el.scrollTop >= pages[p + 1].offsetTop - 8) p++;
      const holder = s.ids[0] === s.ids[1] && i !== s.focus ? viewer.secondaryOf(tabs[0]) : tabs[i];
      return [k, { top: el.scrollTop, left: el.scrollLeft, max: el.scrollHeight - el.clientHeight, page: p, n: pages.length,
        fy: (el.scrollTop - pages[p].offsetTop) / pages[p].offsetHeight, zoom: holder.zoom, mode: holder.zoomMode, current: holder.currentPage }];
    }));
  });
  const scrollPane = (k, i, fy) => page.evaluate(([k, i, fy]) => {
    const el = document.querySelector(`.viewer-scroll[data-pane="${k}"]`);
    const pe = el.querySelectorAll('.page')[i];
    el.scrollTop = pe.offsetTop + fy * pe.offsetHeight;
  }, [k, i, fy]);
  const linkPressed = () => page.evaluate(() => [...document.querySelectorAll('.split-head .split-sync')].map((b) => b.getAttribute('aria-pressed')));

  step = 'open Rev.00 (5 x A4) and Rev.01 (4 x A3) side by side';
  await boot();
  await openFile('rev00.pdf', a4);
  await openFile('rev01.pdf', a3);
  await menu('View', 'split-v');
  await page.waitForFunction(() => document.querySelector('.viewer-host.split.split-v'));
  const [R0, R1] = await page.evaluate(() => window.ashStudio.state.tabs.map((t) => t.id));
  await page.selectOption('.split-head[data-pane="a"] select', R0);
  await page.selectOption('.split-head[data-pane="b"] select', R1);
  await page.click('.viewer-scroll[data-pane="a"]', { position: { x: 20, y: 200 } });
  await settle();
  check(JSON.stringify(await linkPressed()) === '["false","false"]', `sync starts off: ${await linkPressed()}`);

  step = 'sync off: panes scroll independently';
  await scrollPane('a', 1, 0.3);
  await settle();
  let p = await panes();
  check(p.a.page === 1 && p.b.top === 0, `only pane A moved: A page ${p.a.page + 1}, B top ${p.b.top}`);

  step = 'turn sync on (View menu): pane B joins pane A';
  await menu('View', 'split-sync');
  await settle();
  check(JSON.stringify(await linkPressed()) === '["true","true"]', `link buttons pressed: ${await linkPressed()}`);
  p = await panes();
  check(p.b.page === 1, `pane B on page 2 with A: ${p.b.page + 1}`);
  near(p.b.fy, 0.3, 0.02, 'pane B at the same fraction of page 2');

  step = 'scroll pane A to page 3 halfway: pane B shows page 3 halfway';
  await scrollPane('a', 2, 0.5);
  await settle();
  p = await panes();
  check(p.b.page === 2, `pane B on page 3: ${p.b.page + 1}`);
  near(p.b.fy, 0.5, 0.02, 'pane B halfway down page 3');
  near(p.a.fy, 0.5, 0.01, 'pane A not pushed back by the sync');

  step = 'zoom pane A to 150 %: pane B is at 150 %';
  await page.selectOption('.zoom-select', '1.5');
  await settle();
  p = await panes();
  check(p.a.mode === 'custom' && p.a.zoom === 1.5 && p.b.mode === 'custom' && p.b.zoom === 1.5, `both at 150 %: A ${p.a.mode} ${p.a.zoom}, B ${p.b.mode} ${p.b.zoom}`);
  check(p.b.page === p.a.page && Math.abs(p.b.fy - p.a.fy) < 0.02, `same page and fraction after zoom: A ${p.a.page + 1} ${p.a.fy}, B ${p.b.page + 1} ${p.b.fy}`);

  step = 'horizontal scroll syncs by fraction of the page width';
  await page.evaluate(() => { const el = document.querySelector('.viewer-scroll[data-pane="a"]'); el.scrollLeft = el.scrollWidth - el.clientWidth; });
  await settle();
  const hx = await page.evaluate(() => ['a', 'b'].map((k) => {
    const el = document.querySelector(`.viewer-scroll[data-pane="${k}"]`);
    const pe = el.querySelectorAll('.page')[2];
    return (el.scrollLeft + el.clientWidth / 2 - pe.offsetLeft) / pe.offsetWidth;
  }));
  check(hx[0] > 0.55, `pane A scrolled right: centre at ${hx[0]}`);
  near(hx[1], hx[0], 0.02, 'pane B centre at the same fraction of the page width');

  step = 'Ctrl+wheel in pane B zooms pane A';
  const rb = await page.evaluate(() => document.querySelector('.viewer-scroll[data-pane="b"]').getBoundingClientRect().toJSON());
  await page.mouse.move(rb.left + 100, rb.top + 200);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 200);
  await page.keyboard.up('Control');
  await settle();
  p = await panes();
  check(p.b.zoom < 1.5 && Math.abs(p.a.zoom - p.b.zoom) < 1e-6, `pane A follows the wheel zoom: A ${p.a.zoom}, B ${p.b.zoom}`);

  step = 'fit width in pane B: pane A fits width';
  await page.click('.viewer-scroll[data-pane="b"]', { position: { x: 20, y: 200 } });
  await page.waitForFunction((id) => window.ashStudio.state.activeId === id, R1);
  await menu('View', 'fitwidth');
  await settle();
  p = await panes();
  check(p.a.mode === 'fit-width' && p.b.mode === 'fit-width', `both fit width: A ${p.a.mode}, B ${p.b.mode}`);

  step = 'page box: go to page 4 in pane B moves pane A';
  await page.fill('.page-input', '4');
  await page.press('.page-input', 'Enter');
  await settle();
  p = await panes();
  check(p.a.page === 3 && p.b.page === 3, `both on page 4: A ${p.a.page + 1}, B ${p.b.page + 1}`);

  step = 'scroll pane A past pane B\'s last page: pane B is clamped';
  await page.click('.viewer-scroll[data-pane="a"]', { position: { x: 20, y: 200 } });
  await page.waitForFunction((id) => window.ashStudio.state.activeId === id, R0);
  await scrollPane('a', 4, 0.3);
  await settle();
  p = await panes();
  check(p.a.page === 4, `pane A on page 5: ${p.a.page + 1}`);
  check(p.b.page === 3 && (p.b.top >= p.b.max - 1 || p.b.fy >= 0.99), `pane B at the end of its last page: page ${p.b.page + 1}, fy ${p.b.fy}, top ${p.b.top}/${p.b.max}`);
  await page.waitForFunction(() => document.querySelector('.viewer-scroll[data-pane="b"] .page[data-page-index="3"]').classList.contains('rendered'), null, { timeout: 10_000 });

  step = 'horizontal split: still synced';
  await menu('View', 'split-h');
  await settle();
  await scrollPane('a', 1, 0.6);
  await settle();
  p = await panes();
  check(p.b.page === 1, `pane B on page 2 (h): ${p.b.page + 1}`);
  near(p.b.fy, 0.6, 0.02, 'pane B at the same fraction (h)');

  step = 'persisted state carries the toggle';
  check(await page.evaluate(async () => (await import('./ui/splitview.js')).splitView.state.sync === true), 'split state sync: true');
  check(await page.evaluate(() => window.api.settingsGet('view.splitSync')) === true, 'view.splitSync remembered');

  step = 'turn sync off (Split menu): panes move independently again';
  await splitMenu('split-sync');
  await settle();
  check(JSON.stringify(await linkPressed()) === '["false","false"]', `link buttons released: ${await linkPressed()}`);
  const before = (await panes()).b.top;
  await scrollPane('a', 3, 0.2);
  await settle();
  p = await panes();
  check(p.a.page === 3 && p.b.top === before, `pane B did not move: ${before} -> ${p.b.top}`);
  await page.selectOption('.zoom-select', '0.75');
  await settle();
  p = await panes();
  check(p.a.zoom === 0.75 && p.b.mode === 'fit-width', `zoom not shared: A ${p.a.zoom}, B ${p.b.mode}`);
  check(await page.evaluate(async () => (await import('./ui/splitview.js')).splitView.state.sync === false), 'split state sync: false');

  step = 'unsplit keeps the toggle for next time';
  await page.click('.split-head[data-pane="a"] .split-sync');
  await menu('View', 'unsplit');
  await settle();
  await menu('View', 'split-v');
  await page.waitForFunction(() => document.querySelector('.viewer-host.split'));
  await settle();
  check(JSON.stringify(await linkPressed()) === '["true","true"]', `toggle remembered across unsplit: ${await linkPressed()}`);
  await menu('View', 'unsplit');

  step = 'same document in both panes: synced through the secondary view';
  await splitMenu('split-same');
  await page.waitForFunction(() => [...document.querySelectorAll('.viewer-scroll[data-pane]')].filter((el) => !el.hidden && el.querySelector('.page.rendered')).length === 2, null, { timeout: 10_000 });
  await settle();
  await scrollPane('b', 2, 0.4);
  await settle();
  p = await panes();
  check(p.a.page === 2, `pane A follows pane B to page 3: ${p.a.page + 1}`);
  near(p.a.fy, 0.4, 0.02, 'pane A at the same fraction');
  await page.click('.viewer-scroll[data-pane="b"]', { position: { x: 20, y: 200 } });
  await settle();
  await page.selectOption('.zoom-select', '2');
  await settle();
  p = await panes();
  check(p.a.zoom === 2 && p.b.zoom === 2, `both panes of the same document at 200 %: A ${p.a.zoom}, B ${p.b.zoom}`);

  step = 'reload: the remembered toggle is the default';
  await boot();
  await openFile('rev00.pdf', a4);
  await menu('View', 'split-v');
  await page.waitForFunction(() => document.querySelector('.viewer-host.split'));
  check(JSON.stringify(await linkPressed()) === '["true","true"]', `stored default applies after a reload: ${await linkPressed()}`);

  if (problems.length) throw new Error(`page problems:\n${problems.join('\n')}`);
  console.log('SPLITSYNC OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
