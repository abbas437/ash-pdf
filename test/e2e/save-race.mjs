#!/usr/bin/env node
// End-to-end test of edits that overlap a save (renderer/app.js saveTab) in Chromium via
// playwright-core, served over HTTP with the browser shim (same pattern as reload-race.mjs).
// 1. Rotate, save: the tab is clean and the file has the rotation.
// 2. Rotate without awaiting, save at once: the save waits for the page op, so the written file
//    has the rotation and the tab ends clean.
// 3. Save while a gated, bytes-producing (non-transient) beforeSave hook holds it, rotate during
//    the hook, release: the tab must stay dirty and tab.bytes must keep the rotation.
// Prints "SAVE-RACE OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf(n) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= n; k++) doc.addPage([612, 792]).drawText(`Page ${k}`, { x: 72, y: 700, size: 28, font });
  return Buffer.from(await doc.save());
}
const rotations = async (bytes) => (await PDFDocument.load(Uint8Array.from(bytes))).getPages().map((p) => p.getRotation().angle);

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
  const three = await makePdf(3);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  // dirty flag, tab.bytes and the file last written to tab.path
  const snapshot = async () => {
    const s = await ev('return { dirty: tab.dirty, bytes: Array.from(tab.bytes), file: Array.from(await window.api.readFile(tab.path)) };');
    return { dirty: s.dirty, bytes: await rotations(s.bytes), file: await rotations(s.file) };
  };

  step = 'open';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'three.pdf', mimeType: 'application/pdf', buffer: three });
  await page.waitForFunction(() => window.ashStudio.state.tabs[0]?.numPages === 3, null, { timeout: 10_000 });

  step = 'rotate, then save';
  await ev('await pt.rotate(tab, [0], 90);');
  check(await ev('return tab.dirty;'), 'rotate did not mark the tab dirty');
  check(await ev('return await app.saveTab(tab, false);'), 'saveTab returned false');
  eq(await snapshot(), { dirty: false, bytes: [90, 0, 0], file: [90, 0, 0] }, 'after a save with no concurrent edit');

  step = 'save while a page op is still queued';
  check(await ev('const op = pt.rotate(tab, [1], 90); const ok = await app.saveTab(tab, false); await op; return ok;'), 'saveTab returned false');
  eq(await snapshot(), { dirty: false, bytes: [90, 90, 0], file: [90, 90, 0] }, 'after a save started while a rotate was queued');

  step = 'rotate while a save hook runs';
  await ev(`window.__entered = false;
    let release; const gate = new Promise((r) => { release = r; }); window.__release = release;
    // Non-transient: its output is meant to become tab.bytes (like the forms hook).
    const hook = async (t, bytes) => { window.__entered = true; await gate; return bytes.slice(); };
    hook.id = 'test-gate';
    app.state.hooks.beforeSave.unshift(hook);
    window.__save = app.saveTab(tab, false);`);
  await page.waitForFunction(() => window.__entered, null, { timeout: 10_000 });
  check(await ev('return await pt.rotate(tab, [2], 90);'), 'rotate during the save hook was not applied');
  check(await ev('return tab.dirty;'), 'rotate during the save hook did not mark the tab dirty');
  await ev('window.__release();');
  check(await ev('return await window.__save;'), 'gated saveTab returned false');
  await ev("app.state.hooks.beforeSave.splice(app.state.hooks.beforeSave.findIndex((h) => h.id === 'test-gate'), 1);");
  // The file holds the bytes as they were when the save started; the newer edit stays unsaved.
  eq(await snapshot(), { dirty: true, bytes: [90, 90, 90], file: [90, 90, 0] }, 'after an edit that landed during the save');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('SAVE-RACE FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('SAVE-RACE OK');
