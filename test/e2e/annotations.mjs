#!/usr/bin/env node
// End-to-end test of the annotation layer (renderer/ui/annotations.js, ui/tools-shapes.js) in
// Chromium via playwright-core: draws every markup tool with real mouse events at 100 %, 150 %,
// view rotation 90 and on a /Rotate 90 page, edits the selection (move, resize, nudge, delete,
// undo/redo, duplicate, style), remaps pages, saves twice through app.saveTab and checks the
// flattened output with pdf-lib and pdf.js pixels. Prints "ANNOTATIONS OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= 3; k++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${k}`, { x: 360, y: 700, size: 20, font });
    if (k === 2) p.setRotation(degrees(90));
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
const near = (a, b, msg, tol = 1) => check(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} (±${tol})`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = await makePdf();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, bus = app.bus, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const key = async (k) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(k); };
  const objs = () => ev('return tab.objects.map((o) => ({ ...o }));');
  const toClient = (i, x, y) => ev('const c = v.pageToClient(tab, arg[0], arg[1], arg[2]); return [c.clientX, c.clientY];', [i, x, y]);
  const toPage = (c) => ev('return v.clientToPage(tab, arg[0], arg[1]);', c);
  const drag = async (pts) => {
    await page.mouse.move(...pts[0]);
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1], { steps: 5 });
    await page.mouse.up();
  };
  const setDash = async (d) => { if (await page.$('.opt-dash')) await page.selectOption('.opt-dash', d); };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'three.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 3 && a.viewer.getOverlaySvg(t, 1); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await frames();

  // ------------------------------------------------------------ draw every tool, 4 geometries
  const TOOLS = [
    { key: 'r', type: 'rect', a: [40, 40], b: [140, 100] },
    { key: 'e', type: 'ellipse', a: [160, 40], b: [260, 100] },
    { key: 'l', type: 'line', dash: 'dotted', a: [40, 130], b: [240, 130] },
    { key: 'a', type: 'arrow', a: [40, 160], b: [200, 220] },
    { key: 'p', type: 'ink', a: [40, 240], via: [[90, 280], [140, 250]], b: [200, 290] },
    { key: 'h', type: 'highlight', a: [220, 240], b: [300, 270] },
    { button: 'whiteout', type: 'whiteout', a: [220, 160], b: [300, 200] },
  ];
  const SCENARIOS = [
    { name: 'zoom 100%', pageIndex: 0, zoom: 1, rot: 0 },
    { name: 'zoom 150%', pageIndex: 0, zoom: 1.5, rot: 0 },
    { name: 'view rotation 90', pageIndex: 0, zoom: 1, rot: 90 },
    { name: '/Rotate 90 page', pageIndex: 1, zoom: 1, rot: 0 },
  ];
  for (const [k, sc] of SCENARIOS.entries()) {
    step = `draw (${sc.name})`;
    await ev('v.setZoom(tab, arg.zoom); if (tab.viewRotation !== arg.rot) v.rotateView(tab, arg.rot - tab.viewRotation); v.scrollToPage(tab, arg.pageIndex);', sc);
    await frames();
    for (const t of TOOLS) {
      const lineY = t.type === 'line' ? 8 * k : 0; // keep each scenario's dotted line apart
      const pts = [t.a, ...(t.via ?? []), t.b].map(([x, y]) => [x, y + lineY]);
      await key('Escape');
      if (t.key) await key(t.key); else await page.click(`[data-tool="${t.button}"]`);
      await setDash(t.dash ?? 'solid');
      await frames(); // the options bar may have changed height and moved the pages
      const clients = [];
      for (const [x, y] of pts) clients.push(await toClient(sc.pageIndex, x, y));
      const n0 = (await objs()).length;
      await drag(clients);
      const all = await objs();
      check(all.length === n0 + 1, `${sc.name} ${t.type}: object count ${all.length} != ${n0 + 1}`);
      const o = all.at(-1);
      const A = await toPage(clients[0]), B = await toPage(clients.at(-1));
      check(o.type === t.type && o.page === sc.pageIndex && A.pageIndex === sc.pageIndex && B.pageIndex === sc.pageIndex, `${sc.name} ${t.type}: type/page ${o.type}/${o.page}`);
      const m = `${sc.name} ${t.type}`;
      if ('x1' in o) {
        near(o.x1, A.x, `${m} x1`); near(o.y1, A.y, `${m} y1`); near(o.x2, B.x, `${m} x2`); near(o.y2, B.y, `${m} y2`);
      } else if (o.points) {
        near(o.points[0][0], A.x, `${m} first x`); near(o.points[0][1], A.y, `${m} first y`);
        near(o.points.at(-1)[0], B.x, `${m} last x`); near(o.points.at(-1)[1], B.y, `${m} last y`);
      } else {
        near(o.x, Math.min(A.x, B.x), `${m} x`); near(o.y, Math.min(A.y, B.y), `${m} y`);
        near(o.w, Math.abs(B.x - A.x), `${m} w`); near(o.h, Math.abs(B.y - A.y), `${m} h`);
      }
      if (t.type === 'line') check(o.dash === 'dotted', `${m}: dash ${o.dash}`);
      if (['rect', 'ellipse', 'arrow', 'ink'].includes(t.type)) check(o.stroke === '#d62828' && o.dash === 'solid', `${m}: style ${o.stroke}/${o.dash}`);
      // Sanity: the object renders in the page overlay with that id.
      check(await ev('return !!v.getOverlaySvg(tab, arg[0]).querySelector(`[data-obj-id="${arg[1]}"]`);', [sc.pageIndex, o.id]), `${m}: not rendered`);
    }
  }
  await ev('v.setZoom(tab, 1); if (tab.viewRotation) v.rotateView(tab, -tab.viewRotation); v.scrollToPage(tab, 0);');
  await frames();
  check((await objs()).length === 28, 'expected 28 objects after drawing');

  // ------------------------------------------------------------ selection engine
  step = 'select';
  await key('Escape');
  await key('r');
  await setDash('solid');
  await frames();
  await drag([await toClient(0, 350, 400), await toClient(0, 450, 480)]);
  const sid = (await objs()).at(-1).id;
  const obj = async (id = sid) => (await objs()).find((o) => o.id === id);
  const sel = () => ev('return an.getSelection(tab);');
  check(JSON.stringify(await sel()) === JSON.stringify([sid]), 'new shape not selected');
  await key('v');
  check(await ev('return app.state.tool;') === 'select', 'V did not select the Select tool');
  await page.mouse.click(...await toClient(0, 540, 300));
  check((await sel()).length === 0, 'click on empty page did not clear the selection');
  await frames();
  await page.mouse.click(...await toClient(0, 400, 440));
  check(JSON.stringify(await sel()) === JSON.stringify([sid]), 'click did not select the rectangle');
  await frames(); // the options bar appears with a selection
  const centre = await toClient(0, 400, 440);

  step = 'move by drag';
  let o0 = await obj();
  const moved = [centre[0] + 30, centre[1] + 20];
  await drag([centre, moved]);
  let p0 = await toPage(centre), p1 = await toPage(moved);
  let o1 = await obj();
  near(o1.x, o0.x + (p1.x - p0.x), 'move x'); near(o1.y, o0.y + (p1.y - p0.y), 'move y');
  near(o1.w, o0.w, 'move keeps w', 1e-6);

  step = 'resize by handle';
  o0 = o1;
  const se = await toClient(0, o0.x + o0.w, o0.y + o0.h);
  await page.mouse.move(...se);
  check(await ev('return v.getScrollEl(tab).style.cursor;') === 'nwse-resize', 'hover cursor on se handle');
  const se2 = [se[0] + 24, se[1] + 12];
  await drag([se, se2]);
  p0 = await toPage(se); p1 = await toPage(se2);
  o1 = await obj();
  near(o1.x, o0.x, 'resize keeps x', 1e-6); near(o1.w, o0.w + (p1.x - p0.x), 'resize w'); near(o1.h, o0.h + (p1.y - p0.y), 'resize h');
  await key('Control+z');
  near((await obj()).w, o0.w, 'undo resize', 1e-6);
  await key('Control+y');
  near((await obj()).w, o1.w, 'redo resize', 1e-6);

  step = 'nudge';
  o0 = await obj();
  await key('ArrowRight');
  await key('Shift+ArrowDown');
  o1 = await obj();
  near(o1.x, o0.x + 1, 'nudge x', 1e-6); near(o1.y, o0.y + 10, 'nudge y', 1e-6);
  await key('Control+z'); // consecutive nudges of one selection coalesce into one undo step
  o1 = await obj();
  near(o1.x, o0.x, 'undo nudge x', 1e-6); near(o1.y, o0.y, 'undo nudge y', 1e-6);
  await key('Control+y');

  step = 'style live';
  const rectEl = () => ev('const el = v.getOverlaySvg(tab, 0).querySelector(`[data-obj-id="${arg}"]`); return [el.getAttribute("stroke"), el.getAttribute("stroke-width"), el.getAttribute("stroke-dasharray")];', sid);
  await page.$eval('.opt-color', (el) => { el.value = '#0000ff'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('.opt-width', (el) => { el.value = '4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.selectOption('.opt-dash', 'dashed');
  o1 = await obj();
  check(o1.stroke === '#0000ff' && o1.strokeWidth === 4 && o1.dash === 'dashed', `style patch ${o1.stroke}/${o1.strokeWidth}/${o1.dash}`);
  check(JSON.stringify(await rectEl()) === JSON.stringify(['#0000ff', '4', '20 12']), `rendered style ${JSON.stringify(await rectEl())}`);
  check(JSON.stringify(await sel()) === JSON.stringify([sid]), 'style change lost the selection');

  step = 'screenshot';
  await page.mouse.move(5, 500);
  await frames();
  const box = await ev('const r = v.getPageEl(tab, 0).getBoundingClientRect(); return [r.left, r.top];');
  await page.screenshot({ path: join(OUT, 'annotations.png'), clip: { x: box[0], y: Math.max(0, box[1]), width: 816, height: 700 } });

  step = 'duplicate';
  let n = (await objs()).length;
  await key('Control+d');
  const all = await objs();
  check(all.length === n + 1, 'Ctrl+D did not duplicate');
  const dup = all.at(-1);
  o1 = await obj();
  near(dup.x, o1.x + 12, 'duplicate offset x', 1e-6); near(dup.y, o1.y + 12, 'duplicate offset y', 1e-6);
  check(JSON.stringify(await sel()) === JSON.stringify([dup.id]) && dup.stroke === '#0000ff', 'duplicate not selected / style lost');

  step = 'delete, undo, redo';
  n = all.length;
  await key('Delete');
  check((await objs()).length === n - 1 && !(await obj(dup.id)), 'Delete did not remove the selection');
  await key('Control+z');
  check((await objs()).length === n && await obj(dup.id), 'undo did not restore the deleted object');
  await key('Control+y');
  check((await objs()).length === n - 1, 'redo did not delete again');
  check(await ev('return !document.getElementById("btn-undo").disabled && !!tab.dirty;'), 'undo button / dirty flag');

  step = 'Esc';
  await page.mouse.click(...await toClient(0, 400, 440));
  check((await sel()).length === 1, 'reselect failed');
  await key('Escape');
  check((await sel()).length === 0 && await ev('return app.state.tool;') === 'select', 'Esc did not clear the selection');
  await key('e');
  check(await ev('return app.state.tool;') === 'shapes', 'E did not pick Shapes');
  await key('Escape');
  check(await ev('return app.state.tool;') === 'select', 'Esc did not return to Select');

  // ------------------------------------------------------------ save twice
  step = 'save';
  const count = (await objs()).length;
  const whiteouts = await ev('return tab.objects.filter((o) => o.type === "whiteout").length;');
  check(await ev('window.__orig = tab.bytes; return await app.saveTab(tab, true);'), 'first saveTab returned false');
  const out1 = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  // Since annotations are saved as real PDF annotations, a save makes the written file the new baseline
  // (tab.bytes) and burns whiteout into the page, so whiteout objects leave tab.objects.
  const st = await ev('return { same: tab.bytes === window.__orig, n: tab.objects.length, dirty: !!tab.dirty, types: tab.objects.map((o) => o.type) };');
  check(!st.same && st.n === count - whiteouts && !st.dirty, `save: expected new baseline, ${count - whiteouts} objects, clean; got ${JSON.stringify(st)} (before: ${count}, whiteouts ${whiteouts})`);
  check(await ev('return await app.saveTab(tab, false);'), 'second saveTab returned false');
  const out2 = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  check(out2.length === out1.length && out2.every((b, i) => b === out1[i]), 'second save without changes wrote different bytes');
  const d1 = await PDFDocument.load(out1), d2 = await PDFDocument.load(out2);
  check(d2.getPageCount() === 3, `saved page count ${d2.getPageCount()}`);
  const objCount = (d) => d.context.enumerateIndirectObjects().length;
  check(objCount(d1) === objCount(d2), `second save has ${objCount(d2)} objects, first ${objCount(d1)} (double flatten?)`);
  check(objCount(d1) > objCount(await PDFDocument.load(pdf)), 'save did not add flattened content');

  step = 'pixels';
  const px = await ev(`
    const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg) }).promise, S = 4, res = {};
    const red = (ctx, x, y) => { const D = ctx.getImageData(Math.round(x * S) - 2, Math.round(y * S) - 2, 5, 5).data;
      for (let k = 0; k < D.length; k += 4) if (D[k] > 150 && D[k + 1] < 100 && D[k + 2] < 100) return true; return false; };
    for (const n of [1, 2]) {
      const pg = await d.getPage(n), vp = pg.getViewport({ scale: S });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      res[n] = { size: [vp.width / S, vp.height / S], left: red(ctx, 40, 70), top: red(ctx, 90, 40), right: red(ctx, 140, 70), centre: red(ctx, 90, 70) };
      if (n === 1) {
        const runs = []; let prev = null;
        for (let x = 50; x <= 230; x += 0.25) { const r = red(ctx, x, 130); if (r !== prev) runs.push(r); prev = r; }
        res[n].dotRuns = runs.length; res[n].gapBefore = red(ctx, 30, 130);
      }
    }
    await d.loadingTask.destroy(); return res;`, Array.from(out2));
  check(px[1].left && px[1].top && px[1].right && !px[1].centre, `page 1 rectangle pixels ${JSON.stringify(px[1])}`);
  check(px[1].dotRuns >= 40 && !px[1].gapBefore, `dotted line is not dotted: ${px[1].dotRuns} red/non-red runs`);
  check(px[2].size[0] === 792 && px[2].left && px[2].top && px[2].right && !px[2].centre, `rotated page 2 rectangle pixels ${JSON.stringify(px[2])}`);

  // ------------------------------------------------------------ pages:remapped
  step = 'remap';
  await ev('an.add(tab, { type: "rect", page: 2, x: 10, y: 10, w: 20, h: 20, stroke: "#000000" });');
  const before = await objs();
  await ev('bus.emit("pages:remapped", { tab, map: new Map([[0, 0], [1, null], [2, 1]]) });');
  const after = await objs();
  const expected = before.filter((o) => o.page !== 1).map((o) => [o.id, o.page === 2 ? 1 : 0]);
  check(JSON.stringify(after.map((o) => [o.id, o.page])) === JSON.stringify(expected), 'remap dropped/renumbered objects wrongly');
  check(after.length === before.length - before.filter((o) => o.page === 1).length && before.filter((o) => o.page === 1).length >= 6 && after.some((o) => o.page === 1), 'remap counts');
  check(await ev('return tab.undo.length > 0 && !document.getElementById("btn-undo").disabled;'), 'remap dropped the annotation history (page changes keep it: undo runs in time order)');

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('ANNOTATIONS OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
