#!/usr/bin/env node
// End-to-end test for fast draw: heavy pages drawn by PDFium in the main view (renderer/ui/viewer.js, FAST_DRAW;
// renderer/pdfium/pagerender.js). A page whose first pdf.js render is not done within 1500 ms is drawn by PDFium
// as well and the first to finish is shown; later renders of that page go straight to PDFium.
//  1. A document with light pages only never starts PDFium (no pdfium.wasm request, pdfium.started false).
//  2. Heavy page 2 (non-integer A3 box with a non-zero origin, 700k segments) ends up drawn by PDFium; light page 1
//     and heavy page 3 with a form field (not eligible) are drawn by pdf.js.
//  3. Zooming in re-renders page 2 with PDFium without starting pdf.js on it.
//  4. PDFium's canvas lines up with pdf.js's drawing of the same page at the same canvas size, unrotated and with
//     the view rotated 90 degrees: the darkness-weighted centroids of 140 small black squares spread over the page
//     agree to within MAX_SHIFT px on each axis. At zoom 2.5 the canvas is ~4000 px wide, so a 0.5% scale or offset
//     error moves the far squares by ~20 px, and a page size truncated to whole points (1190.55 x 841.89 ->
//     1190 x 841) by ~1.8 px (x) and ~3 px (y) at the far edges. Measured: the renderers differ by a sawtooth of
//     at most ~0.5 px per axis (one of them snaps filled rectangles to device pixels), antialiasing included.
//     The metric is checked to reject a 0.5% scale error and a 0.5% offset error in the same run.
//  5. Eligibility (eligible.pdf, threshold lowered so each heavy page races): text in a non-embedded font that is not
//     one of the standard 14 (TrueType ArialUnicodeMS on the page and inside a form XObject; Type0 MS-Gothic
//     UniJIS-UCS2-H) and a Link with an /AP keep pdf.js; a Link without /AP and non-embedded Helvetica go to PDFium.
//     With two documents drawn, the worker keeps at most one parsed page.
//  6. A tab closed while its page waits for the eligibility answer leaves no PDFium document open; closing every
//     tab closes all of them.
//  6b. A reload (tab:bytesChanged) closes the old PDFium document: the open-document count does not grow.
//  6c. A heavy page drawn by PDFium goes back to pdf.js once a layer (optional content group) is hidden.
//  6d. When PDFium wins, pdf.js's render of the page is cancelled and the page holds exactly one canvas.
//  6e. Fast scroll (own page): 12 known-heavy pages, scrolled through at 100 ms a page. The page stopped on is drawn
//      within ~two PDFium renders (the one in flight, then its own) instead of behind every page scrolled past, and an
//      editing call (pdfium.pageCount) made meanwhile waits for at most the render in flight; the client queue posts
//      fewer renders than were asked for (pdfium.stats().renders), and once the page is drawn no request for a page
//      scrolled past still waits in it.
//  6f. Fast scroll stopping mid-document (pages S and S+1 visible) while a render is in flight: the renders posted
//      after it follow the viewer's order (S, S+1, then the off-screen neighbours S+2 and S-1), and S is drawn within
//      the 6e bound.
//  6g. A tab closed while a known-heavy page waits for its eligibility answer opens no PDFium document.
//  7. Page 2 completes in less than half the time pdf.js alone needs for it (fast draw off, measured first in a
//     fresh page of the same browser so the two runs share neither memory nor workers).
// Prints "FASTDRAW OK". Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const MAX_SHIFT = 1; // canvas px per axis, largest centroid disagreement accepted (see 4. above)
const COLS = 14, ROWS = 10;

/** `n` short white strokes (cost for the renderers, no ink), then COLS x ROWS black 3 pt squares. Origin = box corner. */
function heavyContent(n, [ox, oy, w, h]) {
  const parts = ['0.2 w 1 1 1 RG'];
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < n; i++) {
    const x = ox + 20 + rnd() * (w - 40), y = oy + 20 + rnd() * (h - 40);
    parts.push(`${x.toFixed(2)} ${y.toFixed(2)} m ${(x + rnd() * 6).toFixed(2)} ${(y + rnd() * 6).toFixed(2)} l S`);
  }
  parts.push('0 0 0 rg');
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const x = ox + 30.37 + c * ((w - 64) / (COLS - 1)), y = oy + 25.61 + r * ((h - 56) / (ROWS - 1));
    parts.push(`${x.toFixed(3)} ${y.toFixed(3)} 3 3 re f`);
  }
  return parts.join('\n');
}

async function fastPdf() {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([1190.55, 841.89]); // same width as page 2: fit-width keeps its scale when page 2 becomes current
  p1.drawRectangle({ x: 72, y: 600, width: 200, height: 100, color: rgb(0.2, 0.3, 0.8) });
  const p2 = doc.addPage([1190.55, 841.89]);
  const box2 = [10.25, 15.5, 1190.55, 841.89];
  p2.setMediaBox(...box2);
  p2.node.set(doc.context.obj('Contents'), doc.context.register(doc.context.flateStream(heavyContent(700_000, box2))));
  const p3 = doc.addPage([1190.55, 841.89]);
  doc.getForm().createTextField('ref').addToPage(p3, { x: 72, y: 760, width: 200, height: 22 });
  p3.node.set(doc.context.obj('Contents'), doc.context.register(doc.context.flateStream(heavyContent(150_000, [0, 0, 1190.55, 841.89]))));
  return doc.save();
}
/** Heavy pages that must keep pdf.js (expect 'pdfjs') or may use PDFium ('pdfium'); see 5. above. */
const ELIGIBLE = [['ArialUnicodeMS text', 'pdfjs'], ['MS-Gothic Type0 text', 'pdfjs'], ['ArialUnicodeMS text in a form XObject', 'pdfjs'],
  ['Link with /AP', 'pdfjs'], ['Link without /AP', 'pdfium'], ['Helvetica (standard 14) text', 'pdfium']];
async function eligiblePdf() {
  const doc = await PDFDocument.create(), ctx = doc.context, size = [841.89, 595.28];
  const descriptor = (name) => ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: name, Flags: 32, FontBBox: [-200, -300, 1200, 1000], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80 }));
  const arial = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'ArialUnicodeMS', FirstChar: 32, LastChar: 126,
    Widths: Array(95).fill(600), Encoding: 'WinAnsiEncoding', FontDescriptor: descriptor('ArialUnicodeMS') })); // no FontFile2
  const gothic = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'MS-Gothic', Encoding: 'UniJIS-UCS2-H', DescendantFonts: [ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'MS-Gothic', CIDSystemInfo: { Registry: ctx.obj('(Adobe)'), Ordering: ctx.obj('(Japan1)'), Supplement: 2 }, DW: 1000, FontDescriptor: descriptor('MS-Gothic') }))] }));
  const helvetica = (await doc.embedFont(StandardFonts.Helvetica)).ref; // pdf-lib never embeds the standard 14
  const label = '0 0 0 rg BT /F1 28 Tf 200 300 Td (LABEL 4711 ABC) Tj ET';
  const linkAP = (ap) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [200, 300, 500, 340], Border: [0, 0, 0], A: { S: 'URI', URI: ctx.obj('(https://example.com/)') },
    ...(ap ? { AP: { N: ctx.register(ctx.flateStream('0.9 0.1 0.1 rg 0 0 300 40 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 40] })) } } : {}) }));
  const pages = [
    { font: arial, text: label }, { font: gothic, text: '0 0 0 rg BT /F1 28 Tf 200 300 Td <65E5672C8A9E> Tj ET' },
    { form: ctx.register(ctx.flateStream(label, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 841.89, 595.28], Resources: { Font: { F1: arial } } })), text: '/X1 Do' },
    { annot: linkAP(true) }, { annot: linkAP(false) }, { font: helvetica, text: label },
  ];
  for (const { font, form, annot, text = '' } of pages) {
    const p = doc.addPage(size);
    if (font) p.node.setFontDictionary(PDFName.of('F1'), font);
    if (form) p.node.setXObject(PDFName.of('X1'), form);
    if (annot) p.node.addAnnot(annot);
    p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(`${heavyContent(150_000, [0, 0, ...size])}\n${text}`)));
  }
  return doc.save();
}
/** One heavy page; a black square on it belongs to layer "Part" (optional content, visible by default). */
async function layersPdf() {
  const doc = await PDFDocument.create(), ctx = doc.context, size = [841.89, 595.28];
  const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Part') }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [ocg], D: { ON: [ocg], Order: [ocg] } }));
  const p = doc.addPage(size);
  p.node.Resources().set(PDFName.of('Properties'), ctx.obj({ L1: ocg }));
  p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(`${heavyContent(150_000, [0, 0, ...size])}\n/OC /L1 BDC 0 0 0 rg 300 200 200 200 re f EMC`)));
  return doc.save();
}
const MANY = 12;
/** MANY copies of fast.pdf's heavy page (one shared content stream). */
async function manyPdf() {
  const doc = await PDFDocument.create(), box = [0, 0, 1190.55, 841.89];
  const contents = doc.context.register(doc.context.flateStream(heavyContent(700_000, box)));
  for (let i = 0; i < MANY; i++) doc.addPage([box[2], box[3]]).node.set(PDFName.of('Contents'), contents);
  return doc.save();
}
async function lightPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]).drawRectangle({ x: 72, y: 600, width: 200, height: 100, color: rgb(0.8, 0.3, 0.2) });
  return doc.save();
}

const files = { '/__fast.pdf': await fastPdf(), '/__light.pdf': await lightPdf(), '/__eligible.pdf': await eligiblePdf(), '/__layers.pdf': await layersPdf(), '/__many.pdf': await manyPdf() };
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (files[pathname]) { res.writeHead(200, { 'content-type': 'application/pdf' }).end(Buffer.from(files[pathname])); return; }
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const problems = [];
const wasmRequests = [];
let step = 'start';
/** A fresh app page (own renderer process) with the test helpers as window.__fd. */
async function appPage() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('request', (r) => { if (/pdfium\.wasm/.test(r.url())) wasmRequests.push(r.url()); });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.evaluate(() => {
    const app = window.ashStudio;
    // page i of `tab`'s view (default: the first in the DOM - only one document is open when that is used)
    const pageEl = (i, tab) => (tab ? tab.view.pageEls[i] : document.querySelector(`.page[data-page-index="${i}"]`));
    window.__fd = {
      tab: (name) => app.state.tabs.find((t) => t.name === name),
      pageEl,
      /** Resolve when page i of the active view is rendered and pred(pageEl) holds; ms since t0. */
      async rendered(i, t0, pred = () => true, timeout = 120_000, tab = undefined) {
        while (performance.now() - t0 < timeout) {
          const el = pageEl(i, tab);
          if (el?.classList.contains('rendered') && pred(el)) return performance.now() - t0;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`page ${i + 1} did not render within ${timeout} ms`);
      },
      async open(name) {
        const bytes = new Uint8Array(await (await fetch('/__fast.pdf')).arrayBuffer());
        const t0 = performance.now();
        await app.openBytes({ name, bytes });
        const tab = window.__fd.tab(name);
        app.viewer.scrollToPage(tab, 1);
        const ms = await window.__fd.rendered(1, t0);
        return { ms: Math.round(ms), renderer: pageEl(1).dataset.renderer };
      },
      /** Weighted (darkness) centroids of the black squares: components of the reference, measured in both. */
      compare(ref, test, { warp = null } = {}) {
        const W = ref.width, H = ref.height;
        const dark = (c) => { const d = c.getContext('2d').getImageData(0, 0, W, H).data, o = new Float32Array(W * H); for (let p = 0; p < o.length; p++) o[p] = 255 - (d[4 * p] + d[4 * p + 1] + d[4 * p + 2]) / 3; return o; };
        const a = dark(ref);
        let b = dark(test);
        if (warp) { // nearest-neighbour resample: pixel (x, y) shows what was at warp(x, y) - the metric's self-check
          const w = new Float32Array(W * H);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [sx, sy] = warp(x, y).map(Math.round); if (sx >= 0 && sy >= 0 && sx < W && sy < H) w[y * W + x] = b[sy * W + sx]; }
          b = w;
        }
        const seen = new Uint8Array(W * H), comps = [];
        for (let p = 0; p < W * H; p++) {
          if (seen[p] || a[p] < 128) continue;
          let x0 = W, y0 = H, x1 = 0, y1 = 0;
          const stack = [p]; seen[p] = 1;
          while (stack.length) {
            const q = stack.pop(), x = q % W, y = (q - x) / W;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            for (const n of [q - 1, q + 1, q - W, q + W]) if (n >= 0 && n < W * H && !seen[n] && a[n] >= 128 && Math.abs((n % W) - x) <= 1) { seen[n] = 1; stack.push(n); }
          }
          comps.push({ x0, y0, x1, y1 });
        }
        const pad = 40; // < half the square spacing (~87 pt) at the zoom used
        const centroid = (img, { x0, y0, x1, y1 }) => {
          let sw = 0, sx = 0, sy = 0;
          for (let y = Math.max(0, y0 - pad); y <= Math.min(H - 1, y1 + pad); y++) for (let x = Math.max(0, x0 - pad); x <= Math.min(W - 1, x1 + pad); x++) {
            const v = img[y * W + x]; if (v > 8) { sw += v; sx += v * x; sy += v * y; }
          }
          return sw ? [sx / sw, sy / sw] : null;
        };
        let max = 0;
        for (const c of comps) {
          const p = centroid(a, c), q = centroid(b, c);
          max = Math.max(max, q ? Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])) : Infinity);
        }
        return { squares: comps.length, maxShift: max };
      },
      /** pdf.js's drawing of page i at the view's current scale and rotation, the viewer's canvas size. */
      async pdfjsCanvas(tab, i) {
        const vp = app.viewer.getViewport(tab, i, app.viewer.scale(tab));
        let out = window.devicePixelRatio || 1;
        if (vp.width * vp.height * out * out > 16_777_216) out = Math.sqrt(16_777_216 / (vp.width * vp.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(vp.width * out));
        canvas.height = Math.max(1, Math.floor(vp.height * out));
        await tab.pages[i].render({ canvas, viewport: vp, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined }).promise;
        return canvas;
      },
    };
  });
  return page;
}
try {
  step = 'pdf.js alone: page 2 with fast draw off (a fresh page, so memory and workers are not shared)';
  const slowPage = await appPage();
  const slow = await slowPage.evaluate(async () => {
    const fd = window.ashStudio.viewer.fastDraw;
    if (fd) fd.enabled = false; // (a build without fast draw fails the checks below, not here)
    return window.__fd.open('slow.pdf');
  });
  await slowPage.close();
  check(slow.renderer === 'pdfjs', `fast draw off, yet page 2 drawn by ${slow.renderer}`);
  check(wasmRequests.length === 0, `fast draw off, yet pdfium.wasm was requested`);

  const page = await appPage();

  step = 'a document with light pages only never starts PDFium (G5)';
  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/__light.pdf')).arrayBuffer());
    const t0 = performance.now();
    await window.ashStudio.openBytes({ name: 'light.pdf', bytes });
    await window.__fd.rendered(0, t0);
    await new Promise((r) => setTimeout(r, window.ashStudio.viewer.fastDraw.thresholdMs + 500));
  });
  check(!(await page.evaluate(() => window.ashStudio.pdfium.started)) && wasmRequests.length === 0, `PDFium started for a light document: ${wasmRequests.join(', ')}`);
  check(await page.evaluate(() => window.__fd.pageEl(0).dataset.renderer) === 'pdfjs', 'light page not marked data-renderer="pdfjs"');
  await page.evaluate(() => { // record pdf.js page renders (6d.)
    const proto = Object.getPrototypeOf(window.__fd.tab('light.pdf').pages[0]), render = proto.render, tasks = [];
    proto.render = function (...args) {
      const task = render.apply(this, args), t = { page: this.pageNumber, state: 'running' };
      task.promise.then(() => { t.state = 'done'; }, (e) => { t.state = e?.name ?? String(e); });
      if (args[0].canvas?.classList.contains('page-canvas')) tasks.push(t); // the main view's, not thumbnails
      return task;
    };
    window.__fd.renders = { tasks, restore: () => { proto.render = render; } };
    return window.ashStudio.closeTab(window.__fd.tab('light.pdf'));
  });

  step = 'heavy page 2 is drawn by PDFium';
  const fast = await page.evaluate(() => window.__fd.open('fast.pdf'));
  check(fast.renderer === 'pdfium', `page 2 drawn by ${fast.renderer}, expected pdfium (${fast.ms} ms)`);
  step = 'PDFium won: pdf.js was cancelled and page 2 holds one canvas';
  const won = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 300));
    const { tasks, restore } = window.__fd.renders;
    restore();
    return { tasks: tasks.filter((t) => t.page === 2).map((t) => t.state), canvases: window.__fd.pageEl(1).querySelectorAll('canvas.page-canvas').length };
  });
  check(won.tasks.length === 1 && won.tasks[0] === 'RenderingCancelledException', `pdf.js renders of page 2 after PDFium won: ${JSON.stringify(won.tasks)} (expected one, cancelled)`);
  check(won.canvases === 1, `page 2 holds ${won.canvases} canvases after PDFium won (expected 1)`);
  check(wasmRequests.length === 1, `expected one pdfium.wasm request, saw ${wasmRequests.length}`);

  step = 'light page 1 and heavy page 3 with a form field are drawn by pdf.js';
  const others = await page.evaluate(async () => {
    const tab = window.__fd.tab('fast.pdf');
    await window.__fd.rendered(0, performance.now());
    const r1 = window.__fd.pageEl(0).dataset.renderer;
    window.ashStudio.viewer.scrollToPage(tab, 2);
    await window.__fd.rendered(2, performance.now());
    return [r1, window.__fd.pageEl(2).dataset.renderer];
  });
  check(others[0] === 'pdfjs' && others[1] === 'pdfjs', `pages 1 and 3 drawn by ${others.join(', ')}, expected pdfjs`);

  step = 'zoom-in re-renders page 2 with PDFium straight away';
  await page.evaluate(() => window.ashStudio.viewer.scrollToPage(window.__fd.tab('fast.pdf'), 1));
  await page.evaluate(() => window.__fd.rendered(1, performance.now()));
  const zoom = await page.evaluate(() => {
    const tab = window.__fd.tab('fast.pdf'), pg = tab.pages[1], render = pg.render;
    window.__fd.zoom = { calls: 0, scale: window.ashStudio.viewer.getPageState(tab, 1).scale, t0: performance.now() };
    pg.render = function (...args) { window.__fd.zoom.calls++; return render.apply(this, args); };
    window.__fd.zoom.restore = () => { pg.render = render; };
  });
  await page.keyboard.press('Control+Equal');
  const zr = await page.evaluate(async () => {
    const z = window.__fd.zoom, tab = window.__fd.tab('fast.pdf');
    const ms = await window.__fd.rendered(1, z.t0, () => window.ashStudio.viewer.getPageState(tab, 1).scale !== z.scale, 60_000);
    z.restore();
    return { ms: Math.round(ms), calls: z.calls, renderer: window.__fd.pageEl(1).dataset.renderer };
  });
  // no pdf.js render call at all: the race path always starts pdf.js first, so PDFium did not wait for the threshold
  check(zr.renderer === 'pdfium' && zr.calls === 0, `zoom re-render: ${JSON.stringify(zr)} (expected pdfium and no pdf.js render)`);

  step = 'PDFium lines up with pdf.js (unrotated and rotated 90 degrees)';
  const align = await page.evaluate(async () => {
    const app = window.ashStudio, tab = window.__fd.tab('fast.pdf');
    const results = [];
    const measure = async (label) => {
      const el = window.__fd.pageEl(1), shown = el.querySelector('canvas.page-canvas');
      if (el.dataset.renderer !== 'pdfium') return results.push({ label, renderer: el.dataset.renderer });
      const ref = await window.__fd.pdfjsCanvas(tab, 1);
      const size = [shown.width, shown.height, ref.width, ref.height];
      const r = window.__fd.compare(ref, shown);
      results.push({ label, size, ...r });
      return { ref, shown };
    };
    let t0 = performance.now();
    app.viewer.setZoom(tab, 2.5);
    app.viewer.scrollToPage(tab, 1);
    await window.__fd.rendered(1, t0, () => Math.abs(app.viewer.getPageState(tab, 1).scale - app.viewer.scale(tab)) < 1e-9 && app.viewer.getPageState(tab, 1).scale > 2);
    const m = await measure('0deg');
    if (m?.ref) { // the metric rejects a 0.5% scale error and a 0.5% (of the width) offset error
      const W = m.ref.width;
      results.push({ label: 'scale+0.5%', ...window.__fd.compare(m.ref, m.shown, { warp: (x, y) => [x / 1.005, y / 1.005] }) });
      results.push({ label: 'offset+0.5%', ...window.__fd.compare(m.ref, m.shown, { warp: (x, y) => [x - 0.005 * W, y] }) });
    }
    t0 = performance.now();
    app.viewer.rotateView(tab, 90);
    app.viewer.scrollToPage(tab, 1);
    await window.__fd.rendered(1, t0, () => app.viewer.getPageState(tab, 1).rotation === 90);
    await measure('90deg');
    return results;
  });
  const [a0, sc, off, a90] = align;
  check(a0.renderer === undefined && a90?.renderer === undefined, `page 2 not drawn by PDFium for the pixel check: ${JSON.stringify(align)}`);
  for (const a of [a0, a90]) {
    check(a.size[0] === a.size[2] && a.size[1] === a.size[3], `${a.label}: canvas sizes differ ${a.size}`);
    check(a.squares === COLS * ROWS, `${a.label}: found ${a.squares} squares in the pdf.js drawing, expected ${COLS * ROWS}`);
    check(a.maxShift <= MAX_SHIFT, `${a.label}: PDFium and pdf.js disagree by ${a.maxShift.toFixed(2)} px (max ${MAX_SHIFT})`);
  }
  check(sc.maxShift > MAX_SHIFT && off.maxShift > MAX_SHIFT, `metric does not reject a 0.5% error: scale ${sc.maxShift}, offset ${off.maxShift}`);

  await page.close(); // a fresh page for 5. and 6.: the renderer process would otherwise run out of memory
  const ep = await appPage();
  step = 'eligibility: non-embedded non-standard fonts and links with an appearance keep pdf.js';
  const second = await ep.evaluate(() => window.__fd.open('fast.pdf')); // the other document PDFium draws
  check(second.renderer === 'pdfium', `fast.pdf page 2 drawn by ${second.renderer} in the second page`);

  step = 'a reload (bytes changed) closes the old PDFium document';
  const reloaded = await ep.evaluate(async () => {
    const app = window.ashStudio, tab = window.__fd.tab('fast.pdf'), oldDoc = tab.pdfDoc, before = (await app.pdfium.stats()).docs;
    app.bus.emit('tab:bytesChanged', { tab });
    const t0 = performance.now();
    while (tab.pdfDoc === oldDoc && performance.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 20));
    app.viewer.scrollToPage(tab, 1);
    await window.__fd.rendered(1, t0, (el) => el.dataset.renderer === 'pdfium', 120_000, tab);
    return { before, after: (await app.pdfium.stats()).docs, reloaded: tab.pdfDoc !== oldDoc };
  });
  check(reloaded.reloaded && reloaded.before === 1 && reloaded.after === 1, `reload: PDFium documents ${reloaded.before} before, ${reloaded.after} after (expected 1 and 1)`);
  const elig = await ep.evaluate(async (n) => {
    const app = window.ashStudio, fdc = app.viewer.fastDraw;
    fdc.thresholdMs = 300; // each 150k-segment page takes pdf.js longer: PDFium joins on every eligible one
    try {
      const bytes = new Uint8Array(await (await fetch('/__eligible.pdf')).arrayBuffer());
      await app.openBytes({ name: 'eligible.pdf', bytes });
      const tab = window.__fd.tab('eligible.pdf'), out = [];
      for (let i = 0; i < n; i++) {
        app.viewer.scrollToPage(tab, i);
        await window.__fd.rendered(i, performance.now(), undefined, 120_000, tab);
        out.push(window.__fd.pageEl(i, tab).dataset.renderer);
      }
      return { renderers: out, stats: await app.pdfium.stats() };
    } finally { fdc.thresholdMs = 1500; }
  }, ELIGIBLE.length);
  ELIGIBLE.forEach(([what, want], i) => check(elig.renderers[i] === want, `page ${i + 1} (${what}) drawn by ${elig.renderers[i]}, expected ${want}`));
  check(elig.stats.docs === 2 && elig.stats.keptPages <= 1, `two documents drawn: worker keeps ${JSON.stringify(elig.stats)} (expected 2 docs, <= 1 parsed page)`);

  step = 'a page with a layer hidden goes back to pdf.js';
  const layer = await ep.evaluate(async () => {
    const app = window.ashStudio, fdc = app.viewer.fastDraw;
    fdc.thresholdMs = 300;
    try {
      const bytes = new Uint8Array(await (await fetch('/__layers.pdf')).arrayBuffer());
      await app.openBytes({ name: 'layers.pdf', bytes });
      const tab = window.__fd.tab('layers.pdf');
      await window.__fd.rendered(0, performance.now(), undefined, 120_000, tab);
      const shown = window.__fd.pageEl(0, tab).dataset.renderer;
      const [[id]] = [...tab.ocConfig];
      tab.ocConfig.setVisibility(id, false);
      app.viewer.rerender(tab);
      await window.__fd.rendered(0, performance.now(), undefined, 120_000, tab);
      const hidden = window.__fd.pageEl(0, tab).dataset.renderer;
      await app.closeTab(tab);
      return { shown, hidden };
    } finally { fdc.thresholdMs = 1500; }
  });
  check(layer.shown === 'pdfium' && layer.hidden === 'pdfjs', `layers.pdf drawn by ${layer.shown}, then by ${layer.hidden} with the layer hidden (expected pdfium, then pdfjs)`);

  step = 'a tab closed while its heavy page waits for the eligibility answer leaves no PDFium document open';
  const race = await ep.evaluate(async () => {
    const app = window.ashStudio, fdc = app.viewer.fastDraw, proto = Object.getPrototypeOf(window.__fd.tab('fast.pdf').pages[0]);
    const getAnnotations = proto.getAnnotations, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = (await app.pdfium.stats()).docs;
    let asked = 0;
    // The answer is 'no annotations' even after the close (the real call would reject on the destroyed document and
    // end the race on its own, so the closed-document guards would go untested).
    proto.getAnnotations = function () { asked++; return wait(2500).then(() => []); };
    fdc.thresholdMs = 300;
    try {
      const bytes = new Uint8Array(await (await fetch('/__fast.pdf')).arrayBuffer());
      await app.openBytes({ name: 'race.pdf', bytes });
      const tab = window.__fd.tab('race.pdf');
      app.viewer.scrollToPage(tab, 1);
      await wait(1200); // page 2: pdf.js past the threshold, the eligibility answer still pending
      const raced = asked > 0 && !window.__fd.pageEl(1, tab).classList.contains('rendered');
      await app.closeTab(tab);
      await wait(3500); // the answer arrives after the close
      return { raced, before, after: (await app.pdfium.stats()).docs };
    } finally { proto.getAnnotations = getAnnotations; fdc.thresholdMs = 1500; }
  });
  check(race.raced, 'race.pdf page 2 was not waiting for its eligibility answer when the tab closed (test did not exercise the race)');
  check(race.after === race.before, `closing race.pdf mid-race left PDFium documents open: ${race.before} before, ${race.after} after`);
  step = 'a tab closed while a known-heavy page waits for the eligibility answer opens no PDFium document';
  const known = await ep.evaluate(async () => {
    const app = window.ashStudio, proto = Object.getPrototypeOf(window.__fd.tab('fast.pdf').pages[0]);
    const getAnnotations = proto.getAnnotations, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = (await app.pdfium.stats()).docs;
    let asked = 0;
    proto.getAnnotations = function () { asked++; return wait(2500).then(() => []); }; // answers after the close (see above)
    try {
      const bytes = new Uint8Array(await (await fetch('/__fast.pdf')).arrayBuffer());
      await app.openBytes({ name: 'known.pdf', bytes });
      const tab = window.__fd.tab('known.pdf');
      app.viewer.fastHeavy(tab).add(1);
      app.viewer.rerender(tab); // page 2 goes straight to PDFium once its eligibility answer arrives
      app.viewer.scrollToPage(tab, 1);
      await wait(600);
      await wait(400);
      const waiting = !window.__fd.pageEl(1, tab).classList.contains('rendered');
      await app.closeTab(tab);
      await wait(3500);
      return { waiting, before, after: (await app.pdfium.stats()).docs };
    } finally { proto.getAnnotations = getAnnotations; }
  });
  check(known.waiting, 'known.pdf page 2 was drawn before the tab closed (test did not exercise the known-heavy wait)');
  check(known.after === known.before, `closing known.pdf during the known-heavy wait left PDFium documents open: ${known.before} before, ${known.after} after`);
  const closed = await ep.evaluate(async () => {
    const app = window.ashStudio;
    for (const name of ['eligible.pdf', 'fast.pdf']) await app.closeTab(window.__fd.tab(name));
    await new Promise((r) => setTimeout(r, 500));
    return app.pdfium.stats();
  });
  check(closed.docs === 0 && closed.keptPages === 0, `all tabs closed, PDFium still holds ${JSON.stringify(closed)}`);

  await ep.close();

  step = 'fast scroll over known-heavy pages: the page stopped on does not wait behind the pages scrolled past';
  const sp = await appPage();
  const scroll = await sp.evaluate(async (K) => {
    const app = window.ashStudio, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const drawn = async (tab, i, t0) => { // PDFium's canvas shown (before the text layer)
      while (window.__fd.pageEl(i, tab).dataset.renderer !== 'pdfium') { if (performance.now() - t0 > 120_000) throw new Error(`page ${i + 1} not drawn`); await wait(10); }
      return performance.now() - t0;
    };
    const posts = [], postMessage = Worker.prototype.postMessage; // renders posted to the PDFium worker, in order
    Worker.prototype.postMessage = function (msg, ...rest) { if (msg?.method === 'renderPage') posts.push(msg.args.slice(0, 2)); return postMessage.call(this, msg, ...rest); };
    await app.pdfium.selfTest(); // worker started and warm
    const other = await app.pdfium.open(new Uint8Array(await (await fetch('/__light.pdf')).arrayBuffer()));
    await app.openBytes({ name: 'many.pdf', bytes: new Uint8Array(await (await fetch('/__many.pdf')).arrayBuffer()) });
    const tab = window.__fd.tab('many.pdf'), heavy = app.viewer.fastHeavy(tab);
    for (let i = 0; i < K; i++) heavy.add(i);
    let t0 = performance.now();
    app.viewer.rerender(tab); // pages 1 and 2 (visible) go straight to PDFium, one after the other
    const ms1 = await drawn(tab, 0, t0), ms2 = await drawn(tab, 1, t0);
    const one = ms2 - ms1; // one PDFium render of the heavy page
    const s0 = (await app.pdfium.stats()).renders;
    for (let i = 2; i < K; i++) { app.viewer.scrollToPage(tab, i); await wait(100); }
    t0 = performance.now();
    const edit = app.pdfium.pageCount(other).then(() => performance.now() - t0);
    const stop = await drawn(tab, K - 1, t0);
    const s1 = (await app.pdfium.stats()).renders;
    await app.pdfium.close(other);
    // 6f: a render in flight (a blocker on another document, posted ahead of everything), meanwhile the view is
    // re-rendered at the last page and scrolled back up to page S at the same pace; pages S and S+1 visible at the stop
    const S = 5, blocker = await app.pdfium.open(new Uint8Array(await (await fetch('/__many.pdf')).arrayBuffer()));
    const blockerPosted = posts.length;
    const blocked = app.pdfium.renderPage(blocker, 0, { width: 1600, height: 1131, matrix: [1.344, 0, 0, -1.344, 0, 1131] }, { priority: () => [Infinity, 0] });
    while (!posts.slice(blockerPosted).some(([, p]) => p === 0)) await wait(10);
    const from = posts.length;
    app.viewer.rerender(tab);
    for (let i = K - 2; i >= S; i--) { app.viewer.scrollToPage(tab, i); await wait(100); }
    t0 = performance.now();
    const mid = await drawn(tab, S, t0), blockerDone = !!(await blocked);
    await drawn(tab, S - 1, t0); // the last neighbour
    await app.pdfium.close(blocker);
    const midOrder = posts.slice(from).map(([, p]) => p), rank = [S, S + 1, S + 2, S - 1];
    const ranks = midOrder.filter((p) => rank.includes(p)).map((p) => rank.indexOf(p));
    return { one: Math.round(one), stop: Math.round(stop), edit: Math.round(await edit), posted: s1.posted - s0.posted, dropped: s1.dropped - s0.dropped,
      queued: s1.queued, mid: Math.round(mid), midOrder, blockerDone, midInOrder: midOrder.length >= 4 && ranks.every((r, k) => k === 0 || ranks[k - 1] < r) };
  }, MANY);
  await sp.close();
  check(scroll.stop < 3 * scroll.one, `fast scroll: stopped-on page drawn after ${scroll.stop} ms, one PDFium render takes ${scroll.one} ms (need < 3x) ${JSON.stringify(scroll)}`);
  check(scroll.edit < 1.5 * scroll.one, `fast scroll: pdfium.pageCount took ${scroll.edit} ms behind the renders, one render takes ${scroll.one} ms (need < 1.5x) ${JSON.stringify(scroll)}`);
  check(scroll.posted < MANY - 2 && scroll.dropped > 0, `fast scroll: ${scroll.posted} renders posted to the worker, ${scroll.dropped} dropped for ${MANY - 2} pages scrolled through ${JSON.stringify(scroll)}`);
  check(scroll.queued <= 2, `fast scroll: ${scroll.queued} renders still queued once the stopped-on page is drawn (at most its 2 other wanted pages) ${JSON.stringify(scroll)}`);
  check(scroll.midInOrder, `fast scroll stopping mid-document: renders posted after the stop in the order ${scroll.midOrder} (expected page indices 5, 6, 7, then 4) ${JSON.stringify(scroll)}`);
  check(scroll.mid < 3 * scroll.one, `fast scroll stopping mid-document: page 6 drawn after ${scroll.mid} ms, one PDFium render takes ${scroll.one} ms (need < 3x) ${JSON.stringify(scroll)}`);

  step = 'page 2 completes in under half the time pdf.js alone needs';
  check(fast.ms < 0.5 * slow.ms, `page 2 took ${fast.ms} ms with fast draw vs ${slow.ms} ms with pdf.js alone (need < 50%)`);

  check(problems.length === 0, `console/page errors: ${problems.join(' | ')}`);
  const fmt = (a) => a.maxShift.toFixed(2);
  console.log(`FASTDRAW OK (page 2: ${fast.ms} ms PDFium vs ${slow.ms} ms pdf.js; zoom ${zr.ms} ms; fast scroll: stop ${scroll.stop} ms, edit ${scroll.edit} ms, one render ${scroll.one} ms, mid-document stop ${scroll.mid} ms, ${scroll.posted} posted / ${scroll.dropped} dropped; max centroid shift ${fmt(a0)} px / ${fmt(a90)} px rotated, 0.5% errors give ${fmt(sc)} / ${fmt(off)} px)`);
} catch (err) {
  console.error(`fastdraw e2e FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

