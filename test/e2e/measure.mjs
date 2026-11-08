#!/usr/bin/env node
// End-to-end test of measurement objects (renderer/ui/annotations.js, measure-lib.js): distance
// label, live re-measure on handle drag, polygon vertex handles. Prints "MEASURE OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
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
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 1 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
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

  if (problems.length) throw new Error(problems.join('\n'));
  console.log('MEASURE OK');
} catch (err) {
  console.error(`FAILED at ${step}: ${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
