#!/usr/bin/env node
// End-to-end test of File > New PDF (renderer/ui/newpdf.js): the start screen's New PDF… button and
// the File menu open the dialog; the blank document opens as an untouched "Untitled N.pdf" tab of the
// chosen size and page count; an invalid custom size keeps the dialog open with an error; the choices
// are remembered. Chromium via playwright-core. Prints "NEWPDF OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const dlg = '.dialog:has(.dialog-title:text-is("New PDF"))';
  // Tab k: name, dirty, page count and the first page's size in points (from the opened pdf.js document).
  const tabInfo = (k) => page.evaluate(async (k) => {
    const t = window.ashStudio.state.tabs[k];
    const view = (await t.pdfDoc.getPage(1)).view;
    return { name: t.name, path: t.path, dirty: t.dirty, numPages: t.numPages, size: [view[2] - view[0], view[3] - view[1]].map((v) => Math.round(v * 100) / 100) };
  }, k);

  step = 'start screen';
  check((await page.textContent('.welcome-card p')).includes('Open a PDF, create a new one, or drop files here.'), 'welcome line');
  await page.click('.welcome-card button:text-is("New PDF…")');
  await page.waitForSelector(dlg);
  eq(await page.inputValue('#np-size'), 'A4', 'default size');
  eq(await page.inputValue('#np-orientation'), 'portrait', 'default orientation');
  eq(await page.inputValue('#np-pages'), '1', 'default pages');
  check(await page.locator('#np-width').isHidden(), 'custom width hidden for A4');

  step = 'A3 landscape, 3 pages';
  await page.selectOption('#np-size', 'A3');
  await page.selectOption('#np-orientation', 'landscape');
  await page.fill('#np-pages', '3');
  await page.click(`${dlg} button:text-is("Create")`);
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 1 && window.ashStudio.state.tabs[0].numPages === 3, null, { timeout: 10_000 });
  check(!(await page.$(dlg)), 'dialog closed after Create');
  eq(await tabInfo(0), { name: 'Untitled 1.pdf', path: null, dirty: false, numPages: 3, size: [1190.55, 841.89] }, 'first new PDF');
  check(await page.locator('.welcome').isHidden(), 'start screen hidden after creating');
  check((await page.textContent('.toast-host')).includes('Blank PDF ready'), 'toast shown');

  step = 'File menu, remembered choices';
  await page.click('.menu-btn[data-menu="File"]');
  eq(await page.evaluate(() => document.querySelector('.menu[aria-label="File"] .menu-item')?.dataset.id), 'newpdf', 'New PDF is the first File item');
  eq(await page.textContent('.menu[aria-label="File"] .menu-item[data-id="newpdf"] kbd'), 'Ctrl+Shift+N', 'shortcut shown');
  await page.click('.menu[aria-label="File"] .menu-item[data-id="newpdf"]');
  await page.waitForSelector(dlg);
  eq([await page.inputValue('#np-size'), await page.inputValue('#np-orientation'), await page.inputValue('#np-pages')], ['A3', 'landscape', '3'], 'last choices remembered');
  await page.selectOption('#np-size', 'Letter');
  await page.selectOption('#np-orientation', 'portrait');
  await page.fill('#np-pages', '1');
  await page.click(`${dlg} button:text-is("Create")`);
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 2, null, { timeout: 10_000 });
  eq(await tabInfo(1), { name: 'Untitled 2.pdf', path: null, dirty: false, numPages: 1, size: [612, 792] }, 'second new PDF');

  step = 'custom size validation';
  await page.keyboard.press('Control+Shift+N');
  await page.waitForSelector(dlg);
  await page.selectOption('#np-size', 'custom');
  check(await page.locator('#np-width').isVisible(), 'custom width shown');
  await page.fill('#np-width', '10');
  await page.fill('#np-height', '100');
  await page.click(`${dlg} button:text-is("Create")`);
  await page.waitForTimeout(200);
  check(!!(await page.$(dlg)), 'dialog stays open for an invalid width');
  const err = await page.textContent(`${dlg} .pt-error`);
  check(/Width must be 25\.4 to 5080 mm/.test(err), `error text: ${err}`);
  eq(await page.getAttribute('#np-width', 'aria-invalid'), 'true', 'width marked invalid');
  eq(await page.evaluate(() => window.ashStudio.state.tabs.length), 2, 'no tab created for an invalid size');

  step = 'custom size, landscape swap';
  await page.fill('#np-width', '100');
  await page.fill('#np-height', '200');
  await page.selectOption('#np-orientation', 'landscape');
  await page.click(`${dlg} button:text-is("Create")`);
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 3, null, { timeout: 10_000 });
  const pt = (mm) => Math.round(mm * 72 / 25.4 * 100) / 100;
  eq(await tabInfo(2), { name: 'Untitled 3.pdf', path: null, dirty: false, numPages: 1, size: [pt(200), pt(100)] }, 'custom landscape PDF');

  step = 'untouched tab closes without a prompt';
  await page.evaluate(() => window.ashStudio.closeTab());
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 2, null, { timeout: 5_000 });
  check(!(await page.$('.dialog')), 'no discard prompt for an untouched blank tab');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('NEWPDF FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('NEWPDF OK');
