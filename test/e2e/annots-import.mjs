#!/usr/bin/env node
// End-to-end test of editing markup annotations made by another app (renderer/ui/annotations.js file
// mirror + view copy) in Chromium via playwright-core: a fixture with a foreign /Square (no /NM, built
// with pdf-lib low-level calls), a Link and a form field. The square opens as an editable object drawn
// only by the overlay (canvas pixels), is moved, saved (1 Square at the new place, Link and field
// untouched), saved again unchanged (same bytes), deleted (0 Squares); a new rect saved twice is not
// duplicated; Document > Flatten annotations… with Save first leaves no markup and undo restores it.
// Then, each in a new tab: two foreign annotations on page 3 survive Delete page 1 + Save byte for
// byte (not rewritten as edited); a save racing the reload that re-imports a flattened annotation
// (Flatten, page Undo) leaves the mirror in step, so the next save writes no duplicate; Save burns a
// whiteout and Undo/Redo afterwards neither dirty the tab nor bring the whiteout back to burn again;
// Flatten, page Undo, page Redo, Save leaves no markup and the square burned in once; deleting the
// imported square without saving and then Flatten does not burn it back in.
// Prints "ANNOTS-IMPORT OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRef, PDFRawStream } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const H = 792;
const SQ = { x: 100, y: 100, w: 100, h: 60 }; // visible space

async function makePdf() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, H]);
  const ctx = doc.context;
  // Foreign square, as another app writes it: no /NM, red 4pt border, its own appearance.
  const ap = ctx.stream('1 0 0 RG 4 w 2 2 96 56 re S', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, SQ.w, SQ.h] });
  const square = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [SQ.x, H - SQ.y - SQ.h, SQ.x + SQ.w, H - SQ.y], C: [1, 0, 0], BS: { W: 4 }, F: 4, T: PDFString.of('Other App'), AP: { N: ctx.register(ap) } });
  const link = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [300, 600, 400, 620], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com/') } });
  p.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(square), ctx.register(link)]));
  const f = doc.getForm().createTextField('name');
  f.setText('Ahmad');
  f.addToPage(p, { x: 300, y: 400, width: 150, height: 24 });
  return Buffer.from(await doc.save());
}
/** Three pages; page 3 has a foreign /Square and /Circle (no /NM), each with its own appearance. */
async function makeThreePagePdf() {
  const doc = await PDFDocument.create();
  for (let k = 0; k < 3; k++) doc.addPage([612, H]);
  const ctx = doc.context, p = doc.getPage(2);
  const ap = (ops) => ctx.register(ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 60] }));
  const sq = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 500, 200, 560], C: [1, 0, 0], BS: { W: 3 }, F: 4, T: PDFString.of('Other App'), AP: { N: ap('1 0 0 RG 3 w 1.5 1.5 97 57 re S') } });
  const ci = ctx.obj({ Type: 'Annot', Subtype: 'Circle', Rect: [300, 400, 400, 460], C: [0, 0, 1], BS: { W: 2 }, F: 4, T: PDFString.of('Other App'), AP: { N: ap('0 0 1 RG 2 w 1 30 m 1 60 99 60 99 30 c S') } });
  p.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(sq), ctx.register(ci)]));
  return Buffer.from(await doc.save());
}
/** Contents of the markup annotation dictionaries on page `pageIndex`, refs resolved (not /P), sorted. */
async function markupDicts(bytes, pageIndex) {
  const doc = await PDFDocument.load(bytes), ctx = doc.context;
  const deep = (v, seen) => {
    if (v instanceof PDFRef) return seen.has(String(v)) ? '<cycle>' : deep(ctx.lookup(v), new Set([...seen, String(v)]));
    if (v instanceof PDFRawStream) return `${deep(v.dict, seen)}stream:${Buffer.from(v.contents).toString('hex')}`;
    if (v instanceof PDFDict) return `<<${[...v.entries()].filter(([k]) => String(k) !== '/P').map(([k, x]) => `${k} ${deep(x, seen)}`).sort().join(' ')}>>`;
    if (v instanceof PDFArray) return `[${v.asArray().map((x) => deep(x, seen)).join(' ')}]`;
    return String(v);
  };
  const annots = doc.getPage(pageIndex).node.Annots()?.asArray() ?? [];
  return annots.map((r) => ctx.lookup(r)).filter((d) => /^\/(Square|Circle)$/.test(String(d.get(PDFName.of('Subtype'))))).map((d) => deep(d, new Set())).sort();
}
/** {squares: [{x,y,w,h}], other: ['Link:<dict>', 'Widget:<dict>']} of page 1, via pdf-lib in node. */
async function inspect(bytes) {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(0).node.Annots()?.asArray() ?? [];
  const squares = [], other = [];
  for (const ref of annots) {
    const d = doc.context.lookup(ref), sub = d.get(PDFName.of('Subtype')).toString();
    if (sub === '/Square') { const [a, b, c, e] = d.get(PDFName.of('Rect')).asArray().map((n) => n.asNumber()); squares.push({ x: a, y: H - e, w: c - a, h: e - b }); }
    else other.push(`${ref}:${sub}:${d.toString()}`);
  }
  return { squares, other: other.sort(), markup: squares.length + other.filter((o) => !/:\/(Link|Widget|Popup):/.test(o)).length };
}

/** Number of appearances Flatten burned into page 1 (its /ASHFlat* XObjects). */
async function burned(bytes) {
  const doc = await PDFDocument.load(bytes);
  const xo = doc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
  return xo instanceof PDFDict ? xo.keys().filter((k) => /^\/ASHFlat/.test(String(k))).length : 0;
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
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = await makePdf();
  const orig = await inspect(pdf);
  check(orig.squares.length === 1 && orig.other.length === 2, `fixture: ${JSON.stringify(orig)}`);
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const objs = () => ev('return tab.objects.map((o) => ({ ...o }));');
  const save = async (asNew = false) => {
    check(await ev('return await app.saveTab(tab, arg);', asNew), 'saveTab returned false');
    return Buffer.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  };
  // Non-white pixels of the viewer's page-1 canvas inside a visible-space box (points).
  const canvasInk = (b) => ev(`
    const c = document.querySelector('.page[data-page-index="0"] canvas.page-canvas'), k = c.width / 612;
    const D = c.getContext('2d').getImageData(Math.round(arg.x * k), Math.round(arg.y * k), Math.round(arg.w * k), Math.round(arg.h * k)).data;
    let n = 0; for (let i = 0; i < D.length; i += 4) if (D[i + 3] > 0 && (D[i] < 200 || D[i + 1] < 200 || D[i + 2] < 200)) n++;
    return n;`, b);
  // The message reads the dialog only when there is one: page.textContent would wait for it (30 s).
  const noDialog = async () => { const d = await page.$('.dialog'); check(!d, `unexpected dialog: ${d && await d.textContent()}`); };
  const waitRendered = () => page.waitForFunction(() => { const c = document.querySelector('.page[data-page-index="0"] canvas.page-canvas'); return c && c.width > 0; }, null, { timeout: 10_000 });

  step = 'open';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'foreign.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 1 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await waitRendered();
  await frames();
  let list = await objs();
  check(list.length === 1 && list[0].type === 'rect', `foreign square not imported as one rect: ${JSON.stringify(list)}`);
  const sq = list[0];
  // The box is /Rect shrunk by half the 4pt border.
  check(near(sq.x, SQ.x + 2, 0.5) && near(sq.y, SQ.y + 2, 0.5) && near(sq.w, SQ.w - 4, 0.5) && near(sq.h, SQ.h - 4, 0.5) && sq.stroke === '#ff0000', `imported geometry: ${JSON.stringify(sq)}`);
  check(await ev('return !tab.dirty;'), 'opening marked the tab dirty');

  step = 'not drawn twice';
  const edge = { x: SQ.x - 1, y: SQ.y + 10, w: 6, h: SQ.h - 20 }; // left border band of the square
  check(await canvasInk(edge) === 0, 'the foreign square is drawn on the page canvas as well as by the overlay');
  check(await ev('return v.getOverlaySvg(tab, 0).querySelectorAll("rect").length > 0;'), 'overlay does not draw the square');
  await page.waitForSelector('.page[data-page-index="0"] a.pdf-link', { timeout: 10_000 }); // the Link still works
  await noDialog();

  step = 'move + save';
  await ev('an.update(tab, arg, { x: 300, y: 200 });', sq.id);
  const out1 = await save(true);
  const i1 = await inspect(out1);
  check(i1.squares.length === 1, `after move+save: ${i1.squares.length} Squares`);
  check(near(i1.squares[0].x + 2, 300) && near(i1.squares[0].y + 2, 200), `saved square not at the new position: ${JSON.stringify(i1.squares[0])}`);
  check(JSON.stringify(i1.other) === JSON.stringify(orig.other), `Link/field changed:\n${i1.other.join('\n')}\nvs\n${orig.other.join('\n')}`);
  check(await ev('return !tab.dirty && tab.objects.length === 1;'), 'after save: dirty or objects changed');

  step = 'save unchanged';
  const out2 = await save();
  check(Buffer.compare(out1, out2) === 0, 'saving again without changes wrote different bytes');

  step = 'delete + save';
  await ev('an.remove(tab, arg);', sq.id);
  const i3 = await inspect(await save());
  check(i3.squares.length === 0, `after delete+save: ${i3.squares.length} Squares`);
  check(JSON.stringify(i3.other) === JSON.stringify(orig.other), 'Link/field changed by the delete');

  step = 'new rect saved twice';
  await ev('an.add(tab, { type: "rect", page: 0, x: 50, y: 500, w: 80, h: 40, stroke: "#0000ff", strokeWidth: 2 });');
  const i4 = await inspect(await save());
  const i5 = await inspect(await save());
  check(i4.squares.length === 1 && i5.squares.length === 1, `new rect: ${i4.squares.length} then ${i5.squares.length} Squares`);
  await ev('await new Promise((r) => setTimeout(r, 300));');
  check((await objs()).length === 1, 'new rect duplicated in the overlay');

  step = 'flatten after save first';
  await noDialog();
  await ev('an.add(tab, { type: "ellipse", page: 0, x: 400, y: 650, w: 60, h: 40, stroke: "#000000" });');
  await page.click('.menu-btn:text-is("Document")');
  await page.click('.menu-item[data-id="flatten-annotations"]');
  await page.waitForSelector('.dialog');
  await page.click('.dialog button[data-value="save"]');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.bytesUndo?.length === 1; }, null, { timeout: 10_000 });
  const flat = await inspect(Buffer.from(await ev('return Array.from(tab.bytes);')));
  check(flat.markup === 0, `after flatten ${flat.markup} markup annotations remain`);
  check(JSON.stringify(flat.other) === JSON.stringify(orig.other), 'flatten changed the Link/field');
  check((await objs()).length === 0, 'flatten left overlay objects');
  await ev('await app.pageTools.undo(tab);');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t.objects.length === 2; }, null, { timeout: 10_000 });
  const back = await inspect(Buffer.from(await ev('return Array.from(tab.bytes);')));
  check(back.markup === 2, `undo restored ${back.markup} markup annotations, expected 2`);
  await waitRendered();
  await frames();
  check(await canvasInk({ x: 51, y: 505, w: 4, h: 30 }) === 0, 'after undo the restored rect is drawn on the canvas too');

  // Opens `buffer` in a new tab (made active) and waits for its first page to render.
  const openPdf = async (name, buffer, pages) => {
    const ch = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await ch).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction(([n, k]) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId);
      return t?.name === n && t.numPages === k && a.viewer.getOverlaySvg(t, 0); }, [name, pages], { timeout: 10_000 });
    await waitRendered();
  };

  step = 'delete page 1: unedited imports are not rewritten';
  const three = await makeThreePagePdf();
  const origDicts = await markupDicts(three, 2);
  check(origDicts.length === 2, `fixture: ${origDicts.length} markup annotations on page 3`);
  await openPdf('three.pdf', three, 3);
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t.objects.length === 2; }, null, { timeout: 10_000 });
  await ev('await app.pageTools.deletePages(tab, [0], { confirm: false });');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t.numPages === 2 && t.objects.every((o) => o.page === 1); }, null, { timeout: 10_000 });
  await ev('await new Promise((r) => setTimeout(r, 300));'); // let the reload reconcile
  const delOut = await save(true);
  const delDicts = await markupDicts(delOut, 1);
  check(delDicts.length === 2, `after delete page + save: ${delDicts.length} markup annotations on (new) page 2, expected 2`);
  check(JSON.stringify(delDicts) === JSON.stringify(origDicts), `delete page 1 + save rewrote unedited annotations:\n${delDicts.join('\n')}\nvs\n${origDicts.join('\n')}`);
  await noDialog();

  step = 'save racing the reload after Flatten + page undo';
  await openPdf('race.pdf', pdf, 1);
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t.objects.length === 1; }, null, { timeout: 10_000 });
  await ev('an.add(tab, { type: "rect", page: 0, x: 50, y: 500, w: 80, h: 40, stroke: "#0000ff", strokeWidth: 2 });');
  await page.click('.menu-btn:text-is("Document")');
  await page.click('.menu-item[data-id="flatten-annotations"]');
  await page.waitForSelector('.dialog');
  await page.click('.dialog button[data-value="ok"]');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.bytesUndo?.length === 1 && t.objects.length === 1; }, null, { timeout: 10_000 });
  await ev('await new Promise((r) => setTimeout(r, 300));');
  // Hold the next readAnnotations (the page undo's reload) and the save's writeAnnotations at their
  // PDFDocument.load, so beforeSave snapshots before the reload re-imports the square, which lands
  // before the save completes.
  await ev(`const { PDFDocument: D } = await import('pdf-lib');
    const orig = D.load; window.__arm = { readAnnotations: true, writeAnnotations: false }; window.__gate = {};
    D.load = async function (...a) {
      const st = new Error().stack;
      for (const fn of ['readAnnotations', 'writeAnnotations']) if (window.__arm[fn] && st.includes(fn)) {
        window.__arm[fn] = false; await new Promise((r) => { window.__gate[fn] = r; });
      }
      return orig.apply(this, a);
    };`);
  await ev('app.pageTools.undo(tab);');
  await page.waitForFunction(() => !!window.__gate.readAnnotations, null, { timeout: 10_000 });
  await ev('window.__arm.writeAnnotations = true; window.__save = app.saveTab(tab);');
  await page.waitForFunction(() => !!window.__gate.writeAnnotations, null, { timeout: 10_000 });
  await ev('window.__gate.readAnnotations();');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t.objects.length === 2; }, null, { timeout: 10_000 });
  await ev('window.__gate.writeAnnotations();');
  check(await ev('return await window.__save;'), 'first save (racing the reload) failed');
  await noDialog();
  const race2 = await inspect(await save());
  await noDialog();
  check(race2.squares.length === 2, `after the second save: ${race2.squares.length} Squares, expected 2`);
  check(await ev('return !tab.dirty && tab.objects.length === 2;'), 'after the second save: dirty or objects changed');

  step = 'whiteout burned once despite undo/redo after save';
  await openPdf('white.pdf', pdf, 1);
  await ev('an.add(tab, { type: "whiteout", page: 0, x: 400, y: 300, w: 80, h: 40 });');
  const w1 = await save(true);
  check(await ev('return !tab.dirty && !tab.objects.some((o) => o.type === "whiteout");'), 'save did not burn the whiteout');
  await ev('an.undo(tab);');
  check(await ev('return !tab.dirty;'), 'undo after the whiteout was burned marked the tab dirty');
  await ev('an.redo(tab);');
  check(await ev('return !tab.objects.some((o) => o.type === "whiteout");'), 'redo brought the burned whiteout back');
  const w2 = await save();
  check(Buffer.compare(w1, w2) === 0, 'the second save changed the file (whiteout burned again)');

  const flattenVia = async (button) => {
    await page.click('.menu-btn:text-is("Document")');
    await page.click('.menu-item[data-id="flatten-annotations"]');
    await page.waitForSelector('.dialog');
    const hint = await page.$('.dialog .pt-flat-skip');
    await page.click(`.dialog button[data-value="${button}"]`);
    await page.waitForSelector('.dialog', { state: 'detached' });
    await ev('await new Promise((r) => setTimeout(r, 800));'); // the op (or its no-op) and the reload settle
    return !!hint;
  };

  step = 'flatten, page undo, page redo, save: burned in once';
  await openPdf('redo.pdf', pdf, 1);
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t.objects.length === 1; }, null, { timeout: 10_000 });
  await flattenVia('ok');
  check(await ev('return tab.bytesUndo?.length === 1 && tab.objects.length === 0;'), 'flatten did not apply');
  await ev('await app.pageTools.undo(tab);');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t.objects.length === 1; }, null, { timeout: 10_000 });
  await ev('await app.pageTools.redo(tab); await new Promise((r) => setTimeout(r, 500));');
  check(await ev('return tab.bytesRedo.length === 0 && tab.bytesUndo.length === 1;'), 'redo did not apply');
  const redoOut = await save(true);
  const ri = await inspect(redoOut);
  check(ri.markup === 0, `after flatten/undo/redo/save: ${ri.markup} markup annotations in the file, expected 0`);
  check(await burned(redoOut) === 1, `after flatten/undo/redo/save: the square is burned in ${await burned(redoOut)} times, expected 1`);
  check(await ev('return tab.objects.length === 0;'), 'after redo the flattened square is still an overlay object');
  await noDialog();

  step = 'delete the imported square unsaved, then Flatten does not burn it back';
  await openPdf('del.pdf', pdf, 1);
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t.objects.length === 1; }, null, { timeout: 10_000 });
  await ev('an.remove(tab, tab.objects[0].id);');
  check(await flattenVia('ok'), 'the Flatten dialog does not say the deleted annotation is skipped');
  const delFlat = await save(true);
  const di = await inspect(delFlat);
  check(di.markup === 0, `after delete + flatten + save: ${di.markup} markup annotations, expected 0`);
  check(await burned(delFlat) === 0, 'Flatten burned in the annotation the user had deleted');
  await noDialog();

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('ANNOTS-IMPORT OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
