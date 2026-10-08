#!/usr/bin/env node
// Reading mode e2e (browser shim): Ctrl+H hides the chrome and fits width, the control strip shows on mouse move and
// fades, next page works, Esc / Ctrl+H restore the layout and previous zoom, setFullScreen rejects non-booleans.
// Run `node scripts/vendor.js` first. Prints "E2E OK" on success.
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

  const hidden = (sel) => page.evaluate((s) => document.querySelector(s).offsetHeight === 0, sel);
  const zoomState = () => ev('return { zoom: tab.zoom, mode: tab.zoomMode };');

  step = 'boot';
  await boot();
  await page.evaluate(() => localStorage.clear());
  await openFile('ductwork-12.pdf', mainPdf);
  await waitRendered(0);
  await setZoomUI('1.5');
  const before = await zoomState();
  const layout = () => page.evaluate(() => ['.toolbar', '.sidebar', '.menubar', '.tabstrip', '.statusbar'].map((s) => document.querySelector(s).offsetHeight > 0 || document.querySelector(s).offsetWidth > 0));
  check((await layout()).every(Boolean), 'chrome not visible before reading mode');

  step = 'enter reading mode (Ctrl+H)';
  await page.keyboard.press('Control+h');
  await settle();
  for (const s of ['.toolbar', '.sidebar', '.menubar', '.tabstrip', '.statusbar', '.options-bar']) check(await hidden(s), `${s} still visible in reading mode`);
  check((await zoomState()).mode === 'fit-width', 'reading mode did not fit width');
  const fit = await ev('const r = v.getPageEl(tab, 0).getBoundingClientRect(), s = v.getScrollEl(tab).getBoundingClientRect(); return { pw: r.width, sw: v.getScrollEl(tab).clientWidth };');
  check(fit.pw <= fit.sw && fit.pw > fit.sw - 80, `page does not fit width: page ${fit.pw}, scroll area ${fit.sw}`);
  check((await page.evaluate(() => getComputedStyle(document.querySelector('.viewer-host')).backgroundColor)) === 'rgb(59, 59, 59)', 'surround is not dark grey');

  step = 'control strip';
  await page.mouse.move(300, 300); await page.mouse.move(340, 320);
  await page.waitForFunction(() => document.querySelector('.rm-strip.on'));
  check((await page.textContent('.rm-page')).trim() === '1 / 12', `strip page label: ${await page.textContent('.rm-page')}`);
  await page.click('#rm-next');
  await page.waitForFunction(() => window.ashStudio.state.tabs.find((t) => t.id === window.ashStudio.state.activeId).currentPage === 1);
  check((await page.textContent('.rm-page')).trim() === '2 / 12', 'strip label did not follow next page');
  await page.mouse.move(10, 10);
  await page.waitForFunction(() => !document.querySelector('.rm-strip.on'), null, { timeout: 4000 });
  await page.keyboard.press('Space'); await settle();
  check((await ev('return tab.currentPage;')) === 2, 'Space did not advance a page');

  step = 'exit with Esc restores layout and zoom';
  await page.keyboard.press('Escape');
  await settle();
  check((await layout()).every(Boolean), 'chrome not restored after Esc');
  const after = await zoomState();
  check(after.mode === before.mode && after.zoom === before.zoom, `zoom not restored: ${JSON.stringify(after)} vs ${JSON.stringify(before)}`);

  step = 'Ctrl+H toggles back off';
  await page.keyboard.press('Control+h'); await settle();
  check(await hidden('.toolbar'), 'second entry failed');
  await page.keyboard.press('Control+h'); await settle();
  check(!(await hidden('.toolbar')), 'Ctrl+H did not exit');

  step = 'setFullScreen validates';
  const rej = await page.evaluate(async () => { try { await window.api.setFullScreen('yes'); return 'ok'; } catch (e) { return 'rejected'; } });
  check(rej === 'rejected', 'shim accepted a non-boolean');
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
