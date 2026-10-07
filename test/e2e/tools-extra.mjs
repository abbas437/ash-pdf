#!/usr/bin/env node
// End-to-end test of the Cloud shape (Shapes tool, key O; renderer/ui/tools-shapes.js) in Chromium
// via playwright-core: draws a revision cloud with real mouse events, checks the overlay path,
// saves through app.saveTab and checks the output is a /Square annotation with a cloudy /BE that
// reads back as a cloud. Prints "TOOLS-EXTRA OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { readAnnotations } from '../../src/core/annots.js';
import { PDFDocument, StandardFonts, degrees, PDFName, PDFDict } from 'pdf-lib';

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

  // ------------------------------------------------------------ cloud: key O, drag, overlay
  step = 'cloud draw';
  await key('o');
  await frames();
  check(await ev('return app.state.tool;') === 'shapes', 'O did not select the Shapes tool');
  check(await page.$('.opt-shape[data-shape="cloud"][aria-pressed="true"]'), 'cloud shape button missing or not pressed');
  await drag(await toClient(0, 100, 150), await toClient(0, 260, 250));
  await frames();
  const os = await objs();
  check(os.length === 1 && os[0].type === 'cloud', `expected one cloud, got ${JSON.stringify(os.map((o) => o.type))}`);
  near(os[0].x, 100, 'cloud x'); near(os[0].y, 150, 'cloud y'); near(os[0].w, 160, 'cloud w'); near(os[0].h, 100, 'cloud h');
  const d = await ev('return v.getOverlaySvg(tab, 0).querySelector(`[data-id="${tab.objects[0].id}"] path, path[data-id="${tab.objects[0].id}"]`)?.getAttribute("d") ?? [...v.getOverlaySvg(tab, 0).querySelectorAll("path")].map((p) => p.getAttribute("d")).find((x) => /C/.test(x ?? ""));');
  check(d && (d.match(/C/g) || []).length >= 20, `overlay cloud path missing scallops: ${d}`);

  // ------------------------------------------------------------ save: /Square + /BE, reads back
  step = 'save';
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  const out = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  const doc = await PDFDocument.load(out);
  const annot = doc.getPage(0).node.Annots().lookup(0, PDFDict);
  check(annot.lookup(PDFName.of('Subtype'))?.asString() === '/Square', 'saved cloud is not a /Square');
  check(annot.lookup(PDFName.of('BE'), PDFDict)?.lookup(PDFName.of('S'))?.asString() === '/C', 'saved cloud lacks /BE /S /C');
  const { objects } = await readAnnotations(out);
  check(objects.length === 1 && objects[0].type === 'cloud', `read back: ${JSON.stringify(objects.map((o) => o.type))}`);

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('TOOLS-EXTRA OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
