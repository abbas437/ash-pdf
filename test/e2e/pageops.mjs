#!/usr/bin/env node
// End-to-end test of Reverse / Resize / Interleave (renderer/ui/pagetools.js) through their Tools-menu
// dialogs, in Chromium via playwright-core (same pattern as pagetools.mjs). Prints "PAGEOPS OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf(n, label = 'Page') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= n; k++) doc.addPage([612, 792]).drawText(`${label} ${k}`, { x: 72, y: 700, size: 28, font });
  return Buffer.from(await doc.save());
}
const pageCount = async (buf) => (await PDFDocument.load(buf)).getPageCount();

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
  const [six, backs] = await Promise.all([makePdf(6), makePdf(6, 'Back')]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, bus = app.bus, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const thumbCount = (n) => page.waitForFunction((k) => document.querySelectorAll('.thumb-list .thumb').length === k
    && window.ashStudio.state.tabs.find((t) => t.id === window.ashStudio.state.activeId)?.numPages === k, n, { timeout: 10_000 });
  // Text of every page, extracted from the current tab.bytes with pdf.js.
  const texts = () => ev(`const d = await v.pdfjs.getDocument({ data: tab.bytes.slice() }).promise; const out = [];
    for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join('').trim() || '(blank)');
    await d.loadingTask.destroy(); return out;`);
  const rotations = () => ev('const { getInfo } = await import("../src/core/pdfOps.js"); return (await getInfo(tab.bytes)).pages.map((p) => p.rotation);');
  const lastMap = () => ev('return window.__maps.at(-1).sort((p, q) => p[0] - q[0]);');
  const thumb = (i) => page.locator(`.thumb-list .thumb[data-page-index="${i}"]`);
  const ctxAction = async (i, action) => {
    await thumb(i).click({ button: 'right' });
    await page.waitForSelector('.ctx-menu');
    await page.click(`.ctx-menu [data-pt-action="${action}"]`);
  };
  const snap = () => page.evaluate(() => [window.__maps.length, window.__rebuilt]);
  const done = (s) => page.waitForFunction(([m, r]) => window.__maps.length > m && window.__rebuilt > r, s, { timeout: 10_000 });
  const fresh = async () => {
    // Reset to a clean 6-page document: close all tabs, reopen.
    await ev('for (const t of [...app.state.tabs]) { t.dirty = false; await app.closeTab(t); }');
    const chooser = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await chooser).setFiles({ name: 'six.pdf', mimeType: 'application/pdf', buffer: six });
    await thumbCount(6);
  };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await page.evaluate(() => {
    window.__maps = []; window.__events = [];
    const b = window.ashStudio.bus;
    b.on('pages:remapped', ({ map }) => { window.__maps.push([...map.entries()].map(([o, n]) => [o + 1, n == null ? null : n + 1])); window.__events.push('remapped'); });
    b.on('tab:bytesChanged', () => window.__events.push('bytesChanged'));
    window.__rebuilt = 0; b.on('thumbs:rebuilt', () => { window.__rebuilt++; });
  });
  await fresh();
  const original = await ev('return Array.from(tab.bytes);');

  const menu = async (id) => {
    await page.click('.menu-btn:text-is("Tools")');
    await page.click(`.menu-item[data-id="${id}"]`);
    await page.waitForSelector('.dialog');
  };
  const objPages = () => ev('return tab.objects.map((o) => o.page);');
  const sizes = () => ev('const { getInfo } = await import("../src/core/pdfOps.js"); return (await getInfo(tab.bytes)).pages.map((p) => [Math.round(p.width), Math.round(p.height)]);');
  const undoTo = async (n) => { const sn = await snap(); await ev('await pt.undo(tab);'); await done(sn); await thumbCount(n); };
  const P = (...k) => k.map((i) => `Page ${i}`);

  step = 'annotations on pages 1 and 3';
  await ev(`app.annotations.add(tab, { type: 'rect', page: 0, x: 40, y: 40, w: 100, h: 60, stroke: '#d0021b', strokeWidth: 2, fill: null });
    app.annotations.add(tab, { type: 'rect', page: 2, x: 40, y: 40, w: 100, h: 60, stroke: '#d0021b', strokeWidth: 2, fill: null });`);
  eq(await objPages(), [0, 2], 'annotation pages before');

  step = 'reverse (Tools menu, all pages)';
  let sn = await snap();
  await menu('reverse-pages');
  await page.screenshot({ path: join(OUT, 'pageops-reverse.png') });
  await page.click('.dialog button[data-value="ok"]');
  await done(sn); await thumbCount(6);
  eq(await texts(), P(6, 5, 4, 3, 2, 1), 'texts after reverse');
  eq(await objPages(), [5, 3], 'annotation on page 1 follows its page after Reverse');
  eq(await lastMap(), [[1, 6], [2, 5], [3, 4], [4, 3], [5, 2], [6, 1]], 'reverse map');
  await undoTo(6);
  eq(await texts(), P(1, 2, 3, 4, 5, 6), 'undo restores order');
  eq(await objPages(), [0, 2], 'undo brings the annotations back');

  step = 'reverse selection';
  await ev('app.thumbs.setSelection([1, 2, 3]);');
  sn = await snap();
  await menu('reverse-pages');
  await page.click('.dialog button[data-value="ok"]');
  await done(sn); await thumbCount(6);
  eq(await texts(), P(1, 4, 3, 2, 5, 6), 'texts after reversing pages 2-4');
  eq(await objPages(), [0, 2], 'annotations after reversing 2-4');
  await undoTo(6);

  step = 'resize (A4 landscape, fit, all pages)';
  await ev('app.thumbs.setSelection([]);');
  await menu('resize-pages');
  await page.selectOption('#pt-rs-size', 'custom');
  await page.fill('#pt-rs-w', '0');
  await page.click('.dialog button[data-value="ok"]');
  check((await page.textContent('.pt-error')).includes('Enter a size'), 'invalid custom size not reported inline');
  await page.selectOption('#pt-rs-size', 'A4');
  await page.click('.pt-radio label:text-is("Landscape")');
  await page.click('.pt-radio label:text-is("All pages (6)")');
  await page.screenshot({ path: join(OUT, 'pageops-resize.png') });
  sn = await snap();
  await page.click('.dialog button[data-value="ok"]');
  await done(sn); await thumbCount(6);
  eq(await sizes(), Array(6).fill([842, 595]), 'sizes after resize');
  eq(await texts(), P(1, 2, 3, 4, 5, 6), 'texts kept after resize');
  eq(await lastMap(), [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]], 'resize map is identity');
  await undoTo(6);
  eq(await sizes(), Array(6).fill([612, 792]), 'undo restores sizes');

  step = 'interleave (reverse order option)';
  await menu('interleave-pages');
  await page.click('.dialog button[data-value="ok"]');
  check((await page.textContent('.pt-error')).includes('Choose the PDF'), 'missing file not reported inline');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#pt-il-pick');
  await (await chooser).setFiles({ name: 'backs.pdf', mimeType: 'application/pdf', buffer: backs });
  await page.waitForFunction(() => document.querySelector('#pt-il-file').textContent.includes('6 pages'));
  await page.check('#pt-il-rev');
  await page.screenshot({ path: join(OUT, 'pageops-interleave.png') });
  sn = await snap();
  await page.click('.dialog button[data-value="ok"]');
  await done(sn); await thumbCount(12);
  eq(await texts(), ['Page 1', 'Back 6', 'Page 2', 'Back 5', 'Page 3', 'Back 4', 'Page 4', 'Back 3', 'Page 5', 'Back 2', 'Page 6', 'Back 1'], 'texts after interleave');
  eq(await lastMap(), [[1, 1], [2, 3], [3, 5], [4, 7], [5, 9], [6, 11]], 'interleave map');
  eq(await objPages(), [0, 4], 'annotations after interleave');
  await undoTo(6);
  eq(await texts(), P(1, 2, 3, 4, 5, 6), 'undo after interleave');
  eq(await objPages(), [0, 2], 'annotations after undoing interleave');

  step = 'replace pages 2-3 with Back 4-5 (annotation on page 3 dropped)';
  await menu('replace-pages');
  const chooserR = page.waitForEvent('filechooser');
  await page.click('#pt-rp-pick');
  await (await chooserR).setFiles({ name: 'backs.pdf', mimeType: 'application/pdf', buffer: backs });
  await page.waitForFunction(() => document.querySelector('#pt-rp-file').textContent.includes('6 pages'));
  await page.fill('#pt-rp-pages', '4-5');
  await page.fill('#pt-rp-at', '2');
  await page.click('.dialog button[data-value="ok"]');
  await page.waitForSelector('.dialog button.danger');
  sn = await snap();
  await page.click('.dialog button.danger');
  await done(sn); await thumbCount(6);
  eq(await texts(), ['Page 1', 'Back 4', 'Back 5', 'Page 4', 'Page 5', 'Page 6'], 'texts after replace');
  eq(await objPages(), [0], 'annotation on a replaced page dropped');
  eq(await lastMap(), [[1, 1], [2, null], [3, null], [4, 4], [5, 5], [6, 6]], 'replace map');
  await undoTo(6);
  eq(await texts(), P(1, 2, 3, 4, 5, 6), 'undo after replace');
  eq(await lastMap(), [[1, 1], [2, null], [3, null], [4, 4], [5, 5], [6, 6]], 'undo map');
  eq(await objPages(), [0], 'undo keeps the other annotation on page 1 (unsaved ones on replaced pages go, as with Delete pages)');

  step = 'dark theme dialog';
  await ev('document.documentElement.dataset.theme = "dark";');
  await menu('resize-pages');
  await page.screenshot({ path: join(OUT, 'pageops-resize-dark.png') });
  await page.keyboard.press('Escape');
  await ev('delete document.documentElement.dataset.theme;');

  step = 'read-only tab disables the new tools';
  await ev('tab.readOnly = true;');
  await page.click('.menu-btn:text-is("Tools")');
  for (const id of ['reverse-pages', 'resize-pages', 'interleave-pages', 'replace-pages']) check(await page.locator(`.menu-item[data-id="${id}"]`).isDisabled(), `${id} enabled on a read-only tab`);
  await page.keyboard.press('Escape');
  check(!(await ev('return pt.reverse(tab, [0, 1]);')), 'reverse ran on a read-only tab');
  check(!(await ev('return pt.replaceDialog(tab);')) && !(await page.locator('.dialog').count()), 'replace ran on a read-only tab');
  await ev('tab.readOnly = false;');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('PAGEOPS FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('PAGEOPS OK');
