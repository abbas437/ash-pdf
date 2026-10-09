#!/usr/bin/env node
// End-to-end test of (1) fitPopover (renderer/ui/dom.js): the Sign menu and a toolbar dropdown stay
// inside a ~1000 px window, and (2) dragMove (renderer/ui/annotations.js): a one-page selection
// released over another page moves there (size kept, one undo restores), released over the gap it is
// clamped inside its page, arrow-key nudges stop at the page edge, and saving a moved annotation
// mirror writes it on the new page only. Playwright-core in Chromium. Prints "SIGMOVE OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';

const sharp = createRequire(import.meta.url)('/opt/npm-tools/node_modules/sharp');
const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

async function makePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]); doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}
const SIG = await sharp({ create: { width: 120, height: 40, channels: 4, background: { r: 26, g: 43, b: 109, alpha: 1 } } }).png().toBuffer();

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
const near = (a, b, msg, tol = 0.5) => check(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} (±${tol})`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const key = async (k) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(k); };
  const objs = () => ev('return tab.objects.map((o) => ({ ...o, bytes: o.bytes ? o.bytes.length : undefined }));');
  const toClient = (i, x, y) => ev('const c = v.pageToClient(tab, arg[0], arg[1], arg[2]); return [c.clientX, c.clientY];', [i, x, y]);
  const drag = async (a, b) => {
    await page.mouse.move(...a); await page.mouse.down();
    await page.mouse.move(b[0], b[1], { steps: 8 }); await page.mouse.up(); await frames();
  };
  // At ~1000 px trailing toolbar buttons live in the "More" panel: open it when the button is inside.
  const reveal = async (sel) => {
    if (await page.$eval(sel, (b) => !!b.closest('.tb-more-panel'))) {
      if (await page.$eval('.tb-more-panel', (m) => m.hidden)) await page.click('.tb-more-btn');
    }
  };
  const inWindow = async (sel, what) => {
    const r = await page.$eval(sel, (m) => { const b = m.getBoundingClientRect(); return { left: b.left, right: b.right, bottom: b.bottom, w: innerWidth, h: innerHeight, hidden: m.hidden }; });
    check(!r.hidden, `${what} is hidden`);
    check(r.left >= 0 && r.right <= r.w && r.bottom <= r.h, `${what} outside the window: ${JSON.stringify(r)}`);
    return r;
  };
  // pdf.js annotations per page of saved bytes.
  const annotsPerPage = (bytes) => ev(`
    const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg) }).promise, out = [];
    for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getAnnotations()).map((a) => a.subtype));
    await d.loadingTask.destroy(); return out;`, Array.from(bytes));
  const readSaved = async () => Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  const open = async (name, buffer) => {
    const fc = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await fc).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction((n) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.name === n && t.numPages === 2 && a.viewer.getOverlaySvg(t, 1); }, name, { timeout: 10_000 });
    await ev('v.setZoom(tab, 0.5);'); await frames();
    await ev('v.scrollToPage(tab, 0);'); await frames();
  };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await open('two.pdf', await makePdf());
  await ev(`await window.api.libraryPut('signature', 'sigA', { meta: { name: 'Ahmad', kind: 'signature', isDefault: true, order: 0 }, bytes: new Uint8Array(arg) });`, [...SIG]);

  step = '(a) dropdowns inside the window';
  await reveal('#btn-sign'); await page.click('#btn-sign');
  await page.waitForSelector('.sign-menu:not([hidden]) .sign-manage');
  await inWindow('.sign-menu', 'Sign menu');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.sign-menu').hidden);
  for (const id of ['btn-pages', 'btn-split']) {
    await reveal(`#${id}`); await page.click(`#${id}`);
    await page.waitForSelector(`#${id} + .tb-dd-menu:not([hidden])`);
    await inWindow(`#${id} + .tb-dd-menu`, `${id} menu`);
    await page.keyboard.press('Escape');
    await page.waitForFunction((i) => document.querySelector(`#${i} + .tb-dd-menu`).hidden, id);
  }

  step = '(b) drag onto page 2';
  await reveal('#btn-sign'); await page.click('#btn-sign');
  await page.waitForSelector('.sign-menu:not([hidden]) .sign-pick');
  await page.click('.sign-pick[data-id="sigA"]');
  await page.waitForFunction(() => document.body.classList.contains('img-armed'));
  await page.mouse.click(...await toClient(0, 400, 500));
  await frames();
  let sigs = (await objs()).filter((o) => o.type === 'image' && o.sig);
  check(sigs.length === 1 && sigs[0].page === 0, `placed: ${JSON.stringify(sigs)}`);
  const orig = sigs[0];
  await ev('an.select(tab, [arg]);', orig.id); await frames();
  const grab = [orig.x + orig.w / 2, orig.y + orig.h / 2];
  const sizes = await ev('return [v.pageSize(tab, 0), v.pageSize(tab, 1)];');
  const target = await toClient(1, 300, 300);
  check((await ev('return v.clientToPage(tab, ...arg);', target)).pageIndex === 1, 'page 2 not under the drop point (viewport too small?)');
  await drag(await toClient(0, ...grab), target);
  sigs = (await objs()).filter((o) => o.type === 'image' && o.sig);
  check(sigs.length === 1 && sigs[0].id === orig.id, `objects after drop: ${JSON.stringify(sigs)}`);
  const moved = sigs[0];
  check(moved.page === 1, `object on page ${moved.page + 1}, expected page 2`);
  near(moved.w, orig.w, 'w unchanged'); near(moved.h, orig.h, 'h unchanged');
  check(moved.x >= 0 && moved.y >= 0 && moved.x + moved.w <= sizes[1].width && moved.y + moved.h <= sizes[1].height, `not inside page 2: ${JSON.stringify(moved)}`);
  near(moved.x + moved.w / 2, 300, 'drop centre x', 2); near(moved.y + moved.h / 2, 300, 'drop centre y', 2);

  step = '(c) undo restores page and position';
  await key('Control+z');
  let o = (await objs()).find((x) => x.id === orig.id);
  check(o && o.page === 0, `after undo page ${o?.page}`);
  near(o.x, orig.x, 'undo x', 0.01); near(o.y, orig.y, 'undo y', 0.01);

  step = '(d) drag into the gap clamps inside page 1';
  await ev('an.select(tab, [arg]);', orig.id); await frames();
  const right = sizes[0].width;
  const cur = await ev('const o = an.getObject ? an.getObject(tab, arg) : tab.objects.find((x) => x.id === arg); return [o.x + o.w / 2, o.y + o.h / 2];', orig.id);
  const start = await toClient(0, ...cur);
  // Pointer ends in the grey gap to the right of page 1 (centre pulled past the edge by ~ half the width).
  const edge = await toClient(0, right + 30, cur[1]);
  const hit = await ev('return v.clientToPage(tab, ...arg);', edge);
  check(!hit.inside, 'drop point is not outside the page');
  await drag(start, edge);
  o = (await objs()).find((x) => x.id === orig.id);
  check(o.page === 0, `gap drop moved it to page ${o.page + 1}`);
  check(o.x >= 0 && o.y >= 0 && o.x + o.w <= right + 1e-6 && o.y + o.h <= sizes[0].height + 1e-6, `not fully inside page 1: ${JSON.stringify(o)}`);
  near(o.x + o.w, right, 'flush with the right edge', 0.01);

  step = '(e) arrow nudges stop at the left edge';
  await ev('an.select(tab, [arg]);', orig.id);
  for (let i = 0; i < 150; i++) await key(i % 2 ? 'Shift+ArrowLeft' : 'ArrowLeft');
  o = (await objs()).find((x) => x.id === orig.id);
  check(o.x >= 0, `x went negative: ${o.x}`);
  near(o.x, 0, 'against the left edge', 0.01);

  step = '(f) saved annotation moves to page 2';
  await ev('tab.objects.length = 0;'); // keep only the shape below in this tab
  await ev('an.add(tab, { type: "rect", page: 0, x: 100, y: 100, w: 120, h: 80, stroke: "#ff0000", fill: "#ffff00" });');
  check(await ev('return await app.saveTab(tab, true);'), 'first saveTab returned false');
  const bytes1 = await readSaved();
  let per = await annotsPerPage(bytes1);
  check(JSON.stringify(per.map((a) => a.length)) === '[1,0]', `fixture annots per page ${JSON.stringify(per)}`);
  await ev('await app.openBytes({ name: "ann.pdf", bytes: new Uint8Array(arg) });', Array.from(bytes1));
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.name === 'ann.pdf' && t.numPages === 2 && t.objects.length === 1 && a.viewer.getOverlaySvg(t, 1); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 0.5);'); await frames();
  await ev('v.scrollToPage(tab, 0);'); await frames();
  const rect = (await objs())[0];
  check(rect.type === 'rect' && rect.page === 0, `reopened mirror ${JSON.stringify(rect)}`);
  await ev('an.select(tab, []); app.setTool?.("select");'); await frames();
  const t2 = await toClient(1, 300, 300);
  check((await ev('return v.clientToPage(tab, ...arg);', t2)).pageIndex === 1, 'page 2 not under the drop point (reopened)');
  await drag(await toClient(0, rect.x + rect.w / 2, rect.y + rect.h / 2), t2);
  const rm = (await objs())[0];
  check(rm.id === rect.id && rm.page === 1, `mirror on page ${rm.page + 1}`);
  check(await ev('return await app.saveTab(tab, true);'), 'second saveTab returned false');
  per = await annotsPerPage(await readSaved());
  check(JSON.stringify(per.map((a) => a.length)) === '[0,1]', `saved annots per page ${JSON.stringify(per)}, expected [0,1]`);

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('SIGMOVE OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
