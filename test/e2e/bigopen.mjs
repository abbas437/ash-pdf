#!/usr/bin/env node
// End-to-end test for opening a big PDF (81 MB material submittal, 18-Oct-2026: blank window for ~60 s while pdf-lib
// parsed it on the UI thread to read its markups and make the view copy).
//  1. Page 1 shows ink long before the annotation reconcile (read + view copy) finishes.
//  2. The UI thread never stalls for a second (the pdf-lib parses run in the core worker).
//  3. Afterwards every markup is an overlay object and the document pdf.js shows is the view copy (no markup
//     annotations left in it: nothing drawn twice).
//  4. Before the swap to the view copy the overlay holds no mirror objects (pdf.js draws the markups then), and
//     a zoom and scroll position set before the swap are kept by it.
// Prints "BIGOPEN OK". Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const PAGES = 70, MARKUPS = 105, OBJS_PER_PAGE = 2500;

/** PAGES pages, each with its own large (incompressible) image XObject, object streams, MARKUPS Square/Highlight markups. */
async function bigPdf() {
  const doc = await PDFDocument.create();
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const W = 600, H = 400;
  for (let p = 0; p < PAGES; p++) {
    const page = doc.addPage([612, 792]);
    const px = new Uint8Array(W * H * 3);
    for (let i = 0; i < px.length; i++) px[i] = (rnd() * 256) | 0;
    const img = doc.context.register(doc.context.stream(px, { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
    page.node.setXObject(PDFName.of('Im0'), img);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(`q 500 0 0 333 56 400 cm /Im0 Do Q`)));
    // Many small objects (in object streams), as a submittal's thousands of fonts, forms and annotations: pdf-lib's
    // parse cost is per object, not per byte.
    page.node.set(PDFName.of('ASHPad'), doc.context.obj(Array.from({ length: OBJS_PER_PAGE }, (_, i) => doc.context.register(doc.context.obj({ Type: 'ASHPad', N: i, V: [p, i, 0.5] })))));
  }
  const pages = doc.getPages();
  for (let k = 0; k < MARKUPS; k++) {
    const page = pages[k % PAGES], x = 60 + (k % 5) * 100, y = 100 + (Math.floor(k / PAGES) * 120);
    const hl = k % 2 === 1;
    const a = doc.context.obj({
      Type: 'Annot', Subtype: hl ? 'Highlight' : 'Square', Rect: [x, y, x + 80, y + 30], C: hl ? [1, 1, 0] : [1, 0, 0],
      T: PDFString.of(`Reviewer ${k % 3}`), NM: PDFString.of(`big-${k}`), F: 4, Border: [0, 0, 1],
      ...(hl ? { QuadPoints: [x, y + 30, x + 80, y + 30, x, y, x + 80, y] } : {}),
    });
    page.node.addAnnot(doc.context.register(a));
  }
  return doc.save({ useObjectStreams: true });
}

const pdf = Buffer.from(await bigPdf());
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/__big.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf); return; }
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const problems = [];
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || /Core worker unavailable/.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');

  step = 'open the big PDF: first ink, longest UI stall, reconcile';
  const r = await page.evaluate(async (MARKUPS) => {
    const bytes = new Uint8Array(await (await fetch('/__big.pdf')).arrayBuffer());
    const ink = (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 31) if (d[i + 3] > 0 && (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200)) return true;
      return false;
    };
    let last = performance.now(), stall = 0;
    const probe = setInterval(() => { const t = performance.now(); stall = Math.max(stall, t - last); last = t; }, 50);
    const t0 = performance.now();
    window.ashStudio.openBytes({ name: 'big.pdf', bytes });
    let firstInk = null, reconciled = null;
    // Before the swap (tab.pdfDoc still the raw document pdf.js draws the markups from) the overlay must hold
    // no mirror objects (else both draw them). A zoom and scroll position set then must survive the swap.
    let raw = null, preSwapObjects = 0, set = null;
    while (performance.now() - t0 < 180_000) {
      await new Promise((res) => setTimeout(res, 25));
      const tab = window.ashStudio.state.tabs.find((t) => t.name === 'big.pdf');
      const c = document.querySelector('.page[data-page-index="0"] canvas.page-canvas');
      if (firstInk == null && c && ink(c)) firstInk = performance.now() - t0;
      if (tab?.pdfDoc && !raw) raw = tab.pdfDoc;
      if (raw && tab.pdfDoc === raw) {
        preSwapObjects = Math.max(preSwapObjects, tab.objects.length);
        if (firstInk != null && !set) {
          window.ashStudio.viewer.setZoom(tab, 1.5);
          const sc = tab.view.scrollEl;
          sc.scrollTop = tab.view.pageEls[5].offsetTop + 123;
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          set = { zoom: tab.zoom, mode: tab.zoomMode, top: sc.scrollTop, preSwap: tab.pdfDoc === raw };
        }
      }
      if ((tab?.objects?.length ?? 0) >= MARKUPS && raw && tab.pdfDoc !== raw && document.querySelector(`.page[data-page-index="${set ? 5 : 0}"].rendered`)) { reconciled = performance.now() - t0; break; }
    }
    clearInterval(probe);
    const tab = window.ashStudio.state.tabs.find((t) => t.name === 'big.pdf');
    let shownMarkups = 0;
    for (let i = 1; i <= tab.pdfDoc.numPages; i++) shownMarkups += (await (await tab.pdfDoc.getPage(i)).getAnnotations()).filter((a) => /^(Square|Highlight)$/.test(a.subtype)).length;
    const svgObjs = document.querySelectorAll('.page[data-page-index="0"] .overlay-svg [data-obj-id]').length;
    const after = { zoom: tab.zoom, mode: tab.zoomMode, top: tab.view.scrollEl.scrollTop, swapped: tab.pdfDoc !== raw };
    return { firstInk: firstInk && Math.round(firstInk), reconciled: reconciled && Math.round(reconciled), stall: Math.round(stall), objects: tab.objects.length, shownMarkups, svgObjs, size: bytes.length, preSwapObjects, set, after };
  }, MARKUPS);
  check(r.firstInk != null, `page 1 never showed ink: ${JSON.stringify(r)}`);
  check(r.reconciled != null, `the reconcile never finished (${r.objects}/${MARKUPS} objects): ${JSON.stringify(r)}`);
  check(r.preSwapObjects === 0, `${r.preSwapObjects} overlay objects before the swap, while pdf.js still draws the markups (drawn twice): ${JSON.stringify(r)}`);
  check(r.firstInk < r.reconciled / 2, `first ink only ${r.firstInk} ms, with the reconcile at ${r.reconciled} ms: ${JSON.stringify(r)}`);
  check(r.stall < 1000, `the UI thread stalled for ${r.stall} ms: ${JSON.stringify(r)}`);
  check(r.objects === MARKUPS, `expected ${MARKUPS} overlay objects: ${JSON.stringify(r)}`);
  check(r.shownMarkups === 0, `the displayed document still has ${r.shownMarkups} markups (drawn twice): ${JSON.stringify(r)}`);
  check(r.svgObjs > 0, `the overlay draws no objects on page 1: ${JSON.stringify(r)}`);
  check(r.set?.preSwap, `the zoom and scroll were not set before the swap: ${JSON.stringify(r)}`);
  check(r.after.swapped, `the view copy was never swapped in: ${JSON.stringify(r)}`);
  check(r.after.zoom === r.set.zoom && r.after.mode === 'custom' && r.set.zoom === 1.5, `zoom not kept across the swap: ${JSON.stringify(r)}`);
  check(r.set.top > 0 && Math.abs(r.after.top - r.set.top) <= 2, `scroll position not kept across the swap: ${JSON.stringify(r)}`);

  check(problems.length === 0, `console/page errors: ${problems.join(' | ')}`);
  console.log(`BIGOPEN OK (${(r.size / 1e6).toFixed(1)} MB, first ink ${r.firstInk} ms, reconciled ${r.reconciled} ms, longest stall ${r.stall} ms, ${r.objects} objects, view copy shown)`);
} catch (err) {
  console.error(`bigopen e2e FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
