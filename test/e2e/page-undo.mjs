#!/usr/bin/env node
// End-to-end test: page undo/redo brings back the annotations of deleted or replaced pages
// (renderer/ui/pagetools.js history entries + annotations.restorePageObjects), in Chromium via
// playwright-core with the browser shim (same pattern as run.mjs). Prints "PAGE-UNDO OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const H = 792;

async function makePdf(n, label = 'Page') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= n; k++) doc.addPage([612, H]).drawText(`${label} ${k}`, { x: 72, y: 700, size: 28, font });
  return Buffer.from(await doc.save());
}
/** Three pages; page 2 has a saved /Square (no /NM, as another app writes it). */
async function makeAnnotatedPdf() {
  const doc = await PDFDocument.create();
  for (let k = 0; k < 3; k++) doc.addPage([612, H]);
  const ctx = doc.context;
  const ap = ctx.register(ctx.stream('1 0 0 RG 3 w 1.5 1.5 97 57 re S', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 60] }));
  const sq = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 500, 200, 560], C: [1, 0, 0], BS: { W: 3 }, F: 4, T: PDFString.of('Other App'), AP: { N: ap } });
  doc.getPage(1).node.set(PDFName.of('Annots'), ctx.obj([ctx.register(sq)]));
  return Buffer.from(await doc.save());
}
/** Number of /Annot entries on each page. */
async function annotCounts(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.node.Annots()?.size() ?? 0);
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const [four, extra, annotated] = await Promise.all([makePdf(4), makePdf(2, 'Extra'), makeAnnotatedPdf()]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, an = app.annotations, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const objs = () => ev('return tab.objects.map((o) => ({ id: o.id, page: o.page, type: o.type }));');
  // Waits for the page count and lets the reload (viewBytes -> reconcile) finish.
  const settled = async (n) => {
    await page.waitForFunction((k) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.numPages === k && t.pdfDoc; }, n, { timeout: 10_000 });
    await ev('await pt.idle?.(); await new Promise((r) => setTimeout(r, 400));');
  };
  const open = async (name, buffer, pages) => {
    await ev('for (const t of [...app.state.tabs]) { t.dirty = false; await app.closeTab(t); }');
    const ch = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await ch).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction(([n, k]) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.name === n && t.numPages === k; }, [name, pages], { timeout: 10_000 });
    await settled(pages);
  };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });

  step = '(a) delete page 3 with an unsaved rectangle, undo, redo, undo';
  await open('four.pdf', four, 4);
  const rectId = await ev('return an.add(tab, { type: "rect", page: 2, x: 100, y: 200, w: 80, h: 40, stroke: "#ff0000", strokeWidth: 2 }).id;');
  const otherId = await ev('return an.add(tab, { type: "ellipse", page: 3, x: 50, y: 50, w: 40, h: 40, stroke: "#0000ff" }).id;');
  await ev('await pt.deletePages(tab, [2], { confirm: false });');
  await settled(3);
  eq(await objs(), [{ id: otherId, page: 2, type: 'ellipse' }], 'after delete');
  await ev('await pt.undo(tab);');
  await settled(4);
  eq(await objs(), [{ id: rectId, page: 2, type: 'rect' }, { id: otherId, page: 3, type: 'ellipse' }], 'after undo the rectangle is back on page 3 with its id');
  check(await ev('return tab.dirty;'), 'tab not dirty after undo');
  check(await ev('return an.list(tab, 2).some((o) => o.id === arg);', rectId), 'rectangle not listed on page 3');
  await ev('await pt.redo(tab);');
  await settled(3);
  eq(await objs(), [{ id: otherId, page: 2, type: 'ellipse' }], 'after redo the rectangle is gone again');
  await ev('await pt.undo(tab);');
  await settled(4);
  eq(await objs(), [{ id: rectId, page: 2, type: 'rect' }, { id: otherId, page: 3, type: 'ellipse' }], 'after the second undo the rectangle is back');

  step = '(b) replace page 2 holding a note, undo';
  await open('four.pdf', four, 4);
  const noteId = await ev('return an.add(tab, { type: "note", page: 1, x: 300, y: 200, w: 20, h: 20, icon: "Comment", color: "#ffd400", note: "Check size" }).id;');
  await ev(`const { replaceMap } = await import('./ui/pagetools.js');
    await pt.runOp(tab, 'Replace pages', async (bytes, cnt, cc) => ({ bytes: await cc.replacePages(bytes, new Uint8Array(arg), [0], 1), map: replaceMap(cnt, 1, 1) }));`, [...extra]);
  await settled(4);
  eq(await objs(), [], 'after replace the note is gone');
  await ev('await pt.undo(tab);');
  await settled(4);
  eq(await ev('return tab.objects.map((o) => [o.id, o.page, o.type, o.note]);'), [[noteId, 1, 'note', 'Check size']], 'after undo the note is back on page 2');

  step = '(c) saved annotation on page 2: delete page 2, undo, save';
  await open('annotated.pdf', annotated, 3);
  const saved = await objs();
  check(saved.length === 1 && saved[0].page === 1, `fixture import: ${JSON.stringify(saved)}`);
  await ev('await pt.deletePages(tab, [1], { confirm: false });');
  await settled(2);
  eq(await objs(), [], 'after delete');
  await ev('await pt.undo(tab);');
  await settled(3);
  eq(await objs(), saved, 'after undo exactly one copy of the saved annotation');
  await ev('await new Promise((r) => setTimeout(r, 400));');
  eq(await objs(), saved, 'the reload did not import a second copy');
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  const out = Buffer.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  eq(await annotCounts(out), [0, 1, 0], 'annotations per page in the saved file');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('PAGE-UNDO FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('PAGE-UNDO OK');
