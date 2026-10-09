#!/usr/bin/env node
// End-to-end test of Crop pages (renderer/ui/pagetools.js cropDialog + crop-draw.js) in Chromium via
// playwright-core with the browser shim: Pages "2-3,5" with a box drawn on the page, a rotated page,
// handle resize, Esc/Enter, Undo. Prints "CROP OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
import { pdfToVisible, pageGeometry } from '../../src/core/internal.js';

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= 6; k++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${k}`, { x: 72, y: 700, size: 28, font });
    if (k === 3) p.setRotation(degrees(90));
  }
  return Buffer.from(await doc.save());
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, msg, tol = 0.05) => check(a.length === b.length && a.every((x, k) => Math.abs(x - b[k]) <= tol), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const MEDIA = [0, 0, 612, 792];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const six = await makePdf();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const boxes = async () => (await PDFDocument.load(Buffer.from(await ev('return [...tab.bytes];')))).getPages();
  // mark() before a page change, then undoLen(n) waits for its history entry and for the viewer's
  // reload (new page elements, possibly a new fit zoom) so later measurements see the final layout.
  const mark = () => ev('window.__view0 = tab.view;');
  const reloaded = () => page.waitForFunction(() => { const t = window.ashStudio.state.tabs[0]; return t.view && t.view !== window.__view0; }, null, { timeout: 10_000 });
  const undoLen = async (n) => { await page.waitForFunction((k) => (window.ashStudio.state.tabs[0].bytesUndo?.length ?? 0) === k && !document.querySelector('.dialog'), n, { timeout: 10_000 }); await reloaded(); };
  const pageRect = (i) => ev('const r = v.getPageEl(tab, arg).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height };', i);
  const toPage = (x, y) => ev('const h = v.clientToPage(tab, arg[0], arg[1]); return { x: h.x, y: h.y };', [x, y]);
  const drag = async (a, b) => { await page.mouse.move(a[0], a[1]); await page.mouse.down(); await page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); await page.mouse.move(b[0], b[1]); await page.mouse.up(); };
  /** Drag a new box on page i from/to fractions of its on-screen box; returns the expected page-space rect. */
  const drawBox = async (i, f0, f1) => {
    let r = await pageRect(i);
    for (let k = 0; k < 40; k++) { await page.waitForTimeout(50); const r2 = await pageRect(i); if (JSON.stringify(r2) === JSON.stringify(r)) break; r = r2; } // scrolling settled
    const a = [r.left + r.width * f0[0], r.top + r.height * f0[1]], b = [r.left + r.width * f1[0], r.top + r.height * f1[1]];
    const [p, q] = [await toPage(...a), await toPage(...b)];
    await drag(a, b);
    return { rect: { x0: Math.min(p.x, q.x), y0: Math.min(p.y, q.y), x1: Math.max(p.x, q.x), y1: Math.max(p.y, q.y) }, a, b };
  };
  // Visible rect of a page's CropBox, measured on the original (uncropped) geometry.
  const visible = (orig, cb) => {
    const p = pdfToVisible(orig, cb.x, cb.y), q = pdfToVisible(orig, cb.x + cb.width, cb.y + cb.height);
    return [Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y)];
  };
  const origPages = (await PDFDocument.load(six)).getPages().map(pageGeometry);
  const R = (r) => [r.x0, r.y0, r.x1, r.y1];

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'six.pdf', mimeType: 'application/pdf', buffer: six });
  await page.waitForFunction(() => window.ashStudio.state.tabs[0]?.numPages === 6 && document.querySelectorAll('.thumb-list .thumb').length === 6);

  step = 'Pages "2-3,5" + Draw on page';
  await ev('v.scrollToPage(tab, 1); tab.currentPage = 1; app.thumbs.setSelection([]); pt.cropDialog(tab);');
  await page.waitForSelector('#pt-crop-pages');
  await page.fill('#pt-crop-pages', '2-3,5');
  check(await page.isChecked('input[name="pt-crop-to"][value="range"]'), 'typing a range did not choose "Pages:"');
  check(await page.locator('input[name="pt-crop-to"][value="odd"]').count() === 1 && await page.locator('input[name="pt-crop-to"][value="even"]').count() === 1, 'no Odd / Even options');
  await page.selectOption('#pt-crop-unit', 'pt');
  await page.click('#pt-crop-draw');
  await page.waitForSelector('.crop-draw[data-page-index="1"]');
  const d1 = await drawBox(1, [0.2, 0.25], [0.7, 0.6]);
  const w = d1.rect.x1 - d1.rect.x0, hgt = d1.rect.y1 - d1.rect.y0;
  check((await page.textContent('.crop-readout')).trim() === `${w.toFixed(1)} × ${hgt.toFixed(1)} pt`, `readout "${await page.textContent('.crop-readout')}" for ${w} × ${hgt}`);
  near([Number(await page.inputValue('#pt-crop-top')), Number(await page.inputValue('#pt-crop-left'))], [d1.rect.y0, d1.rect.x0], 'margin fields follow the box', 0.01);
  await mark();
  await page.keyboard.press('Enter');
  await undoLen(1);
  let pg = await boxes();
  for (const i of [0, 3, 5]) near(R({ x0: pg[i].getCropBox().x, y0: pg[i].getCropBox().y, x1: pg[i].getCropBox().x + pg[i].getCropBox().width, y1: pg[i].getCropBox().y + pg[i].getCropBox().height }), MEDIA, `page ${i + 1} changed`);
  for (const i of [1, 4]) near(visible(origPages[i], pg[i].getCropBox()), R(d1.rect), `page ${i + 1} crop`);
  // Page 3 is /Rotate 90 (displayed 792 x 612): the same box, clamped to that page.
  const c3 = { x0: d1.rect.x0, y0: d1.rect.y0, x1: Math.min(792, d1.rect.x1), y1: Math.min(612, d1.rect.y1) };
  near(visible(origPages[2], pg[2].getCropBox()), R(c3), 'rotated page 3 crop');

  step = 'undo restores';
  await mark();
  await ev('await pt.undo(tab);');
  await undoLen(0);
  pg = await boxes();
  for (let i = 0; i < 6; i++) { const b = pg[i].getCropBox(); near([b.x, b.y, b.x + b.width, b.y + b.height], MEDIA, `page ${i + 1} after undo`); }

  step = 'rotated current page: Esc cancels the drawing, handle resize, Enter applies';
  await ev('v.scrollToPage(tab, 2); tab.currentPage = 2; pt.cropDialog(tab, { draw: true });');
  await page.waitForSelector('.crop-draw[data-page-index="2"]');
  // A reload while drawing (an Undo landing late) rebuilds the page elements: the box layer follows.
  await mark();
  await ev('app.bus.emit("tab:bytesChanged", { tab });');
  await reloaded();
  check(await ev('return !!v.getPageEl(tab, 2).querySelector(".crop-draw");'), 'the drawing layer did not survive a reload');
  await drawBox(2, [0.1, 0.1], [0.5, 0.5]);
  check(Number(await page.inputValue('#pt-crop-top')) > 0, 'fields not filled by the box');
  await page.keyboard.press('Escape');
  check(await page.locator('.crop-draw').count() === 0, 'Esc did not end the drawing');
  check(await page.locator('.dialog').count() === 1, 'Esc while drawing closed the dialog');
  check(await page.inputValue('#pt-crop-top') === '0', 'Esc did not restore the fields');
  await page.click('#pt-crop-draw');
  const d2 = await drawBox(2, [0.15, 0.2], [0.55, 0.6]);
  const hb = await page.locator('.crop-h-se').boundingBox();
  const from = [hb.x + hb.width / 2, hb.y + hb.height / 2], to = [from[0] + 40, from[1] + 30];
  const [pf, pto] = [await toPage(...from), await toPage(...to)];
  await drag(from, to);
  const exp = { ...d2.rect, x1: d2.rect.x1 + (pto.x - pf.x), y1: d2.rect.y1 + (pto.y - pf.y) };
  await mark();
  await page.keyboard.press('Enter');
  await undoLen(1);
  pg = await boxes();
  near(visible(origPages[2], pg[2].getCropBox()), R(exp), 'rotated page 3 crop after handle resize', 0.1);
  for (const i of [0, 1, 3, 4, 5]) { const b = pg[i].getCropBox(); near([b.x, b.y, b.x + b.width, b.y + b.height], MEDIA, `page ${i + 1} changed by a current-page crop`); }
  await mark();
  await ev('await pt.undo(tab);');
  await undoLen(0);
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('CROP FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('CROP OK');
