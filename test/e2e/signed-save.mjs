#!/usr/bin/env node
// End-to-end test of the incremental save of a signed PDF (renderer/app.js saveTab + core
// appendIncrementalUpdate) in Chromium via playwright-core, served over HTTP with the browser shim.
// Annotation-only changes on a signed original are appended as an update without the overwrite
// warning; a page rotation still asks. Prints "SIGNED-SAVE OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { makeSignedPdf } from '../helpers.js';

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
  const signed = Buffer.from(await makeSignedPdf({ exact: true }));
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, an = app.annotations, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const fileBytes = async () => Buffer.from(await ev('return [...await window.api.readFile(tab.path)];'));
  const isPrefix = (a, b) => b.length > a.length && b.subarray(0, a.length).equals(a);
  const dialogCount = () => page.$$eval('.dialog-backdrop', (d) => d.length);
  const clean = () => page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return !t.dirty; }, null, { timeout: 10_000 });
  const toastSeen = (re) => page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout: 5_000 });

  step = 'open';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: signed });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.name === 'signed.pdf' && t.view && t.numPages > 0; }, null, { timeout: 10_000 });
  await ev('await tab.signatureCheck;');
  const signedPath = await ev('return tab.path;');
  check(signedPath && (await ev('return tab.signedPath;')) === signedPath, 'signed file detected at its path');
  const original = await fileBytes();

  step = 'highlight + Save: appended update, no warning';
  await ev('an.add(tab, { type: "highlight", page: 0, x: 40, y: 80, w: 120, h: 14, color: "#ffff00" });');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.dirty; }, null, { timeout: 5_000 });
  await page.click('#btn-save');
  await clean();
  eq(await dialogCount(), 0, 'no overwrite warning for an annotation-only change');
  await toastSeen(/Saved as an update; the signature is kept/);
  const first = await fileBytes();
  check(isPrefix(original, first), 'saved bytes start with the original signed bytes');
  check(/\/Prev \d+/.test(first.subarray(original.length).toString('latin1')), 'appended trailer has /Prev');

  step = 'second annotation: appended again';
  await ev('an.add(tab, { type: "rect", page: 1, x: 100, y: 100, w: 60, h: 40, stroke: "#ff0000" });');
  await page.click('#btn-save');
  await clean();
  eq(await dialogCount(), 0, 'no warning on the second update');
  const second = await fileBytes();
  check(isPrefix(first, second), 'second save keeps the first output as prefix');

  step = 'Save with nothing changed: nothing written';
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(300);
  eq(await dialogCount(), 0, 'no dialog when nothing changed');
  check((await fileBytes()).equals(second), 'file unchanged when nothing changed');

  step = 'rotate + Save: overwrite warning';
  await ev('await pt.rotate(tab, [0], 90);');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.dirty; }, null, { timeout: 10_000 });
  await page.click('#btn-save');
  await page.waitForSelector('.dialog.signed-dialog', { timeout: 5_000 });
  await page.click('.dialog.signed-dialog .dialog-buttons button:text-is("Cancel")');
  await page.waitForSelector('.dialog-backdrop', { state: 'detached', timeout: 5_000 });
  check((await fileBytes()).equals(second), 'file untouched after Cancel');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('SIGNED-SAVE FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('SIGNED-SAVE OK');
