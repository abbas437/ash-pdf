#!/usr/bin/env node
// End-to-end test of a save landing during the swap to the view copy (viewer.js swapToView, annotations.js
// makeView/commit). The annotation read is held so the raw file is shown first; the swap's reload is then
// held inside its pdf.js load (getMetadata) while the user adds a rect and saves (the save puts its output in
// tab.bytes without a reload). When the reload installs the view copy of the older bytes (markups stripped),
// the file's square must still be drawn by someone, once: an overlay object (editable) or a pdf.js
// annotation, not neither and not both. Prints "SAVESWAP OK". Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const H = 792;

/** One page with a foreign /Square (no /NM, its own appearance). */
async function makePdf() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, H]);
  const ctx = doc.context;
  const ap = ctx.stream('1 0 0 RG 4 w 2 2 96 56 re S', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 60] });
  const square = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, H - 160, 200, H - 100], C: [1, 0, 0], BS: { W: 4 }, F: 4, T: PDFString.of('Other App'), AP: { N: ctx.register(ap) } });
  p.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(square)]));
  return Buffer.from(await doc.save());
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
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
  const pdf = await makePdf();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });

  step = 'open with the annotation read held: the raw file is shown';
  await page.evaluate(async () => {
    const { coreWorker } = await import('/renderer/coreworker/client.js');
    window.__gate = {};
    const read = coreWorker.readAnnotations;
    let armed = true;
    coreWorker.readAnnotations = async (b) => { if (armed) { armed = false; await new Promise((r) => { window.__gate.read = r; }); } return read(b); };
  });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'swap.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const t = window.ashStudio.state.tabs[0]; return t?.pdfDoc && t.view && window.__gate.read; }, null, { timeout: 10_000 });
  check(await ev('return tab.objects.length === 0 && !!tab.path;'), 'raw file not shown first (objects already mirrored) or the tab has no path');

  step = 'hold the swap reload inside its pdf.js load';
  await ev(`const raw = tab.pdfDoc, proto = Object.getPrototypeOf(raw), meta = proto.getMetadata;
    window.__raw = raw;
    let armed = true;
    proto.getMetadata = async function (...a) {
      if (armed && this !== raw) { armed = false; await new Promise((r) => { window.__gate.meta = r; }); }
      return meta.apply(this, a);
    };
    window.__gate.read();`);
  await page.waitForFunction(() => !!window.__gate.meta, null, { timeout: 10_000 });

  step = 'add a rect and save while the reload is held';
  await ev('an.add(tab, { type: "rect", page: 0, x: 300, y: 400, w: 80, h: 40, stroke: "#0000ff", strokeWidth: 2 });');
  check(await ev('return await app.saveTab(tab);'), 'saveTab returned false');
  check(await ev('return tab.pdfDoc === window.__raw;'), 'the swap reload was not held across the save');

  step = 'release the reload: the square is drawn once';
  await ev('window.__gate.meta();');
  // Drawn by the overlay (an imported rect at the square) or by pdf.js (a Square in the shown document).
  const drawn = () => ev(`
    const sq = tab.objects.filter((o) => o.type === 'rect' && Math.abs(o.x - 102) < 1 && Math.abs(o.y - 102) < 1).length;
    const mine = tab.objects.filter((o) => o.type === 'rect' && Math.abs(o.x - 300) < 1).length;
    const shown = (await (await tab.pdfDoc.getPage(1)).getAnnotations()).filter((a) => a.subtype === 'Square').length;
    return { sq, mine, shown, raw: tab.pdfDoc === window.__raw, dirty: tab.dirty };`);
  let d;
  const t0 = Date.now();
  do {
    await ev('await new Promise((r) => setTimeout(r, 100));');
    d = await drawn();
  } while (!(d.sq === 1 && !d.raw) && Date.now() - t0 < 5000); // settled, or stuck (checked below)
  await ev('await new Promise((r) => setTimeout(r, 300));');
  d = await drawn();
  check(!d.raw, `the swap reload never installed: ${JSON.stringify(d)}`);
  check(d.sq + d.shown >= 1, `the file's square is drawn by nobody (no overlay object, not in the shown document): ${JSON.stringify(d)}`);
  check(d.sq === 1, `the file's square is not an editable overlay object: ${JSON.stringify(d)}`);
  check(d.shown === 0, `the shown document still has ${d.shown} Squares with the square mirrored (drawn twice): ${JSON.stringify(d)}`);
  check(d.mine === 1, `the added rect: ${d.mine} overlay objects, expected 1: ${JSON.stringify(d)}`);
  check(!d.dirty, `the tab is dirty after the save: ${JSON.stringify(d)}`);

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('SAVESWAP OK');
} catch (err) {
  console.error(`saveswap e2e FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
