#!/usr/bin/env node
// End-to-end test of the Callout (C) and Markup + comment (M) tools (renderer/ui/tools-callout.js)
// in Chromium via playwright-core: creates callouts with real mouse events at 100 %, 150 %, view
// rotation 90 and on a /Rotate 90 page, edits them (tip handle, move), runs the dotted markup +
// comment combo (one undo step, tip on the shape edge, blue follow-up chip), saves through
// app.saveTab and checks the output with pdf-lib (dash arrays) and pdf.js (text, dotted pixels).
// Prints "TOOLS-CALLOUT OK" and writes test/e2e/out/tools-callout.png.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { flattenAnnotations } from '../../src/core/annots.js';
import { PDFDocument, StandardFonts, degrees, decodePDFRawStream, PDFArray, PDFName } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= 2; k++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Sheet ${k}`, { x: 400, y: 740, size: 18, font });
    p.drawRectangle({ x: 300, y: 380, width: 90, height: 60, borderColor: undefined, color: undefined, borderWidth: 0 });
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const key = async (k) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(k); };
  const objs = () => ev('return tab.objects.map((o) => ({ ...o }));');
  const toClient = (i, x, y) => ev('const c = v.pageToClient(tab, arg[0], arg[1], arg[2]); return [c.clientX, c.clientY];', [i, x, y]);
  const toPage = (c) => ev('return v.clientToPage(tab, arg[0], arg[1]);', c);
  const drag = async (a, b) => { await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(b[0], b[1], { steps: 6 }); await page.mouse.up(); };
  const type = async (text) => {
    await page.waitForFunction(() => document.activeElement?.classList.contains('callout-editor'), null, { timeout: 3000 });
    await page.keyboard.type(text);
    await page.keyboard.press('Control+Enter');
    await frames();
  };
  const scroll = (i) => ev('v.scrollToPage(tab, arg); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));', i);

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'sheets.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 2 && a.viewer.getOverlaySvg(t, 1); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await frames();
  check(await ev('const b = document.querySelector(\'.tb-tools [data-tool="callout"]\'); return !b.disabled && b.nextElementSibling?.dataset.tool === "markup";'), 'callout/markup toolbar buttons missing or not adjacent');

  // ------------------------------------------------------------ callout geometry, 4 scenarios
  const SCENARIOS = [
    { name: 'zoom 100%', pageIndex: 0, zoom: 1, rot: 0, T: [60, 90], B: [140, 120], text: 'Provide damper access' },
    { name: 'zoom 150%', pageIndex: 0, zoom: 1.5, rot: 0, T: [60, 210], B: [140, 240], text: 'Duct size to suit' },
    { name: 'view rotation 90', pageIndex: 0, zoom: 1, rot: 90, T: [60, 330], B: [140, 360], text: 'Check clearance' },
    { name: '/Rotate 90 page', pageIndex: 1, zoom: 1, rot: 0, T: [60, 90], B: [140, 120], text: 'Rotated sheet note' },
  ];
  const made = {};
  for (const sc of SCENARIOS) {
    step = `callout ${sc.name}`;
    await ev('v.setZoom(tab, arg.zoom); if (tab.viewRotation !== arg.rot) v.rotateView(tab, arg.rot - tab.viewRotation);', sc);
    await scroll(sc.pageIndex);
    // C on the active Callout tool turns it off (back to Select), so press it only when Callout is not active.
    if (await ev('return app.state.tool;') !== 'callout') await key('c');
    check(await ev('return app.state.tool;') === 'callout', 'C did not pick Callout');
    const ca = await toClient(sc.pageIndex, ...sc.T), cb = await toClient(sc.pageIndex, ...sc.B);
    const pa = await toPage(ca), pb = await toPage(cb);
    check(pa?.pageIndex === sc.pageIndex && pb?.pageIndex === sc.pageIndex, `${sc.name}: pointer not over page ${sc.pageIndex}`);
    const n0 = (await objs()).length;
    await drag(ca, cb);
    await type(sc.text);
    const list = await objs();
    check(list.length === n0 + 1, `${sc.name}: expected one new object, got ${list.length - n0}`);
    const o = list[list.length - 1];
    check(o.type === 'callout' && o.page === sc.pageIndex && o.text === sc.text, `${sc.name}: wrong object ${JSON.stringify(o)}`);
    near(o.tx, pa.x, `${sc.name} tip x`); near(o.ty, pa.y, `${sc.name} tip y`);
    near(o.x, pb.x, `${sc.name} box x`); near(o.y, pb.y, `${sc.name} box y`);
    near(o.w, 160, `${sc.name} box width`, 0.01);
    check(o.dash === 'dotted' && o.fill === '#ffffff' && o.fontSize === 10 && o.stroke === '#d62828', `${sc.name}: defaults ${JSON.stringify(o)}`);
    check(o.h >= 10 * 1.2 + 8 - 0.01, `${sc.name}: box height ${o.h} does not fit one line`);
    check(await ev('return !!document.querySelector(`[data-obj-id="${arg}"] .ann-callout-head`) && !!document.querySelector(`[data-obj-id="${arg}"] .ann-callout-box[stroke-dasharray]`);', o.id), `${sc.name}: overlay misses arrowhead or dotted box`);
    made[sc.name] = o;

    if (sc.name === 'zoom 150%') {
      step = 'tip handle';
      await key('v');
      const centre = await toClient(0, o.x + o.w / 2, o.y + o.h / 2);
      await page.mouse.click(...centre);
      check(JSON.stringify(await ev('return an.getSelection(tab);')) === JSON.stringify([o.id]), 'click did not select the callout');
      const t0 = await toClient(0, o.tx, o.ty), t1 = await toClient(0, o.tx + 20, o.ty + 10);
      await drag(t0, t1);
      const o2 = (await objs()).find((x) => x.id === o.id);
      near(o2.tx, o.tx + 20, 'tip handle tx'); near(o2.ty, o.ty + 10, 'tip handle ty');
      for (const k of ['x', 'y', 'w', 'h', 'text']) check(o2[k] === o[k], `tip handle drag changed ${k}: ${o[k]} -> ${o2[k]}`);
      step = 'move';
      const m0 = await toClient(0, o.x + 30, o.y + o.h / 2), m1 = await toClient(0, o.x + 45, o.y + o.h / 2 + 5);
      await drag(m0, m1);
      const o3 = (await objs()).find((x) => x.id === o.id);
      for (const [k, d] of [['x', 15], ['y', 5], ['tx', 15], ['ty', 5]]) near(o3[k], o2[k] + d, `move ${k}`);
      check(o3.w === o2.w && o3.h === o2.h, 'move resized the box');
      await ev('an.select(tab, []);');
    }
  }
  await ev('v.setZoom(tab, 1); if (tab.viewRotation) v.rotateView(tab, -tab.viewRotation);');
  await scroll(0);

  // ------------------------------------------------------------ markup + comment combo
  step = 'markup combo';
  await key('m');
  check(await ev('return app.state.tool;') === 'markup', 'M did not pick Markup');
  check(/follow-up review comments/.test(await ev('return document.querySelector(".options-bar").title;')), 'options bar hint tooltip missing');
  const undo0 = await ev('return tab.undo.length;');
  const n0 = (await objs()).length;
  await drag(await toClient(0, 300, 352), await toClient(0, 390, 412));
  await type('Insulation thickness not shown');
  let list = await objs();
  check(list.length === n0 + 2, `combo added ${list.length - n0} objects`);
  const [sh, co] = list.slice(-2);
  check(sh.type === 'ellipse' && sh.dash === 'dotted' && sh.strokeWidth === 1.5 && sh.fill == null && sh.stroke === '#d62828', `combo shape ${JSON.stringify(sh)}`);
  check(co.type === 'callout' && co.text === 'Insulation thickness not shown' && co.x >= sh.x + sh.w, `combo callout ${JSON.stringify(co)}`);
  const er = ((co.tx - (sh.x + sh.w / 2)) / (sh.w / 2)) ** 2 + ((co.ty - (sh.y + sh.h / 2)) / (sh.h / 2)) ** 2;
  near(er, 1, 'tip on the ellipse edge (normalised radius²)', 0.01);
  check(await ev('return tab.undo.length;') === undo0 + 1, 'combo is not one undo step');
  await ev('an.undo(tab);');
  check((await objs()).length === n0, 'one undo did not remove shape + callout');
  await ev('an.redo(tab);');
  check((await objs()).length === n0 + 2, 'redo did not restore shape + callout');

  step = 'markup cancel';
  await drag(await toClient(0, 60, 500), await toClient(0, 120, 540));
  await page.waitForFunction(() => document.activeElement?.classList.contains('callout-editor'));
  await page.keyboard.press('Escape');
  list = await objs();
  check(list.length === n0 + 3 && list[list.length - 1].type === 'ellipse', 'cancel did not keep only the shape');
  await ev('an.remove(tab, [arg]);', list[list.length - 1].id);

  step = 'blue follow-up';
  await page.click('.options-bar .co-shape[data-shape="rect"]');
  await page.click('.options-bar .co-chip[data-color="#1d4ed8"]');
  await drag(await toClient(0, 480, 470), await toClient(0, 590, 520));
  await type('Rev.01: Still open - show access panel');
  list = await objs();
  const [rs, rc] = list.slice(-2);
  check(rs.type === 'rect' && rs.stroke === '#1d4ed8' && rc.stroke === '#1d4ed8' && rc.color === '#1d4ed8', `blue chip: ${rs.stroke} / ${rc.stroke}`);
  check(rc.x + rc.w <= rs.x && rc.x >= 0, `no room on the right: comment box should sit left of the shape (${rc.x}+${rc.w} vs ${rs.x})`);
  near(rc.tx, rs.x, 'tip on the rectangle left edge', 0.01);
  check(rc.ty >= rs.y && rc.ty <= rs.y + rs.h, 'tip y outside the rectangle edge');
  step = 'options update selection';
  await page.selectOption('.options-bar .co-fill', '#fff9c4');
  check((await objs()).find((x) => x.id === rc.id).fill === '#fff9c4', 'fill option did not update the selected callout');
  await page.selectOption('.options-bar .co-fill', '#ffffff');
  await ev('an.select(tab, []);');
  await key('Escape');

  // Selecting a callout must edit only that callout: the Shapes tool keeps its own fill/line defaults.
  step = 'selection does not leak into Shapes defaults';
  await key('r');
  check(await ev('return app.state.tool;') === 'shapes', 'R did not pick Shapes');
  const STYLE_KEYS = ['fill', 'dash', 'strokeWidth', 'color', 'opacity'];
  const shapeDefaults = await ev('return Object.fromEntries(arg.map((k) => [k, app.state.toolStyle[k]]));', STYLE_KEYS);
  const c100 = made['zoom 100%'];
  check(c100.fill === '#ffffff' && shapeDefaults.fill !== '#ffffff', `fixture: callout fill ${c100.fill} vs Shapes fill ${shapeDefaults.fill}`);
  await key('v');
  await page.mouse.click(...await toClient(0, c100.x + c100.w / 2, c100.y + c100.h / 2));
  check(JSON.stringify(await ev('return an.getSelection(tab);')) === JSON.stringify([c100.id]), 'click did not select the 100% callout');
  await key('r');
  const shapeAfter = await ev('return Object.fromEntries(arg.map((k) => [k, app.state.toolStyle[k]]));', STYLE_KEYS);
  check(JSON.stringify(shapeAfter) === JSON.stringify(shapeDefaults), `Shapes defaults changed by selecting a callout: ${JSON.stringify(shapeDefaults)} -> ${JSON.stringify(shapeAfter)}`);
  check(await ev('return document.querySelector(".options-bar .opt-fill").checked;') === !!shapeDefaults.fill, 'Shapes fill checkbox shows the callout fill');
  check((await objs()).find((x) => x.id === c100.id).fill === '#ffffff', 'switching tools changed the selected callout');
  const nr = (await objs()).length;
  await drag(await toClient(0, 60, 600), await toClient(0, 120, 640));
  const rect = (await objs()).slice(-1)[0];
  check((await objs()).length === nr + 1 && rect.type === 'rect', 'Shapes drag did not add a rectangle');
  check((rect.fill ?? null) === (shapeDefaults.fill ?? null) && rect.dash === shapeDefaults.dash && rect.strokeWidth === shapeDefaults.strokeWidth,
    `new rectangle took the callout's style: ${JSON.stringify(rect)}`);
  await ev('an.remove(tab, [arg]); an.select(tab, []);', rect.id);
  await key('Escape');

  step = 'screenshot';
  await frames();
  const box = await page.locator('.page').first().boundingBox();
  await page.screenshot({ path: join(OUT, 'tools-callout.png'), clip: { x: box.x, y: box.y + 300, width: box.width, height: 420 } });

  // ------------------------------------------------------------ save + output checks
  step = 'save';
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  // Overlay objects are saved as PDF annotations: flatten them so the checks below see what they draw.
  const out = await flattenAnnotations(Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));')));
  const doc = await PDFDocument.load(out);
  check(doc.getPageCount() === 2, `saved page count ${doc.getPageCount()}`);
  const decode = (st) => Buffer.from(decodePDFRawStream(st).decode()).toString('latin1');
  // Page content plus the Form XObjects it draws (flattened annotation appearances), recursively.
  const forms = (res, seen = new Set()) => { const xo = res?.lookup(PDFName.of('XObject')); if (!xo) return [];
    return xo.keys().flatMap((k) => { const st = xo.lookup(k); if (seen.has(st) || st.dict.get(PDFName.of('Subtype'))?.toString() !== '/Form') return [];
      seen.add(st); return [decode(st), ...forms(st.dict.lookup(PDFName.of('Resources')), seen)]; }); };
  const contents = (pg) => { const c = pg.node.Contents(); const refs = c instanceof PDFArray ? c.asArray() : [c];
    return [...refs.map((r) => decode(doc.context.lookup(r))), ...forms(pg.node.Resources())].join('\n'); };
  const cs = contents(doc.getPage(0));
  check(/\[\s*1 2\s*\]\s*0\s+d/.test(cs), 'callout dotted dash array [1 2] missing from page 1 content');
  check(/\[\s*1\.5 3\s*\]\s*0\s+d/.test(cs), 'markup dotted dash array [1.5 3] missing from page 1 content');

  step = 'text + pixels';
  const res = await ev(`
    const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg) }).promise, S = 4, r = { text: [] };
    for (const n of [1, 2]) r.text.push((await (await d.getPage(n)).getTextContent()).items.map((i) => i.str).join(' '));
    const pg = await d.getPage(1), vp = pg.getViewport({ scale: S });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const blue = (x, y) => { const D = ctx.getImageData(Math.round(x * S) - 1, Math.round(y * S) - 1, 3, 3).data;
      for (let k = 0; k < D.length; k += 4) if (D[k + 2] > 150 && D[k] < 110 && D[k + 1] < 150) return true; return false; };
    const runs = []; let prev = null;
    for (let x = 490; x <= 580; x += 0.25) { const b = blue(x, 470); if (b !== prev) runs.push(b); prev = b; }
    r.runs = runs.length; r.blueAny = runs.includes(true);
    await d.loadingTask.destroy(); return r;`, Array.from(out));
  for (const sc of SCENARIOS) check(res.text[sc.pageIndex].includes(sc.text), `page ${sc.pageIndex + 1} text lacks "${sc.text}": ${res.text[sc.pageIndex]}`);
  check(res.text[0].includes('Insulation thickness not shown') && res.text[0].includes('Rev.01: Still open'), 'combo comments missing from page 1 text');
  check(res.blueAny && res.runs >= 20, `markup border is not dotted along its top edge: ${res.runs} blue/blank runs`);

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('TOOLS-CALLOUT OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
