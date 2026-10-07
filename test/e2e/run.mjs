#!/usr/bin/env node
// End-to-end test of the ASH PDF Studio renderer in Chromium (playwright-core), served over
// HTTP with the browser shim. PDFs are generated here with pdf-lib and opened through the
// shim's <input type=file>. Screenshots go to test/e2e/out/. Prints "E2E OK" on success.
// Run `node scripts/vendor.js` first. Chromium path: $CHROMIUM_PATH or the sandbox default.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const ROTATED = 1; // 0-based index of the page carrying /Rotate 90

async function makeMainPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 12; n++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${n} of 12`, { x: 72, y: 700, size: 28, font });
    p.drawText('Supply air layout and general notes', { x: 72, y: 660, size: 14, font });
    if (n === 3 || n === 9) p.drawText('Check the ductwork clearances', { x: 72, y: 620, size: 16, font });
    if (n - 1 === ROTATED) p.setRotation(degrees(90));
  }
  return Buffer.from(await doc.save());
}
async function makeSmallPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 2; n++) doc.addPage([420, 595]).drawText(`Second document ${n}`, { x: 40, y: 540, size: 18, font });
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
await mkdir(OUT, { recursive: true });

const problems = [];
const fail = (msg) => { throw new Error(msg); };
const check = (cond, msg) => { if (!cond) fail(msg); };
const near = (a, b, tol, msg) => check(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} ±${tol}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const [mainPdf, smallPdf] = await Promise.all([makeMainPdf(), makeSmallPdf()]);
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
  const S = 'const app = window.ashStudio, v = app.viewer, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const waitRendered = (i) => page.waitForFunction((k) => {
    const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId);
    return t?.view?.pageEls[k]?.classList.contains('rendered');
  }, i, { timeout: 10_000 });
  const box = (i) => ev('const r = v.getPageEl(tab, arg).getBoundingClientRect(); return { w: r.width, h: r.height };', i);
  const setZoomUI = async (value) => { await page.selectOption('.zoom-select', value); await settle(); };

  step = 'boot';
  await boot();
  await page.evaluate(() => localStorage.clear());
  check(await page.locator('.welcome').isVisible(), 'welcome screen not shown at start');

  step = 'open + layout';
  await openFile('ductwork-12.pdf', mainPdf);
  check(await page.locator('.viewer-scroll:not([hidden]) .page').count() === 12, 'expected 12 .page elements');
  await waitRendered(0);
  check(!(await page.locator('.welcome').isVisible()), 'welcome still visible after open');
  check((await page.textContent('.st-page')) === 'Page 1 of 12', `status page text: ${await page.textContent('.st-page')}`);
  // The landscape (/Rotate 90) page widens the column: fit width must still centre page 1.
  const cx0 = await ev('const r = v.getPageEl(tab, 0).getBoundingClientRect(), s = v.getScrollEl(tab).getBoundingClientRect(); return (r.left + r.right) / 2 - (s.left + v.getScrollEl(tab).clientWidth / 2);');
  near(cx0, 0, 2, 'page 1 horizontal centring at fit width');
  await page.screenshot({ path: join(OUT, 'light.png') });

  step = 'virtualisation';
  await setZoomUI('1');
  for (let k = 0; k < 40; k++) {
    await ev('v.getScrollEl(tab).scrollTop += 400;');
    await page.waitForTimeout(40);
  }
  await waitRendered(11);
  await page.waitForTimeout(300);
  const canvases = await page.locator('.viewer-scroll:not([hidden]) canvas.page-canvas').count();
  check(canvases > 0 && canvases < 12, `canvas count after scrolling should be 1..11, got ${canvases}`);
  check((await ev('return tab.currentPage;')) >= 10, 'currentPage did not follow scrolling');

  step = 'zoom';
  await ev('v.scrollToPage(tab, 0);');
  await setZoomUI('1');
  near((await box(0)).w, 816, 0.5, 'page width at 100%');
  await setZoomUI('1.5');
  near((await box(0)).w, 1224, 0.5, 'page width at 150%');
  await page.click('#btn-zoomout');
  await settle();
  near((await box(0)).w, 816 * 1.25, 0.5, 'page width after zoom out from 150%');
  await setZoomUI('fit-width');
  let sc = await ev('const s = v.getScrollEl(tab); return { w: s.clientWidth, h: s.clientHeight };');
  near((await box(0)).w, sc.w - 34, 1, 'fit width');
  await setZoomUI('fit-page');
  const fp = await box(0);
  near(fp.h, sc.h - 34, 1, 'fit page height');
  check(fp.w <= sc.w - 34 + 1, 'fit page wider than the viewport');
  check((await page.inputValue('.zoom-select')) === 'fit-page', 'zoom select does not show fit-page');

  step = 'text layer';
  await setZoomUI('1');
  await ev('v.scrollToPage(tab, 2);');
  await waitRendered(2);
  const tl = await ev('return v.getPageEl(tab, 2).querySelector(".textLayer")?.textContent ?? null;');
  check(tl != null, 'page 3 has no .textLayer');
  check(tl.includes('ductwork') && tl.includes('Page 3 of 12'), `page 3 text layer: ${JSON.stringify(tl)}`);
  // Text spans must sit over the glyphs: the "Page 3 of 12" span starts ~72pt from the left.
  const span = await ev(`const pe = v.getPageEl(tab, 2), s = [...pe.querySelectorAll('.textLayer span')].find((x) => x.textContent.startsWith('Page 3'));
    const r = s.getBoundingClientRect(), p = pe.getBoundingClientRect(); return { x: r.left - p.left, y: r.top - p.top, w: r.width };`);
  near(span.x, 72 * 96 / 72, 4, 'text span left offset');
  check(span.w > 100, `text span width too small: ${span.w}`);

  step = 'view rotation';
  await ev('v.scrollToPage(tab, 0);');
  const b0 = await box(0), bR = await box(ROTATED);
  check(bR.w > bR.h && b0.h > b0.w, 'the /Rotate 90 page should be landscape, page 1 portrait');
  await page.click('#btn-rotr');
  await settle();
  const b0r = await box(0), bRr = await box(ROTATED);
  near(b0r.w, b0.h, 0.5, 'page 1 width after view rotation'); near(b0r.h, b0.w, 0.5, 'page 1 height after view rotation');
  near(bRr.w, bR.h, 0.5, 'rotated page width after view rotation'); near(bRr.h, bR.w, 0.5, 'rotated page height after view rotation');
  await ev(`v.scrollToPage(tab, ${ROTATED});`);
  await ev('v.setZoom(tab, "fit-page");');
  await waitRendered(ROTATED);
  await page.screenshot({ path: join(OUT, 'rotated.png') });
  await ev('v.setZoom(tab, 1);');
  await page.click('#btn-rotl');
  await settle();
  near((await box(0)).w, b0.w, 0.5, 'page 1 width after rotating back');

  step = 'coordinates';
  // Ground truth: a page-space point (x, y) on a W x H page shows at local CSS offset
  // rot 0: (x, y)*s; rot 90: (H - y, x)*s; rot 180: (W - x, H - y)*s; rot 270: (y, W - x)*s.
  await page.evaluate(() => {
    window.__hits = [];
    document.addEventListener('pointerdown', (e) => {
      const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId);
      const hit = t && a.viewer.clientToPage(t, e.clientX, e.clientY);
      if (!hit) return;
      const svg = a.viewer.getOverlaySvg(t, hit.pageIndex);
      const m = svg.getScreenCTM().inverse();
      const sp = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
      window.__hits.push({ hit, svg: { x: sp.x, y: sp.y } });
    }, true);
  });
  for (const [zoom, rot, pi] of [[1, 0, 0], [1.5, 0, 0], [1, 90, 0], [1, 0, ROTATED], [1, 90, ROTATED], [1.5, 270, ROTATED]]) {
    await ev('v.setZoom(tab, arg.zoom); if (tab.viewRotation !== arg.rot) v.rotateView(tab, arg.rot - tab.viewRotation); v.scrollToPage(tab, arg.pi);', { zoom, rot, pi });
    await settle();
    const info = await ev(`const svg = v.getOverlaySvg(tab, arg); const r = v.getPageEl(tab, arg).getBoundingClientRect(); const ps = v.pageSize(tab, arg);
      return { viewBox: svg.getAttribute('viewBox'), left: r.left, top: r.top, W: ps.width, H: ps.height, s: v.scale(tab) };`, pi);
    const expectedVB = pi === ROTATED ? '0 0 792 612' : '0 0 612 792';
    check(info.viewBox === expectedVB, `overlay viewBox ${info.viewBox}, expected ${expectedVB} (zoom ${zoom}, rot ${rot}, page ${pi + 1})`);
    const [x, y] = [100, 150];
    const { W, H, s } = info;
    const [lx, ly] = { 0: [x, y], 90: [H - y, x], 180: [W - x, H - y], 270: [y, W - x] }[rot];
    const cx = info.left + lx * s, cy = info.top + ly * s;
    await page.mouse.click(cx, cy);
    const { hit, svg } = (await page.evaluate(() => window.__hits.pop()));
    const tag = `(zoom ${zoom}, view rot ${rot}, page ${pi + 1})`;
    check(hit.pageIndex === pi, `clientToPage page ${hit.pageIndex} ${tag}`);
    near(hit.x, x, 1, `clientToPage x ${tag}`); near(hit.y, y, 1, `clientToPage y ${tag}`);
    near(svg.x, x, 1, `overlay SVG x ${tag}`); near(svg.y, y, 1, `overlay SVG y ${tag}`);
    const back = await ev('const p = v.pageToClient(tab, arg.pi, arg.x, arg.y); return p;', { pi, x, y });
    near(back.clientX, cx, 1, `pageToClient x ${tag}`); near(back.clientY, cy, 1, `pageToClient y ${tag}`);
  }
  await ev('v.rotateView(tab, -tab.viewRotation); v.setZoom(tab, 1);');
  await page.mouse.click(5, 5); // drop any selection, close nothing

  step = 'bytesChanged';
  await ev('v.scrollToPage(tab, 4);');
  await settle();
  check((await ev('return tab.currentPage;')) === 4, 'could not scroll to page 5');
  await ev(`const { PDFDocument } = await import('pdf-lib');
    const d = await PDFDocument.load(tab.bytes); d.removePage(0); tab.bytes = await d.save();
    app.bus.emit('tab:bytesChanged', { tab });`);
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t.numPages === 11 && t.view?.pageEls.length === 11; }, null, { timeout: 10_000 });
  await settle();
  check(await page.locator('.viewer-scroll:not([hidden]) .page').count() === 11, 'expected 11 pages after reload');
  check((await ev('return tab.currentPage;')) === 4, `scroll page not kept after reload: ${await ev('return tab.currentPage;')}`);
  check((await page.textContent('.st-page')) === 'Page 5 of 11', `status after reload: ${await page.textContent('.st-page')}`);
  await waitRendered(4);
  const t5 = await ev('return (await v.getTextContent(tab, 4)).items.map((i) => i.str).join(" ");');
  check(t5.includes('Page 6 of 12'), `page index 4 after deleting page 1 should be old page 6: ${t5}`);

  step = 'tabs';
  await openFile('second.pdf', smallPdf);
  check(await page.locator('.doc-tab').count() === 2, 'expected 2 tabs');
  check((await page.getAttribute('.doc-tab >> nth=1', 'aria-selected')) === 'true', 'second tab not active after open');
  await waitRendered(0);
  await page.screenshot({ path: join(OUT, 'two-tabs.png') });
  await page.click('.doc-tab >> nth=0');
  await settle();
  check((await page.getAttribute('.doc-tab >> nth=0', 'aria-selected')) === 'true', 'first tab not active after click');
  check(await page.locator('.viewer-scroll:not([hidden])').count() === 1, 'more than one visible viewer');
  check((await ev('return tab.currentPage;')) === 4, 'first tab lost its page on switch');
  await page.click('.doc-tab >> nth=1 >> .tab-close');
  check(await page.locator('.doc-tab').count() === 1, 'close button did not close the tab');
  await openFile('second.pdf', smallPdf);
  await page.keyboard.press('Control+w');
  await page.waitForFunction(() => document.querySelectorAll('.doc-tab').length === 1);
  check((await page.textContent('.doc-tab .tab-name')) === 'ductwork-12.pdf', 'Ctrl+W closed the wrong tab');

  step = 'dirty + discard';
  await ev('app.markDirty(tab);');
  check(await page.locator('.doc-tab .tab-dirty').count() === 1, 'no dirty marker on the tab');
  check(await page.locator('.st-dirty').isVisible(), 'no dirty marker in the status bar');
  await page.keyboard.press('Control+w');
  await page.waitForSelector('.dialog');
  check((await page.textContent('.dialog-title')) === 'Unsaved changes', 'discard dialog title');
  await page.click('.dialog button[data-value="cancel"]');
  check(await page.locator('.doc-tab').count() === 1, 'Cancel closed the tab');
  await page.keyboard.press('Control+w');
  await page.click('.dialog button[data-value="discard"]');
  await page.waitForFunction(() => document.querySelectorAll('.doc-tab').length === 0);
  check(await page.locator('.welcome').isVisible(), 'welcome screen not back after closing the last tab');
  // Encrypted-document banner: pdf-lib cannot write encrypted PDFs, so that path is skipped.

  step = 'about logo';
  const aboutLogo = async (theme) => {
    await page.locator('.menu-btn', { hasText: /^Help$/ }).click();
    await page.locator('.menu[aria-label=Help] button', { hasText: 'About ASH PDF Studio' }).click();
    await page.waitForSelector('.dialog .about-logo', { state: 'attached' });
    const r = await page.evaluate(() => [...document.querySelectorAll('.dialog img.about-logo')].filter((i) => i.offsetParent !== null).map((i) => [i.complete, i.naturalWidth, i.getAttribute('src')]));
    check(r.length === 1 && r[0][0] && r[0][1] > 0, `About logo not loaded (${theme}): ${JSON.stringify(r)}`);
    check(r[0][2].includes(theme === 'dark' ? 'reversed' : 'horizontal.svg'), `wrong About logo variant for ${theme}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.dialog'));
  };
  await aboutLogo('light');
  await page.click('#theme-toggle');
  await aboutLogo('dark');
  await page.click('#theme-toggle');

  step = 'theme';
  await openFile('ductwork-12.pdf', mainPdf);
  await waitRendered(0);
  await page.click('#theme-toggle');
  check((await page.getAttribute('html', 'data-theme')) === 'dark', 'theme toggle did not set dark');
  check((await page.evaluate(() => localStorage.getItem('ash-pdf-studio:theme'))) === '"dark"', 'theme not persisted in shim settings');
  await page.screenshot({ path: join(OUT, 'dark.png') });
  await boot();
  check((await page.getAttribute('html', 'data-theme')) === 'dark', 'dark theme not restored after reload');
  await page.click('#theme-toggle');
  check((await page.evaluate(() => localStorage.getItem('ash-pdf-studio:theme'))) === '"light"', 'light theme not persisted');
  await page.waitForTimeout(300);
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error('E2E FAILED\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('E2E OK');
