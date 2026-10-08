#!/usr/bin/env node
// End-to-end test of the Edit image tool (renderer/ui/imgedit.js) in Chromium via playwright-core, with
// the PDFium worker: J selects the tool; hovering outlines an image, a click selects it (8 handles);
// a 100 px drag moves its bbox by 100/scale PDF units and the selection survives the reload; a corner
// drag with Shift keeps the aspect; page Undo restores the original bbox; the Delete key and the
// options-bar Delete button remove images; on a /Rotate 90 page a drag right moves the image right on
// screen. Prints "IMGEDIT OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, degrees } from 'pdf-lib';
import { makeImage } from '../helpers.js';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

/** Page 1: red JPEG at 100..180 x 600..640, blue PNG at 300..380 x 600..640. Page 2 (/Rotate 90): green PNG at 300..380 x 300..340. */
async function makePdf() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, 792]);
  p.drawImage(await doc.embedJpg(makeImage('jpeg', 40, 20, '#ff0000')), { x: 100, y: 600, width: 80, height: 40 });
  p.drawImage(await doc.embedPng(makeImage('png', 40, 20, '#0000ff')), { x: 300, y: 600, width: 80, height: 40 });
  const q = doc.addPage([612, 792]);
  q.setRotation(degrees(90));
  q.drawImage(await doc.embedPng(makeImage('png', 40, 20, '#00a000')), { x: 300, y: 300, width: 80, height: 40 });
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
const near = (a, b, tol, msg) => check(Math.abs(a - b) <= tol, `${msg}: expected ${b} +/- ${tol}, got ${a}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = await makePdf();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const settle = () => page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.pdfDoc && !t.loading; }, null, { timeout: 10_000 }).then(frames);
  const undos = (n) => page.waitForFunction((k) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return (t?.bytesUndo?.length ?? 0) === k; }, n, { timeout: 15_000 }).then(settle);
  /** Images of page i in tab.bytes, each with its page-space box (true /Rotate). */
  const imgs = (i) => ev(`const { pdfium } = await import('/renderer/pdfium/client.js');
    const L = await import('/renderer/ui/imgedit-lib.js');
    const id = await pdfium.open(tab.bytes);
    try {
      const g = { view: tab.pages[arg].view, rotate: tab.pages[arg].rotate };
      return (await pdfium.pageImages(id, arg)).map((m) => ({ ...m, box: L.pdfBoxToPage(g, m.bbox) }));
    } finally { await pdfium.close(id); }`, i);
  const toClient = (i, x, y) => ev('const c = v.pageToClient(tab, arg[0], arg[1], arg[2]); return [c.clientX, c.clientY];', [i, x, y]);
  const centre = (i, b) => toClient(i, b.x + b.w / 2, b.y + b.h / 2);
  const scale = () => ev('return v.scale(tab);');
  const drag = async (a, b) => {
    await page.mouse.move(...a);
    await page.mouse.down();
    await page.mouse.move(b[0], b[1], { steps: 8 });
    await page.mouse.up();
  };
  /** Hover then click the image with box b on page i; waits for the selection outline and handles. */
  const selectAt = async (i, b) => {
    const c = await centre(i, b);
    await page.mouse.move(c[0] - 5, c[1]);
    await page.mouse.move(...c);
    await page.waitForSelector('g.ie-layer rect.ie-hover', { timeout: 10_000 });
    await page.mouse.click(...c);
    await page.waitForSelector('g.ie-layer rect.ie-sel', { timeout: 5_000 });
    check(await page.locator('g.ie-layer rect.ie-handle').count() === 8, 'the selection does not have 8 handles');
    return c;
  };
  const byFilter = (list, f) => list.find((m) => m.filter === f);

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'images.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 2 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await settle();
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('j');
  check(await ev('return app.state.tool;') === 'image-edit', 'J did not select the Edit image tool');
  const orig = await imgs(0);
  check(orig.length === 2, `fixture images: ${orig.length}`);
  const jpeg0 = byFilter(orig, 'DCTDecode');
  check(jpeg0 && byFilter(orig, 'FlateDecode'), `fixture filters: ${orig.map((m) => m.filter)}`);
  const k = await scale();

  step = 'select and move';
  const c = await selectAt(0, jpeg0.box);
  check(await page.locator('.options-bar .ie-delete').count() === 1, 'no Delete button in the options bar');
  await drag(c, [c[0] + 100, c[1]]);
  await undos(1);
  const moved = byFilter(await imgs(0), 'DCTDecode');
  near(moved.bbox[0], jpeg0.bbox[0] + 100 / k, 1, 'moved left edge');
  near(moved.bbox[1], jpeg0.bbox[1], 1, 'moved bottom edge');
  near(moved.bbox[2] - moved.bbox[0], 80, 0.5, 'moved width');
  await page.waitForSelector('g.ie-layer rect.ie-sel', { timeout: 5_000 }); // the selection survived the reload

  step = 'resize with Shift';
  const se = await toClient(0, moved.box.x + moved.box.w, moved.box.y + moved.box.h);
  await page.keyboard.down('Shift');
  await drag(se, [se[0] + 60, se[1] + 5]);
  await page.keyboard.up('Shift');
  await undos(2);
  const big = byFilter(await imgs(0), 'DCTDecode');
  const bw = big.bbox[2] - big.bbox[0], bh = big.bbox[3] - big.bbox[1];
  check(bw > 100, `the resize did not grow the image: ${bw}`);
  near(bw / bh, 2, 0.02, 'aspect after Shift resize');
  near(big.bbox[0], moved.bbox[0], 0.5, 'resize from the se corner moved the left edge');
  near(big.bbox[3], moved.bbox[3], 0.5, 'resize from the se corner moved the top edge');

  step = 'undo';
  await ev('await app.pageTools.undo(tab); await app.pageTools.undo(tab);');
  await undos(0);
  const back = byFilter(await imgs(0), 'DCTDecode');
  check(back.bbox.every((v, j) => Math.abs(v - jpeg0.bbox[j]) <= 0.5), `Undo did not restore the bbox: ${back.bbox} vs ${jpeg0.bbox}`);

  step = 'Esc';
  if (!(await page.locator('g.ie-layer rect.ie-sel').count())) await selectAt(0, back.box);
  await page.keyboard.press('Escape');
  await frames();
  check(await page.locator('g.ie-layer rect.ie-sel').count() === 0, 'Esc did not deselect');
  check(await ev('return app.state.tool;') === 'image-edit', 'Esc with a selection left the tool');

  step = 'delete key';
  await selectAt(0, byFilter(back ? await imgs(0) : orig, 'FlateDecode').box);
  await page.keyboard.press('Delete');
  await undos(1);
  const left = await imgs(0);
  check(left.length === 1 && left[0].filter === 'DCTDecode', `Delete key: ${left.map((m) => m.filter)}`);

  step = 'delete button';
  await selectAt(0, left[0].box);
  await page.click('.options-bar .ie-delete');
  await undos(2);
  check((await imgs(0)).length === 0, 'the Delete button did not remove the image');

  step = 'rotated page';
  await ev('v.scrollToPage(tab, 1);');
  await settle();
  check(await ev('return tab.pages[1].rotate;') === 90, 'fixture page 2 is not rotated');
  const r0 = (await imgs(1))[0];
  const rc = await selectAt(1, r0.box);
  await drag(rc, [rc[0] + 100, rc[1]]);
  await undos(3);
  const r1 = (await imgs(1))[0];
  near(r1.box.x, r0.box.x + 100 / k, 1, 'rotated page: on-screen x after a drag right');
  near(r1.box.y, r0.box.y, 1, 'rotated page: on-screen y after a drag right');

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('IMGEDIT OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
