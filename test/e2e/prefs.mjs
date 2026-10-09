#!/usr/bin/env node
// E2E: Edit > Preferences (settings dialog, tool labels, persistence, default zoom, reset).
// Same harness as run.mjs (browser shim, pdf-lib PDFs). Prints "E2E OK" on success.
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
  const mainPdf = await makeMainPdf();
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

  const openPrefs = async () => {
    await page.keyboard.press('Control+,');
    await page.waitForSelector('.prefs-dlg');
  };
  const section = (id) => page.click(`.prefs-tab[data-section="${id}"]`);
  const ok = () => page.click('.prefs-dlg .dialog-buttons [data-value="ok"]');
  const labelsShown = () => page.evaluate(() => {
    const b = document.querySelector('#btn-open');
    return document.body.classList.contains('tool-labels') && getComputedStyle(b, '::after').content === `"${b.dataset.label}"` && b.dataset.label === 'Open';
  });
  const setting = (k) => page.evaluate((key) => JSON.parse(localStorage.getItem(`ash-pdf-studio:${key}`) ?? 'null'), k);

  step = 'boot';
  await boot();
  check((await page.getAttribute('html', 'data-theme')) === 'light', 'default theme is not light');
  check(!(await labelsShown()), 'tool labels shown by default');

  step = 'set preferences';
  await openPrefs();
  await page.check('.prefs-dlg input[name="theme"][value="dark"]');
  await section('documents');
  await page.selectOption('.prefs-dlg select[name="view.defaultZoom"]', '1');
  await section('annotations');
  await page.fill('.prefs-dlg input[name="annotations.author"]', 'QA Tester');
  check(await page.isChecked('.prefs-dlg input[name="sign.applyNoConfirm"]'), 'Ask before applying a signature not on by default');
  await page.uncheck('.prefs-dlg input[name="sign.applyNoConfirm"]');
  await section('toolbar');
  await page.check('.prefs-dlg input[name="ui.toolLabels"]');
  await page.screenshot({ path: join(OUT, 'prefs-light.png') });
  await ok();
  await page.waitForSelector('.prefs-dlg', { state: 'detached' });
  check((await page.getAttribute('html', 'data-theme')) === 'dark', 'OK did not switch to dark');
  check(await labelsShown(), 'OK did not show tool labels');
  await page.screenshot({ path: join(OUT, 'prefs-labels-dark.png') });

  step = 'reload persists';
  await boot();
  check((await page.getAttribute('html', 'data-theme')) === 'dark', 'dark theme not persisted');
  check(await labelsShown(), 'tool labels not persisted after reload');
  check((await page.evaluate(() => window.ashStudio.annotations.getAuthor())) === 'QA Tester', 'author not persisted');
  check((await setting('view.defaultZoom')) === '1', 'default zoom not persisted');
  check((await setting('sign.applyNoConfirm')) === true, 'unticked Ask before applying a signature not saved as sign.applyNoConfirm');
  await openPrefs();
  await section('annotations');
  check(!(await page.isChecked('.prefs-dlg input[name="sign.applyNoConfirm"]')), 'dialog shows Ask before applying a signature ticked');
  check((await page.inputValue('.prefs-dlg input[name="annotations.author"]')) === 'QA Tester', 'dialog does not show saved author');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.prefs-dlg', { state: 'detached' });

  step = 'default zoom on open';
  await openFile('ductwork-12.pdf', mainPdf);
  await waitRendered(0);
  const z = await ev('return { mode: tab.zoomMode, zoom: tab.zoom, sel: document.querySelector(".zoom-select").value };');
  check(z.mode === 'custom' && z.zoom === 1 && z.sel === '1', `document did not open at 100 %: ${JSON.stringify(z)}`);

  step = 'view menu toggle';
  await page.click('.menu-btn:text-is("View")');
  await page.click('.menu-item[data-id="toollabels"]');
  check(!(await labelsShown()), 'View > Show tool labels did not hide labels');
  check((await setting('ui.toolLabels')) === false, 'menu toggle not persisted');
  await page.click('.menu-btn:text-is("View")');
  await page.click('.menu-item[data-id="toollabels"]');
  check(await labelsShown(), 'View > Show tool labels did not show labels');

  step = 'reset to defaults';
  await openPrefs();
  await page.click('.prefs-dlg .dialog-buttons [data-value="reset"]');
  check(await page.isVisible('.prefs-dlg'), 'Reset closed the dialog');
  await ok();
  await page.waitForSelector('.prefs-dlg', { state: 'detached' });
  check((await page.getAttribute('html', 'data-theme')) === 'light', 'reset did not restore light theme');
  check(!(await labelsShown()), 'reset did not hide tool labels');
  check((await setting('view.defaultZoom')) === 'fit-width', 'reset did not restore default zoom');
  check((await setting('sign.applyNoConfirm')) === false, 'reset did not bring back the Apply signature confirmation');
  check((await page.evaluate(() => window.ashStudio.annotations.getAuthor())) !== 'QA Tester', 'reset did not clear author');
  await boot();
  check((await page.getAttribute('html', 'data-theme')) === 'light' && !(await labelsShown()), 'reset not persisted');
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
