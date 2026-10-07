#!/usr/bin/env node
// End-to-end test of the signed-document save guard (renderer/app.js saveTab + core
// detectSignatures) in Chromium via playwright-core, served over HTTP with the browser shim.
// Saving rewrites the whole file, so an in-place Save of a digitally signed original must ask
// first ("Save as a copy…" / "Overwrite original" / "Cancel"); unsigned files save silently.
// Prints "SIGNED OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { makePdf, makeSignedPdf } from '../helpers.js';

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
  const signed = Buffer.from(await makeSignedPdf());
  const plain = Buffer.from(await makePdf(2));
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const openFile = async (name, buffer) => {
    const chooser = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction((n) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId);
      return t?.name === n && t.view && t.numPages > 0; }, name, { timeout: 10_000 });
    await ev('await tab.signatureCheck;');
  };
  // Rotate page 1 (an edit that makes the tab dirty), then wait for the reload to settle.
  const edit = async () => {
    await ev('await pt.rotate(tab, [0], 90);');
    await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.dirty; }, null, { timeout: 10_000 });
  };
  const fileBytes = () => ev('return [...await window.api.readFile(tab.path)];');
  const dialogButtons = () => page.$$eval('.dialog-backdrop .dialog-buttons button', (bs) => bs.map((b) => [b.textContent, b.classList.contains('primary')]));
  const dialogCount = () => page.$$eval('.dialog-backdrop', (d) => d.length);
  const signedDialog = () => page.waitForSelector('.dialog.signed-dialog', { timeout: 5_000 });
  const clickButton = (label) => page.click(`.dialog.signed-dialog .dialog-buttons button:text-is("${label}")`);
  const BUTTONS = [['Cancel', false], ['Overwrite original', false], ['Save as a copy…', true]];

  step = 'open';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await openFile('signed.pdf', signed);
  const signedPath = await ev('return tab.path;');
  eq(await ev('return tab.signedPath;'), signedPath, 'signed file detected at its path');
  const original = await fileBytes();

  step = 'Save on signed: Cancel';
  await edit();
  await page.click('#btn-save');
  await signedDialog();
  eq(await dialogButtons(), BUTTONS, 'signed dialog buttons');
  check((await page.textContent('.dialog.signed-dialog')).includes('invalidates the signature'), 'dialog explains the signature is invalidated');
  await clickButton('Cancel');
  await page.waitForSelector('.dialog-backdrop', { state: 'detached', timeout: 5_000 });
  await page.waitForTimeout(200);
  eq(await fileBytes(), original, 'original untouched after Cancel');
  eq(await ev('return [tab.dirty, tab.path];'), [true, signedPath], 'tab still dirty on the original after Cancel');

  step = 'Escape cancels too';
  await page.keyboard.press('Control+s');
  await signedDialog();
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dialog-backdrop', { state: 'detached', timeout: 5_000 });
  eq(await fileBytes(), original, 'original untouched after Escape');
  check(await ev('return tab.dirty;'), 'tab not dirty after Escape');

  step = 'close tab -> Save: signed prompt exactly once';
  const closing = ev('return app.closeTab(tab);');
  await page.waitForSelector('.dialog-backdrop .dialog-buttons button:text-is("Save")', { timeout: 5_000 });
  await page.click('.dialog-backdrop .dialog-buttons button:text-is("Save")');
  await signedDialog();
  eq(await dialogCount(), 1, 'one dialog at a time while closing');
  await clickButton('Cancel');
  eq(await closing, false, 'closeTab returns false when the signed prompt is cancelled');
  eq(await dialogCount(), 0, 'no further dialog after Cancel');
  eq(await ev('return [app.state.tabs.length, tab.dirty];'), [1, true], 'tab kept open and dirty');
  eq(await fileBytes(), original, 'original untouched after close + Cancel');

  step = 'Save as a copy';
  await page.click('#btn-save');
  await signedDialog();
  await clickButton('Save as a copy…');
  await page.waitForFunction(() => { const t = window.ashStudio.state.tabs[0]; return !t.dirty; }, null, { timeout: 5_000 });
  const copyPath = await ev('return tab.path;');
  check(copyPath !== signedPath, 'tab now points at the copy');
  eq(await ev('return [...await window.api.readFile(arg)];', signedPath), original, 'original untouched by Save as a copy');
  check(JSON.stringify(await fileBytes()) !== JSON.stringify(original), 'copy holds the edited bytes');
  await edit();
  await page.click('#btn-save');
  await page.waitForFunction(() => !window.ashStudio.state.tabs[0].dirty, null, { timeout: 5_000 });
  eq(await dialogCount(), 0, 'no signed prompt when saving the copy in place');

  step = 'Overwrite original';
  await openFile('signed-2.pdf', signed);
  await edit();
  await page.click('#btn-save');
  await signedDialog();
  await clickButton('Overwrite original');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return !t.dirty; }, null, { timeout: 5_000 });
  check(JSON.stringify(await fileBytes()) !== JSON.stringify(original), 'original overwritten');
  await edit();
  await page.click('#btn-save');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return !t.dirty; }, null, { timeout: 5_000 });
  eq(await dialogCount(), 0, 'asked only once per signed original');

  step = 'unsigned saves without a dialog';
  await openFile('plain.pdf', plain);
  eq(await ev('return tab.signedPath;'), null, 'unsigned file not flagged');
  const before = await fileBytes();
  await edit();
  await page.click('#btn-save');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return !t.dirty; }, null, { timeout: 5_000 });
  eq(await dialogCount(), 0, 'no dialog for an unsigned file');
  check(JSON.stringify(await fileBytes()) !== JSON.stringify(before), 'unsigned file saved in place');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('SIGNED FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('SIGNED OK');
