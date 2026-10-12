#!/usr/bin/env node
// End-to-end test: highlights made by another PDF editor must not hide the text they mark (renderer
// .overlay-blend layer, renderer/ui/annotations.js). Fixture (pdf-lib): black text on two lines; line 1
// carries an Adobe-style /Highlight (/CA 1, /AP /N filling opaque yellow under an ExtGState /BM
// /Multiply), line 2 a /Highlight with /CA 1 and no /AP. Both open as textHighlight objects drawn by
// the app; in a screenshot of the page each highlighted region must keep dark text pixels (min
// luminance < 80) on a yellow background, before and after selecting the highlight, and in
// Export to image (pageImageBytes, annotations included) of the page.
// Prints "HLBLEND OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const H = 792;
// Highlighted boxes in visible space (points, y down), each over one line of 28pt text.
const LINES = [{ x: 70, y: 100, w: 300, h: 36, text: 'CONTRACT TERMS AAA' }, { x: 70, y: 200, w: 300, h: 36, text: 'PAYMENT CLAUSE BBB' }];

async function makePdf() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, H]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const L of LINES) p.drawText(L.text, { x: L.x + 4, y: H - L.y - L.h + 9, size: 28, font });
  const ctx = doc.context;
  const quad = (L) => [L.x, H - L.y, L.x + L.w, H - L.y, L.x, H - L.y - L.h, L.x + L.w, H - L.y - L.h];
  const rect = (L) => [L.x, H - L.y - L.h, L.x + L.w, H - L.y];
  const [a, b] = LINES;
  // Adobe style: opaque yellow appearance, multiplied by its ExtGState.
  const ap = ctx.stream(`/GS0 gs 1 1 0 rg 0 0 ${a.w} ${a.h} re f`, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, a.w, a.h],
    Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } } },
  });
  const hlA = ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: rect(a), QuadPoints: quad(a), C: [1, 1, 0], CA: 1, F: 4, AP: { N: ctx.register(ap) } });
  const hlB = ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: rect(b), QuadPoints: quad(b), C: [1, 1, 0], CA: 1, F: 4 });
  p.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(hlA), ctx.register(hlB)]));
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  // Pixel stats of image `png` (bytes) inside box b (image pixels): min luminance and the share of
  // yellow-ish pixels (red and green high, blue low).
  const stats = (png, b) => page.evaluate(async ({ png, b }) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    const D = x.getImageData(Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)).data;
    let min = 255, yellow = 0;
    for (let i = 0; i < D.length; i += 4) {
      const [r, g, bl] = [D[i], D[i + 1], D[i + 2]];
      min = Math.min(min, 0.2126 * r + 0.7152 * g + 0.0722 * bl);
      if (r > 200 && g > 190 && bl < 130) yellow++;
    }
    return { min: Math.round(min), yellow: yellow / (D.length / 4) };
  }, { png: [...png], b });
  const expectVisible = (s, what) => {
    check(s.min < 80, `${what}: text hidden under the highlight (min luminance ${s.min}, expected < 80)`);
    check(s.yellow > 0.3, `${what}: background not yellow (${Math.round(s.yellow * 100)}% yellow pixels)`);
  };
  // Screenshot of the page as composited on screen; boxes in points -> screenshot pixels.
  const screen = async (what) => {
    await frames();
    const r = await ev('const b = v.getPageEl(tab, 0).getBoundingClientRect(); return { x: b.x, y: b.y, k: b.width / 612 };');
    const png = await page.screenshot({ clip: { x: r.x, y: r.y, width: 612 * r.k, height: H * r.k } });
    for (const [n, L] of LINES.entries()) {
      const box = { x: (L.x + 4) * r.k, y: (L.y + 4) * r.k, w: (L.w - 8) * r.k, h: (L.h - 8) * r.k };
      expectVisible(await stats(png, box), `${what}, highlight ${n + 1}`);
    }
  };

  step = 'open';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: await makePdf() });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 1 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t.view?.ps[0]?.rendered && t.objects.length === 2; }, null, { timeout: 10_000 });
  const objs = await ev('return tab.objects.map((o) => ({ type: o.type, opacity: o.opacity }));');
  check(objs.every((o) => o.type === 'textHighlight' && o.opacity === 1), `imported: ${JSON.stringify(objs)}`);

  step = 'screen';
  await screen('on screen');

  step = 'selected';
  await ev('an.select(tab, tab.objects[0].id);');
  check(await ev('return v.getOverlaySvg(tab, 0).querySelectorAll(".ann-selection .ann-bbox").length === 1;'), 'selecting the highlight drew no selection outline');
  await screen('selected');
  await ev('an.select(tab, []);');

  step = 'export to image';
  const png = await ev(`const { pageImageBytes } = await import('${base}/renderer/ui/exports.js');
    return [...await pageImageBytes(tab, 0, { format: 'png', dpi: 72, annotations: true })];`);
  for (const [n, L] of LINES.entries()) expectVisible(await stats(png, { x: L.x + 4, y: L.y + 4, w: L.w - 8, h: L.h - 8 }), `export to image, highlight ${n + 1}`);

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('HLBLEND OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
