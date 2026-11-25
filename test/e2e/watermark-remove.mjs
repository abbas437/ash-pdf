#!/usr/bin/env node
// End-to-end test of Document > Remove watermark… (renderer/ui/pagemarks.js removeWatermarkDialog) in
// Chromium via playwright-core, served over HTTP with the browser shim (same pattern as pagemarks.mjs;
// run `node scripts/vendor.js` first). The fixture is test/watermark-fixture.js plus a PDF Studio
// watermark on every page. Prints "WATERMARK REMOVE OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { watermarkFixture } from '../watermark-fixture.js';
import { addWatermark } from '../../src/core/pagemarks.js';
import { findWatermarks } from '../../src/core/watermarks.js';

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
  const marked = Buffer.from(await addWatermark(await watermarkFixture(), { text: 'OURSWM' }));
  const plainDoc = await PDFDocument.create();
  plainDoc.addPage([612, 792]).drawText('Plain body', { x: 72, y: 700, size: 20, font: await plainDoc.embedFont(StandardFonts.Helvetica) });
  const plain = Buffer.from(await plainDoc.save());

  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const text = async () => (await ev(`const d = await v.pdfjs.getDocument({ data: tab.bytes.slice() }).promise; const out = [];
    for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join(' '));
    await d.loadingTask.destroy(); return out;`)).join(' | ');
  const bytes = async () => Uint8Array.from(await ev('return Array.from(tab.bytes);'));
  const waitUndo = (n) => page.waitForFunction((k) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return (t.bytesUndo?.length ?? 0) === k && t.pdfDoc; }, n, { timeout: 10_000 });
  const menu = async (id) => {
    await page.click('.menu-btn:text-is("Document")');
    await page.waitForFunction((x) => !document.querySelector(`.menu [data-id="${x}"]`).disabled, id, { timeout: 5000 });
    await page.locator(`.menu [data-id="${id}"]`).click();
  };
  const open = async (name, buffer, pages) => {
    const chooser = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction(([nm, n]) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.name === nm && t.numPages === n && t.pdfDoc; }, [name, pages], { timeout: 10_000 });
  };
  const WATERMARKS = ['OURSWM', 'DRAFT', 'NESTEDWM', 'NAMEDWM', 'FORMWM', 'ACROWM'];
  const BODY = ['Body text one', 'Body text two', 'Form body', 'Second body', 'Tail text'];

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await open('marked.pdf', marked, 3);
  let t = await text();
  for (const w of [...WATERMARKS, ...BODY]) check(t.includes(w), `fixture shows ${w}: ${t}`);

  step = 'dialog lists the three kinds';
  await menu('marks-remove-watermark');
  await page.waitForSelector('.wm-dialog');
  const rows = await page.$$eval('.wm-dialog .wm-kind', (els) => els.map((e) => [e.querySelector('input').checked, e.textContent.trim()]));
  eq(rows, [[true, 'PDF Studio watermark (3 pages)'], [true, 'Watermark from another program (2 pages)'], [true, 'Watermark annotations (1)']], 'kinds found, all ticked');
  check((await page.textContent('.wm-dialog')).includes("Only remove watermarks you are entitled to remove, such as your own or your organisation's DRAFT or FOR REVIEW marks."), 'entitlement line shown');
  check(!(await page.$('.wm-dialog .wm-signed')), 'no signature warning on an unsigned document');

  step = 'remove all but the annotations';
  await page.uncheck('#wm-annots');
  await page.click('.wm-dialog .dialog-buttons .btn.primary');
  await page.waitForSelector('.wm-dialog', { state: 'detached', timeout: 10_000 });
  await waitUndo(1);
  await page.waitForSelector('.toast:text-is("Removed watermark from 3 pages")', { timeout: 5000 });
  t = await text();
  for (const w of WATERMARKS) check(!t.includes(w), `${w} removed: ${t}`);
  for (const w of BODY) check(t.includes(w), `${w} kept: ${t}`);
  let left = await findWatermarks(await bytes());
  eq([left.ash, left.other, left.annots.count], [[], [], 1], 'only the unticked kind (annotations) is left');
  check(await ev('return tab.requiresFullSave === true;'), 'page content rewritten: the next save is a full save');

  step = 'undo / redo';
  await ev('await pt.undo(tab);'); await waitUndo(0);
  t = await text();
  for (const w of WATERMARKS) check(t.includes(w), `undo brings ${w} back: ${t}`);
  left = await findWatermarks(await bytes());
  eq([left.ash.length, left.other.length, left.annots.count], [3, 2, 1], 'undo restores every kind');
  await ev('await pt.redo(tab);'); await waitUndo(1);
  t = await text();
  for (const w of WATERMARKS) check(!t.includes(w), `redo removes ${w} again: ${t}`);
  for (const w of BODY) check(t.includes(w), `${w} kept after redo: ${t}`);

  step = 'no watermark: toast, no dialog';
  await open('plain.pdf', plain, 1);
  await menu('marks-remove-watermark');
  await page.waitForSelector(".toast:text-is(\"No watermark found. A watermark that is part of a scanned image or drawn as ordinary content can't be found.\")", { timeout: 5000 });
  check(!(await page.$('.wm-dialog')), 'no dialog when nothing is found');
  check((await text()).includes('Plain body'), 'plain document unchanged');

  if (problems.length) throw new Error(`page problems:\n${problems.join('\n')}`);
  console.log('WATERMARK REMOVE OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
