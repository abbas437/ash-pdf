#!/usr/bin/env node
// End-to-end test of another app's custom stamp (core type apStamp, renderer/ui/tools-stamp.js) in
// Chromium via playwright-core (run `node scripts/vendor.js` first). The fixture (test/apstamp-fixture.js)
// has a /Stamp whose appearance is a blue seal image plus ink strokes. Opened, it is an editable apStamp
// drawn by the overlay as its own appearance (blue pixels in its box, no name label, not drawn twice on
// the page canvas); dragged with the Select tool it moves; Export to image shows it at the new place;
// saved and rendered again with pdf.js the appearance is at the new place (one /Stamp, /Name kept); Undo
// puts it back. Prints "APSTAMP OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName } from 'pdf-lib';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { apStampPdf, STAMP_NAME, STAMP_RECT } from '../apstamp-fixture.js';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const H = 792;
const BOX = { x: STAMP_RECT[0], y: H - STAMP_RECT[3], w: STAMP_RECT[2] - STAMP_RECT[0], h: STAMP_RECT[3] - STAMP_RECT[1] }; // visible space

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [], warnings = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;
const isBlue = (r, g, b, a) => a > 128 && b > 120 && r < 90 && g < 120;
/** Blue (seal / ink) pixels of RGBA data. */
const blueCount = (D) => { let n = 0; for (let i = 0; i < D.length; i += 4) if (isBlue(D[i], D[i + 1], D[i + 2], D[i + 3])) n++; return n; };
/** Blue pixels of a PNG inside a box in points (k px per point). */
async function pngBlue(png, b, k) {
  const img = await loadImage(png), c = createCanvas(img.width, img.height), x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  return blueCount(x.getImageData(Math.round(b.x * k), Math.round(b.y * k), Math.round(b.w * k), Math.round(b.h * k)).data);
}
const inner = (b) => ({ x: b.x + 10, y: b.y + 10, w: b.w - 20, h: b.h - 20 });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = Buffer.from(await apStampPdf());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });

  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const objs = () => ev('return tab.objects.map((o) => ({ ...o, ap: o.ap ? o.ap.length : undefined }));');
  const toClient = (x, y) => ev('const c = v.pageToClient(tab, 0, arg[0], arg[1]); return [c.clientX, c.clientY];', [x, y]);
  // Blue pixels on screen (page canvas + overlay) inside a box in page points.
  const screenBlue = async (b) => {
    const [x0, y0] = await toClient(b.x, b.y), [x1, y1] = await toClient(b.x + b.w, b.y + b.h);
    const png = await page.screenshot({ clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
    return pngBlue(png, { x: 0, y: 0, w: b.w, h: b.h }, (x1 - x0) / b.w);
  };
  // Blue pixels of the viewer's page canvas alone (the view copy, without the overlay).
  const canvasBlue = (b) => ev(`
    const c = document.querySelector('.page[data-page-index="0"] canvas.page-canvas'), k = c.width / 612;
    const D = c.getContext('2d').getImageData(Math.round(arg.x * k), Math.round(arg.y * k), Math.round(arg.w * k), Math.round(arg.h * k)).data;
    let n = 0; for (let i = 0; i < D.length; i += 4) if (D[i + 3] > 128 && D[i + 2] > 120 && D[i] < 90 && D[i + 1] < 120) n++;
    return n;`, b);
  const overlayImage = () => page.waitForFunction(() => {
    const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId), o = t?.objects.find((x) => x.type === 'apStamp');
    return !!(o && a.viewer.getOverlaySvg(t, 0)?.querySelector(`[data-obj-id="${o.id}"] image`));
  }, null, { timeout: 10_000 });

  step = 'open';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 1 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await page.waitForFunction(() => { const c = document.querySelector('.page[data-page-index="0"] canvas.page-canvas'); return c && c.width > 0; }, null, { timeout: 10_000 });
  await frames();

  step = 'appearance';
  let list = await objs();
  check(list.length === 1 && list[0].type === 'apStamp' && list[0].name === STAMP_NAME, `stamp not imported as an apStamp: ${JSON.stringify(list)}`);
  const st = list[0];
  check(near(st.x, BOX.x, 0.5) && near(st.y, BOX.y, 0.5) && near(st.w, BOX.w, 0.5) && near(st.h, BOX.h, 0.5), `imported box ${JSON.stringify(st)}`);
  await overlayImage();
  await frames();
  const seal = await screenBlue(inner(BOX));
  check(seal > 5000, `the stamp's box shows ${seal} blue pixels: its appearance is not drawn`);
  check(await ev('return ![...v.getOverlaySvg(tab, 0).querySelectorAll("text")].some((t) => t.textContent.includes(arg));', STAMP_NAME), 'the overlay draws the stamp name as a label');
  check(await canvasBlue(BOX) === 0, 'the stamp is drawn on the page canvas as well as by the overlay');
  check(await ev('return !tab.dirty;'), 'opening marked the tab dirty');

  step = 'drag';
  // Selected first: selecting re-renders the options bar, which shifts the page during the drag otherwise.
  await ev('app.setTool?.("select"); an.select(tab, [arg]);', st.id);
  await frames();
  const D = { x: 200, y: 150 }; // the drop point stays inside the 1000 px viewport
  const a = await toClient(BOX.x + BOX.w / 2, BOX.y + BOX.h / 2), b = await toClient(BOX.x + BOX.w / 2 + D.x, BOX.y + BOX.h / 2 + D.y);
  await page.mouse.move(...a); await page.mouse.down();
  await page.mouse.move(b[0], b[1], { steps: 8 }); await page.mouse.up(); await frames();
  const moved = (await objs())[0];
  const NEW = { x: BOX.x + D.x, y: BOX.y + D.y, w: BOX.w, h: BOX.h };
  check(near(moved.x, NEW.x) && near(moved.y, NEW.y) && near(moved.w, BOX.w, 0.01), `dragged stamp at ${JSON.stringify(moved)}`);
  await overlayImage();
  await frames();
  check(await screenBlue(inner(NEW)) > 5000, 'the dragged stamp is not drawn at its new place');
  check(await screenBlue(inner(BOX)) === 0, 'the dragged stamp is still drawn at its old place');

  step = 'export to image';
  const img = Buffer.from(await ev('const { pageImageBytes } = await import("/renderer/ui/exports.js"); return Array.from(await pageImageBytes(tab, 0, { format: "png", dpi: 72 }));'));
  check(await pngBlue(img, inner(NEW), 1) > 5000, 'Export to image does not show the stamp at its new place');

  step = 'save + render';
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  const saved = Buffer.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  const doc = await PDFDocument.load(saved);
  const stamps = (doc.getPage(0).node.Annots()?.asArray() ?? []).map((r) => doc.context.lookup(r)).filter((d) => String(d.get(PDFName.of('Subtype'))) === '/Stamp');
  check(stamps.length === 1, `${stamps.length} /Stamp annotations after save`);
  check(String(stamps[0].get(PDFName.of('Name'))) === PDFName.of(STAMP_NAME).toString(), `/Name ${stamps[0].get(PDFName.of('Name'))}`);
  const rendered = Buffer.from(await ev(`
    const task = v.pdfjs.getDocument({ data: new Uint8Array(arg) }), d = await task.promise;
    const p = await d.getPage(1), vp = p.getViewport({ scale: 1 }), c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await p.render({ canvas: c, viewport: vp, background: '#ffffff', annotationMode: v.pdfjs.AnnotationMode.ENABLE }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    task.destroy();
    return Array.from(new Uint8Array(await blob.arrayBuffer()));`, [...saved]));
  check(await pngBlue(rendered, inner(NEW), 1) > 5000, 'the saved file does not show the stamp at its new place');
  check(await pngBlue(rendered, inner(BOX), 1) === 0, 'the saved file still shows the stamp at its old place');

  step = 'undo';
  await ev('an.undo(tab);');
  await frames();
  const back = (await objs())[0];
  check(near(back.x, BOX.x, 0.01) && near(back.y, BOX.y, 0.01), `undo left the stamp at ${JSON.stringify(back)}`);
  await overlayImage();
  await frames();
  check(await screenBlue(inner(BOX)) > 5000, 'after undo the stamp is not drawn at its old place');

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('APSTAMP OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length || warnings.length) console.error([...problems, ...warnings].join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
