#!/usr/bin/env node
// End-to-end test of renderer/ui/viewextras.js (Layers tab, print options) in Chromium via
// playwright-core, served over HTTP with the browser shim. Prints "VIEWEXTRAS OK".
// Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

// 3 pages; page 1 has a red square in layer "Walls" (left) and a blue square in layer "Ducts" (right).
// In page space (top-left origin) the red square covers x 72..272, y 192..392; the blue one x 340..540.
async function makeLayeredPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const walls = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Walls') }));
  const ducts = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Ducts') }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [walls, ducts], D: ctx.obj({ Order: [walls, ducts], ON: [walls, ducts] }) }));
  for (let n = 1; n <= 3; n++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${n}`, { x: 72, y: 720, size: 24, font });
    if (n !== 1) continue;
    page.node.normalizedEntries().Resources.set(PDFName.of('Properties'), ctx.obj({ oc1: walls, oc2: ducts }));
    const ops = '/OC /oc1 BDC 1 0 0 rg 72 400 200 200 re f EMC\n/OC /oc2 BDC 0 0 1 rg 340 400 200 200 re f EMC\n';
    page.node.addContentStream(ctx.register(ctx.stream(ops)));
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
await mkdir(OUT, { recursive: true });

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

// Colour class of the pixel at page point (x, y) of a canvas showing the whole 612 x 792 page.
const SAMPLE = `const sample = (c, x, y) => { if (!c || !c.width) return null; const k = c.width / 612;
  const d = c.getContext('2d').getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data;
  return d[0] > 200 && d[1] < 80 && d[2] < 80 ? 'red' : d[2] > 200 && d[0] < 80 && d[1] < 80 ? 'blue' : d[1] > 200 && d[0] < 80 && d[2] < 80 ? 'green' : d[0] > 230 && d[1] > 230 && d[2] > 230 ? 'white' : 'other'; };`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = await makeLayeredPdf();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  // page pixel + thumbnail pixel at the centre of each layer's square
  const pixels = () => page.evaluate(new Function(`${SAMPLE}
    const pc = document.querySelector('.page[data-page-index="0"] canvas.page-canvas');
    const tc = document.querySelector('.thumb[data-page-index="0"] canvas.thumb-canvas');
    return { page: [sample(pc, 172, 292), sample(pc, 440, 292)], thumb: [sample(tc, 172, 292), sample(tc, 440, 292)] };`));
  const waitPixels = async (want, what) => {
    const until = Date.now() + 8000;
    let got;
    while (Date.now() < until) { got = await pixels(); if (JSON.stringify(got) === JSON.stringify(want)) return; await page.waitForTimeout(100); }
    throw new Error(`${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };
  const showTab = (id) => page.evaluate((x) => window.ashStudio.showSidebarTab(x), id);

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'layers.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => window.ashStudio.state.tabs[0]?.numPages === 3);

  step = 'layers tab lists the groups';
  await showTab('layers');
  await page.waitForSelector('input[data-layer-id]');
  eq(await page.$$eval('.vx-layer', (els) => els.map((e) => [e.textContent, e.querySelector('input').checked])), [['Walls', true], ['Ducts', true]], 'layer list');

  step = 'hiding a layer changes the page and the thumbnail';
  await showTab('thumbs');
  await waitPixels({ page: ['red', 'blue'], thumb: ['red', 'blue'] }, 'initial render');
  await showTab('layers');
  await page.click('.vx-layer:has-text("Walls") input');
  await showTab('thumbs');
  await waitPixels({ page: ['white', 'blue'], thumb: ['white', 'blue'] }, 'after hiding Walls');
  await page.screenshot({ path: join(OUT, 'viewextras-layer-hidden.png') });

  step = 'hide all / show all';
  await showTab('layers');
  await page.click('[data-action="hide-all"]');
  eq(await page.$$eval('.vx-layer input', (els) => els.map((e) => e.checked)), [false, false], 'checkboxes after Hide all');
  await showTab('thumbs');
  await waitPixels({ page: ['white', 'white'], thumb: ['white', 'white'] }, 'after Hide all');
  await showTab('layers');
  await page.click('[data-action="show-all"]');
  await showTab('thumbs');
  await waitPixels({ page: ['red', 'blue'], thumb: ['red', 'blue'] }, 'after Show all');

  step = 'no layers message';
  await showTab('thumbs');
  const empty = await page.evaluate(() => {
    const app = window.ashStudio, t = app.state.tabs[0], keep = t.ocConfig;
    t.ocConfig = null; app.showSidebarTab('layers');
    const txt = [...document.querySelectorAll('.sb-empty')].find((e) => e.offsetParent)?.textContent;
    t.ocConfig = keep; app.showSidebarTab('thumbs');
    return txt;
  });
  eq(empty, 'This document has no layers', 'empty layer message');

  step = 'print dialog: range 2-3';
  // Record what reaches the print container; keep the blob URLs alive so the test can decode them.
  await page.evaluate(() => {
    URL.revokeObjectURL = () => {};
    window.__prints = [];
    window.print = () => { window.__prints.push([...document.querySelectorAll('.print-container img')].map((i) => i.src)); };
  });
  await page.click('.menu-btn:text-is("File")');
  await page.click('.menu [data-id="print"]');
  await page.waitForSelector('.vx-print-dialog');
  await page.selectOption('#vx-print-pages', 'range');
  await page.fill('#vx-print-range', '7');
  await page.click('.vx-print-dialog .btn.primary');
  check(/outside/.test(await page.textContent('.vx-error')), 'bad range is reported and keeps the dialog open');
  await page.fill('#vx-print-range', '2-3');
  await page.click('.vx-print-dialog .btn.primary');
  await page.waitForFunction(() => window.__prints.length === 1, null, { timeout: 8000 }).catch(async (e) => { throw new Error(`${e.message}; dialogs: ${await page.evaluate(() => [...document.querySelectorAll(".dialog")].map((d) => d.textContent).join(" / "))}; ${problems.join(" ")}`); });
  eq(await page.evaluate(() => window.__prints[0].length), 2, 'page images for range 2-3');

  // Decode printed image k of print job j and sample it.
  const printed = (j, k) => page.evaluate(new Function('a', `${SAMPLE}
    return (async () => { const img = new Image(); img.src = window.__prints[a[0]][a[1]]; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
      return [sample(c, 172, 292), sample(c, 440, 292), sample(c, 300, 500)]; })();`), [j, k]);

  step = 'Ctrl+P, current page, hidden layer and unsaved annotations';
  await showTab('layers');
  await page.click('.vx-layer:has-text("Ducts") input');
  await page.evaluate(() => { const t = window.ashStudio.state.tabs[0]; t.objects = [...(t.objects ?? []), { id: 'vx-test', page: 0, type: 'rect', x: 250, y: 450, w: 100, h: 100, fill: '#00ff00', stroke: null }]; });
  await page.click('.viewer-scroll');
  await page.keyboard.press('Control+p');
  await page.waitForSelector('.vx-print-dialog');
  await page.selectOption('#vx-print-pages', 'current');
  await page.click('.vx-print-dialog .btn.primary');
  await page.waitForFunction(() => window.__prints.length === 2);
  eq(await printed(1, 0), ['red', 'white', 'green'], 'printed page 1 (Ducts hidden, unsaved rect included)');

  step = 'annotations off, two copies';
  await page.keyboard.press('Control+p');
  await page.waitForSelector('.vx-print-dialog');
  await page.selectOption('#vx-print-pages', 'current');
  await page.selectOption('#vx-print-annots', 'no');
  await page.fill('#vx-print-copies', '2');
  await page.click('.vx-print-dialog .btn.primary');
  await page.waitForFunction(() => window.__prints.length === 3);
  eq(await page.evaluate(() => window.__prints[2].length), 2, 'two copies of one page');
  eq(await printed(2, 0), ['red', 'white', 'white'], 'printed page 1 without annotations');

  if (problems.length) throw new Error(`page problems:\n${problems.join('\n')}`);
  console.log('VIEWEXTRAS OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
