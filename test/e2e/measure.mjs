#!/usr/bin/env node
// End-to-end test of measurement objects (renderer/ui/annotations.js, measure-lib.js): distance
// label, live re-measure on handle drag, polygon vertex handles. Prints "MEASURE OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, degrees } from 'pdf-lib';
import { writeViewports } from '../../src/core/annots.js';
import { scaleFromDrawingScale } from '../../src/core/measure.js';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

// One page with /Rotate 90 and a MediaBox offset by (50, 50), a line from (100, 200) to (400, 200):
// in page space (origin top-left of the turned page) that is (150, 50)-(150, 350).
async function makeRotatedPdf() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, 792]);
  p.setMediaBox(50, 50, 612, 792);
  p.setRotation(degrees(90));
  p.drawLine({ start: { x: 100, y: 200 }, end: { x: 400, y: 200 }, thickness: 1 });
  return Buffer.from(await doc.save());
}
async function makePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawLine({ start: { x: 100, y: 100 }, end: { x: 300, y: 100 }, thickness: 1 }); // snap target: page space (100, 692)-(300, 692)
  doc.addPage([612, 792]);
  // Page 1: a whole-sheet 1:50 mm viewport and another app's partial detail viewport at 1:5.
  writeViewports(doc, 0, [{ bbox: [0, 0, 612, 792], name: 'Sheet', scale: scaleFromDrawingScale(50, 'mm') }, { bbox: [400, 20, 600, 200], name: 'Detail A', scale: scaleFromDrawingScale(5, 'mm') }]);
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const toClient = (x, y) => ev('const c = v.pageToClient(tab, 0, arg[0], arg[1]); return [c.clientX, c.clientY];', [x, y]);
  const drag = async (a, b) => { await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(b[0], b[1], { steps: 6 }); await page.mouse.up(); };
  const label = (id) => ev('return v.getOverlaySvg(tab, 0).querySelector(`[data-obj-id="${arg}"] .ann-measure-label text`)?.textContent ?? null;', id);

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'measure.pdf', mimeType: 'application/pdf', buffer: await makePdf() });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 2 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await frames();

  step = 'distance label';
  const L = (2500 / 50) * (72 / 25.4); // 2500 mm at 1:50
  const id = await ev(`const { scaleFromDrawingScale } = await import('/src/core/measure.js');
    const o = an.add(tab, { type: 'line', page: 0, x1: 100, y1: 200, x2: 100 + arg, y2: 200, stroke: '#d62828', strokeWidth: 1, measure: { kind: 'distance', scale: scaleFromDrawingScale(50, 'mm') } });
    an.select(tab, [o.id]); return o.id;`, L);
  await frames();
  check(await label(id) === '2500 mm', `label ${await label(id)} != 2500 mm`);
  check(await ev('return v.getOverlaySvg(tab, 0).querySelectorAll(`[data-obj-id="${arg}"] .ann-measure-tick`).length;', id) === 2, 'two end ticks');
  const fs1 = await ev('return v.getOverlaySvg(tab, 0).querySelector(`[data-obj-id="${arg}"] .ann-measure-label text`).getBoundingClientRect().height;', id);
  await ev('v.setZoom(tab, 2);'); await frames();
  const fs2 = await ev('return v.getOverlaySvg(tab, 0).querySelector(`[data-obj-id="${arg}"] .ann-measure-label text`).getBoundingClientRect().height;', id);
  near(fs2 / fs1, 2, 'label scales with zoom', 0.15);
  await ev('v.setZoom(tab, 1);'); await frames();

  step = 'drag the end handle';
  await page.click('[data-tool="select"]');
  const undo0 = await ev('return tab.undo.length;');
  await drag(await toClient(100 + L, 200), await toClient(100 + L / 2, 200));
  await frames();
  check(await label(id) === '1250 mm', `label after drag ${await label(id)} != 1250 mm`);
  check(await ev('return an.getObject(tab, arg).measure.label;', id) === '1250 mm', 'stored measure label follows the drag');
  check(await ev('return tab.undo.length;') === undo0 + 1, 'one undo step per drag');
  await ev('an.undo(tab);'); await frames();
  check(await label(id) === '2500 mm', 'undo restores the label');

  step = 'polygon';
  const pid = await ev(`const { scaleFromDrawingScale } = await import('/src/core/measure.js');
    const o = an.add(tab, { type: 'polygon', page: 0, points: [[100, 400], [300, 400], [300, 550], [100, 550]], stroke: '#1f6feb', strokeWidth: 1, measure: { kind: 'area', scale: scaleFromDrawingScale(50, 'm') } });
    an.select(tab, [o.id]); return o.id;`);
  await frames();
  check(await ev('return v.getOverlaySvg(tab, 0).querySelectorAll(".ann-handle").length;') === 4, 'one handle per vertex');
  check(await ev('const p = v.getOverlaySvg(tab, 0).querySelector(`[data-obj-id="${arg}"] path`); return p.getAttribute("d").endsWith("Z") && p.getAttribute("fill-opacity") === "0.2";', pid), 'closed path with a translucent area fill');
  const a0 = await label(pid);
  await drag(await toClient(300, 550), await toClient(400, 650));
  await frames();
  const pts = await ev('return an.getObject(tab, arg).points;', pid);
  near(pts[2][0], 400, 'vertex 2 x'); near(pts[2][1], 650, 'vertex 2 y');
  check(pts[0][0] === 100 && pts[1][0] === 300 && pts[3][1] === 550, 'other vertices unchanged');
  check(await label(pid) !== a0 && /m²$/.test(await label(pid)), `area label updates (${a0} -> ${await label(pid)})`);
  await page.screenshot({ path: join(OUT, 'measure.png') });

  step = 'opening reads the page scale';
  await page.waitForFunction(() => { const a = window.ashStudio; return a.annotations.measureScaleOf(a.state.tabs[0], 0).source === 'pdf'; }, null, { timeout: 5_000 }).catch(() => {});
  const s0 = await ev('return an.measureScaleOf(tab, 0);');
  check(s0.source === 'pdf' && s0.scale.label === '1:50' && s0.scale.unit === 'mm', `page 1 scale from the PDF: ${JSON.stringify(s0)}`);
  check((await ev('return an.measureScaleOf(tab, 1).source;')) === 'default', 'page 2 has no /VP: default');

  step = 'preset 1:100 m on all pages, one undo step';
  await ev(`const { scaleFromDrawingScale } = await import('/src/core/measure.js'); an.setMeasureScale(tab, 'all', scaleFromDrawingScale(100, 'm'));`);
  check((await ev('return [0, 1].map((i) => an.measureScaleOf(tab, i).scale.label + " " + an.measureScaleOf(tab, i).scale.unit).join();')) === '1:100 m,1:100 m', 'both pages 1:100 m');
  await ev('an.undo(tab);');
  check((await ev('return an.measureScaleOf(tab, 0).scale.label;')) === '1:50', 'undo restores 1:50');
  await ev('an.redo(tab);');

  step = 'save writes /VP; reading back keeps scale, measurement and the foreign viewport';
  const back = await ev(`const { scaleFromDrawingScale } = await import('/src/core/measure.js');
    const core = await import('/src/core/annots.js');
    const { PDFDocument } = await import('/renderer/vendor/pdf-lib.esm.min.js');
    const m = an.add(tab, { type: 'line', page: 0, x1: 100, y1: 500, x2: 100 + 2000 / 50 * 72 / 25.4, y2: 500, stroke: '#d62828', measure: { kind: 'distance', scale: scaleFromDrawingScale(50, 'mm') } });
    const hook = app.state.hooks.beforeSave.find((h) => h.id === 'annotations');
    const out = await hook(tab, tab.bytes);
    const r = await core.readAnnotations(out, { scales: true });
    const doc = await PDFDocument.load(out);
    return { scales: r.scales.map((s) => s && s.label + ' ' + s.unit), vps: core.readViewports(doc, 0).map((v) => v.name),
      label: r.objects.find((o) => o.id === m.id)?.measure?.label };`);
  check(back.scales.join() === '1:100 m,1:100 m', `scales read back: ${back.scales}`);
  check(back.vps.join() === 'Sheet,ASH,Detail A', `our /VP after the foreign whole-page one, the foreign detail kept last: ${back.vps}`);
  check(back.label === '2000 mm', `measurement keeps its own 1:50 scale: ${back.label}`);

  // ---- the scale dialog (renderer/ui/measure-scale.js)
  const scale0 = () => ev('return an.measureScaleOf(tab, 0);');
  const openDlg = async () => {
    await page.click('.menu-btn[data-menu="Tools"]');
    await page.click('.menu-item[data-id="measure-scale"]');
    await page.waitForSelector('.ms-dialog', { timeout: 5_000 });
  };
  const dlgGone = () => page.waitForSelector('.ms-dialog', { state: 'detached', timeout: 5_000 });
  await ev('v.scrollToPage(tab, 0); v.setZoom(tab, 1);'); await frames();

  step = 'dialog from the menu: 1:20 mm on this page';
  await openDlg();
  check((await page.textContent('#ms-source')) === '1:100', `source shown: ${await page.textContent('#ms-source')}`);
  const u0 = await ev('return tab.undo.length;');
  await page.selectOption('#ms-preset', '20');
  await page.selectOption('#ms-unit', 'mm');
  await page.click('.ms-dialog [data-value="ok"]');
  await dlgGone();
  let s = await scale0();
  check(s.scale.label === '1:20' && s.scale.unit === 'mm' && s.source === 'preset', `1:20 mm: ${JSON.stringify(s)}`);
  near(s.scale.ratio, (25.4 / 72) * 20, '1:20 mm ratio', 1e-9);
  check((await ev('return an.measureScaleOf(tab, 1).scale.label;')) === '1:100', 'this page only');
  check((await ev('return tab.undo.length;')) === u0 + 1, 'one undo step');

  step = 'calibrate: two clicks 100 pt apart = 1000 mm';
  await openDlg();
  await page.click('.ms-dialog [data-value="calibrate"]');
  await dlgGone();
  await page.mouse.click(...await toClient(400, 300));
  await page.mouse.move(...await toClient(450, 302), { steps: 3 });
  check(await ev('return !!v.getPageEl(tab, 0).querySelector(".ms-cal-line");'), 'preview line while picking');
  await page.mouse.click(...await toClient(500, 300));
  await page.waitForSelector('.ms-dialog', { timeout: 5_000 });
  check(/100\.0 pt/.test(await page.textContent('.ms-picked')), `picked length: ${await page.textContent('.ms-picked')}`);
  await page.fill('#ms-real', '1000');
  await page.selectOption('#ms-cal-unit', 'mm');
  await page.click('.ms-dialog [data-value="ok"]');
  await dlgGone();
  s = await scale0();
  check(s.source === 'calibrated' && s.scale.unit === 'mm', `calibrated: ${JSON.stringify(s)}`);
  near(s.scale.ratio, 10, 'calibrated ratio 1000 mm / 100 pt', 0.01);
  const calibrated = s;

  step = 'Esc cancels a calibration';
  const u1 = await ev('return tab.undo.length;');
  await openDlg();
  await page.click('.ms-dialog [data-value="calibrate"]');
  await dlgGone();
  await page.mouse.click(...await toClient(400, 300));
  await page.mouse.move(...await toClient(480, 300), { steps: 3 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ms-dialog', { timeout: 5_000 });
  check(!(await page.$('.ms-picked')), 'no picked length after Esc');
  await page.click('.ms-dialog [data-value="cancel"]');
  await dlgGone();
  check(JSON.stringify(await scale0()) === JSON.stringify(calibrated) && (await ev('return tab.undo.length;')) === u1, 'Esc changes nothing');

  step = 'a too-short line is refused';
  await openDlg();
  await page.click('.ms-dialog [data-value="calibrate"]');
  await dlgGone();
  await page.mouse.click(...await toClient(400, 300));
  await page.mouse.click(...await toClient(403, 300));
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /too short/.test(t.textContent)), null, { timeout: 3_000 });
  check(!(await page.$('.ms-dialog')), 'the pick goes on after a refused line');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ms-dialog', { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await dlgGone();
  check(JSON.stringify(await scale0()) === JSON.stringify(calibrated) && (await ev('return tab.undo.length;')) === u1, 'a refused line changes nothing');

  step = 'imperial preset 1/4" = 1\'-0"';
  await openDlg();
  await page.check('input[name="ms-mode"][value="imperial"]');
  await page.selectOption('#ms-imperial', '2');
  await page.click('.ms-dialog [data-value="ok"]');
  await dlgGone();
  s = await scale0();
  check(s.scale.label === '1/4" = 1\'-0"' && s.scale.unit === 'ft' && s.scale.style === 'architectural', `imperial: ${JSON.stringify(s)}`);
  near(s.scale.ratio, 1 / 18, '1/4" = 1\'-0" ratio (18 pt per foot)', 1e-12);
  const chip = await ev(`const { scaleChip } = await import('/renderer/ui/measure-scale.js');
    const d = document.createElement('div'); document.body.append(d); scaleChip()(d); const t = d.textContent; d.remove(); return t;`);
  check(chip === 'Scale 1/4" = 1\'-0" (ft-in)', `chip: ${chip}`);

  step = 'undo restores the previous scale';
  await ev('an.undo(tab);');
  check(JSON.stringify(await scale0()) === JSON.stringify(calibrated), `undo: ${JSON.stringify(await scale0())}`);

  // ---------------------------------------------------------------- measure tools
  step = 'measure tools: 1:100 mm on page 1';
  await ev(`const { scaleFromDrawingScale } = await import('/src/core/measure.js');
    an.select(tab, []); an.setMeasureScale(tab, 0, scaleFromDrawingScale(100, 'mm'), 'preset'); app.state.toolStyle.color = '#123456'; app.setTool('select');`);
  const MM = 100 * (25.4 / 72); // mm per page point at 1:100
  const objCount = () => ev('return tab.objects.length;');
  const lastObj = () => ev('return tab.objects[tab.objects.length - 1];');
  const setTool = (id) => ev('app.setTool(arg);', id);
  const getKind = () => ev('const { measureTools } = await import("/renderer/ui/tools-measure.js"); return measureTools.getKind();');
  // The one Measure tool, then its Distance / Perimeter / Area segment in the options bar.
  const useMeasure = async (kind) => {
    await setTool('measure');
    await page.click(`.opt-measure[data-kind="${kind}"]`);
    check((await getKind()) === kind, `kind ${kind}: ${await getKind()}`);
    check((await page.getAttribute(`.opt-measure[data-kind="${kind}"]`, 'aria-pressed')) === 'true', `${kind} segment pressed`);
  };
  const at = (x, y) => toClient(x, y);

  step = 'Distance: two clicks 100 pt apart';
  await useMeasure('distance');
  check((await ev('return app.state.toolStyle.color;')) === '#d32f2f', 'Distance colour swapped in');
  let n0 = await objCount();
  await page.mouse.click(...await at(100, 400));
  await page.mouse.move(...await at(150, 400), { steps: 3 });
  check(await ev('return !!v.getOverlaySvg(tab, 0).querySelector(".ann-measure-label text");'), 'preview has a label');
  await page.mouse.click(...await at(200, 400));
  let o = await lastObj();
  check((await objCount()) === n0 + 1 && o.type === 'line' && o.measure?.kind === 'distance', `distance object: ${JSON.stringify(o)}`);
  near(o.measure?.value, 100 * MM, 'distance value 100 pt at 1:100 mm', 0.05);

  step = 'Distance: press, drag, release; under 1 pt ignored';
  await drag(await at(100, 450), await at(160, 450));
  o = await lastObj();
  near(o.measure?.value, 60 * MM, 'dragged distance', 0.05);
  n0 = await objCount();
  await page.mouse.click(...await at(300, 450));
  await page.mouse.click(...await at(300.4, 450));
  check((await objCount()) === n0, 'a distance under 1 pt adds nothing');

  step = 'Area: 4-corner rectangle, Enter';
  await useMeasure('area');
  check((await ev('return app.state.toolStyle.color;')) === '#2e7d32', 'Area colour swapped in');
  n0 = await objCount();
  for (const [x, y] of [[100, 500], [300, 500], [300, 600], [100, 600]]) await page.mouse.click(...await at(x, y));
  await page.keyboard.press('Enter');
  o = await lastObj();
  check((await objCount()) === n0 + 1 && o.type === 'polygon' && o.points.length === 4 && o.measure?.kind === 'area', `area object: ${JSON.stringify(o)}`);
  near(o.measure?.value, 200 * MM * 100 * MM, 'area 200 x 100 pt at 1:100 mm (mm²)', 200 * MM * 100 * MM * 1e-4);

  step = 'Esc mid-polygon adds nothing';
  n0 = await objCount();
  const u2 = await ev('return tab.undo.length;');
  for (const [x, y] of [[350, 500], [450, 500], [450, 600]]) await page.mouse.click(...await at(x, y));
  await page.keyboard.press('Escape');
  check((await objCount()) === n0 && (await ev('return tab.undo.length;')) === u2, 'Esc cancels the polygon');
  check(!(await ev('return v.getOverlaySvg(tab, 0).querySelector(".ann-preview *");')), 'no preview after Esc');

  step = 'Perimeter: 3 clicks, Backspace, 1 click, double-click';
  await useMeasure('perimeter');
  n0 = await objCount();
  for (const [x, y] of [[100, 150], [200, 150], [250, 200]]) await page.mouse.click(...await at(x, y));
  await page.keyboard.press('Backspace');
  await page.mouse.click(...await at(200, 250));
  await page.waitForTimeout(500); // the double-click is a separate gesture on the last vertex
  await page.mouse.dblclick(...await at(200, 250));
  await page.waitForTimeout(100);
  o = await lastObj();
  check((await objCount()) === n0 + 1 && o.type === 'polyline' && o.points.length === 3, `perimeter object: ${JSON.stringify(o)}`);
  near(o.measure?.value, 200 * MM, 'perimeter 100 + 100 pt at 1:100 mm', 0.05);
  await page.mouse.move(...await at(300, 260), { steps: 3 });
  check(!(await ev('return v.getOverlaySvg(tab, 0).querySelector(".ann-preview *");')), 'the double-click started no new measurement');

  step = 'Perimeter: double-click elsewhere adds that vertex once';
  n0 = await objCount();
  await page.mouse.click(...await at(350, 150));
  await page.mouse.dblclick(...await at(450, 150));
  await page.waitForTimeout(100);
  o = await lastObj();
  check((await objCount()) === n0 + 1 && o.points.length === 2, `double-click finish: ${JSON.stringify(o.points)}`);

  step = 'switching the kind cancels a measurement in progress';
  await useMeasure('area');
  n0 = await objCount();
  for (const [x, y] of [[350, 300], [450, 300]]) await page.mouse.click(...await at(x, y));
  await page.mouse.move(...await at(450, 350), { steps: 2 });
  check(await ev('return !!v.getOverlaySvg(tab, 0).querySelector(".ann-preview *");'), 'area in progress');
  await page.click('.opt-measure[data-kind="distance"]');
  check((await getKind()) === 'distance' && (await ev('return app.state.tool;')) === 'measure', 'Distance picked, Measure still active');
  check(!(await ev('return v.getOverlaySvg(tab, 0).querySelector(".ann-preview *");')), 'no preview after the switch');
  check((await objCount()) === n0, 'the switch added nothing');
  check((await ev('return app.state.toolStyle.color;')) === '#d32f2f', 'Distance colour after the switch');

  step = 'Shift snaps a near-horizontal segment flat';
  await useMeasure('distance');
  await page.mouse.click(...await at(100, 300));
  await page.keyboard.down('Shift');
  await page.mouse.click(...await at(200, 306));
  await page.keyboard.up('Shift');
  o = await lastObj();
  check(o.type === 'line' && Math.abs(o.y2 - 300) < 1e-6 && Math.abs(o.y1 - 300) < 1e-6, `Shift: ${JSON.stringify([o.x1, o.y1, o.x2, o.y2])}`);

  step = 'Undo removes the last measurement';
  n0 = await objCount();
  const lastId = o.id;
  await ev('an.undo(tab);');
  check((await objCount()) === n0 - 1 && !(await ev('return tab.objects.some((x) => x.id === arg);', lastId)), 'undo removes it');

  step = 'leaving the tool restores the shared colour';
  await ev('an.select(tab, []); app.setTool("select");');
  check((await ev('return app.state.toolStyle.color;')) === '#123456', `shared colour: ${await ev('return app.state.toolStyle.color;')}`);

  // ---------------------------------------------------------------- object snapping
  const markerAt = () => page.evaluate(() => { const m = document.querySelector('.measure-snap-marker'); if (!m || m.hidden) return null; const r = m.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  const off = async (x, y, dx, dy) => { const [cx, cy] = await at(x, y); return [cx + dx, cy + dy]; };
  // Two clicks at the given screen points (Alt held when `alt`); returns the committed line.
  const distance = async (a, b, alt = false) => {
    const n = await objCount();
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.click(...a);
    await page.mouse.move(b[0], b[1], { steps: 3 });
    await page.mouse.click(...b);
    if (alt) await page.keyboard.up('Alt');
    check((await objCount()) === n + 1, 'one distance added');
    return lastObj();
  };

  step = 'snap: the marker shows on a line end near the pointer';
  await useMeasure('distance');
  await ev('tab.view.scrollEl.scrollTop += 400;'); await frames(); // bring the line (y 692) on screen
  const e1 = await at(100, 692);
  check(e1[1] > 0 && e1[1] < 1000, `line end on screen: ${e1}`);
  await page.mouse.move(...await off(100, 692, 3, -4), { steps: 3 });
  await page.waitForFunction(() => !document.querySelector('.measure-snap-marker')?.hidden, null, { timeout: 5000 }).catch(() => {});
  let m = await markerAt();
  check(m && Math.hypot(m[0] - e1[0], m[1] - e1[1]) < 1, `marker on the end (${e1}): ${m}`);

  step = 'snap: Distance clicks 3-5 px off both ends measure the line exactly';
  o = await distance(await off(100, 692, 3, -4), await off(300, 692, -4, 3));
  for (const [k, want] of [['x1', 100], ['y1', 692], ['x2', 300], ['y2', 692]]) near(o[k], want, `snapped ${k}`, 0.01);
  near(o.measure?.value, 200 * MM, 'snapped distance is exactly 200 pt at 1:100 mm', 1e-6);

  step = 'snap: Alt turns snapping off';
  o = await distance(await off(100, 692, 3, -4), await off(300, 692, -4, 3), true);
  check(Math.abs(o.x1 - 100) > 1 && Math.abs(o.y1 - 692) > 1 && Math.abs(o.x2 - 300) > 1 && Math.abs(o.y2 - 692) > 1, `Alt: not snapped ${JSON.stringify([o.x1, o.y1, o.x2, o.y2])}`);
  check(Math.abs(o.measure.value - 200 * MM) > 0.01, 'Alt: value is not exact');
  await page.keyboard.down('Alt');
  await page.mouse.move(...await off(300, 692, -3, 4), { steps: 2 });
  check(!(await markerAt()), 'no marker while Alt is held');
  await page.keyboard.up('Alt');

  step = 'snap: Esc and a tool change hide the marker';
  await page.mouse.click(...await at(200, 600)); // a measurement in progress, so Esc cancels it and keeps the tool
  await page.mouse.move(...await off(300, 692, -3, -3), { steps: 2 });
  check(await markerAt(), 'marker shown before Esc');
  await page.keyboard.press('Escape');
  check(!(await markerAt()), 'marker hidden after Esc');
  await page.mouse.move(...await off(300, 692, -4, -4), { steps: 2 });
  check(await markerAt(), `marker shown again on move (tool ${await ev('return app.state.tool;')})`);
  await setTool('select');
  check(!(await markerAt()), 'marker hidden after a tool change');

  step = 'snap: /Rotate 90 page with an offset MediaBox';
  const chooser2 = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser2).setFiles({ name: 'rotated.pdf', mimeType: 'application/pdf', buffer: await makeRotatedPdf() });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return a.state.tabs.length === 2 && t?.numPages === 1 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev(`const { scaleFromDrawingScale } = await import('/src/core/measure.js');
    v.setZoom(tab, 1); an.setMeasureScale(tab, 0, scaleFromDrawingScale(100, 'mm'), 'preset');`);
  await frames();
  check(JSON.stringify(await ev('const vp = tab.pages[0].getViewport({ scale: 1 }); return [vp.width, vp.height];')) === '[792,612]', 'rotated page is 792 x 612');
  await useMeasure('distance');
  await page.mouse.move(...await off(150, 50, 4, 3), { steps: 3 });
  await page.waitForFunction(() => !document.querySelector('.measure-snap-marker')?.hidden, null, { timeout: 5000 }).catch(() => {});
  o = await distance(await off(150, 50, 4, 3), await off(150, 350, -3, -5));
  for (const [k, want] of [['x1', 150], ['y1', 50], ['x2', 150], ['y2', 350]]) near(o[k], want, `rotated snapped ${k}`, 0.01);
  await setTool('select');

  if (problems.length) throw new Error(problems.join('\n'));
  console.log('MEASURE OK');
} catch (err) {
  console.error(`FAILED at ${step}: ${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
