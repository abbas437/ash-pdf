#!/usr/bin/env node
// End-to-end test of the page tools (renderer/ui/pagetools.js) in Chromium via playwright-core,
// served over HTTP with the browser shim (same pattern as run.mjs). Prints "PAGETOOLS OK".
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
  const [six, two] = await Promise.all([makePdf(6), makePdf(2, 'Extra')]);
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

  step = 'rotate (context menu)';
  await ctxAction(1, 'rotate-right');
  await page.waitForFunction(() => window.__events.includes('bytesChanged'));
  await thumbCount(6);
  eq(await rotations(), [0, 90, 0, 0, 0, 0], 'rotations after rotating page 2');
  eq(await page.evaluate(() => window.__events), ['remapped', 'bytesChanged'], 'event order');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; const r = a.viewer.getPageEl(t, 1)?.getBoundingClientRect(); return r && r.width > r.height; });
  eq(await lastMap(), [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]], 'rotate map is identity');
  check(await ev('return tab.dirty;'), 'tab not dirty after rotate');

  step = 'undo restores bytes';
  await page.evaluate(() => window.ashStudio.bus.on('thumbs:rebuilt', ({ tab }) => { window.__thumbsDoc = tab.pdfDoc; }));
  await ev('await pt.undo(tab);');
  await thumbCount(6);
  eq(await ev('return Array.from(tab.bytes);'), original, 'undo did not restore bytes byte-for-byte');
  eq(await ev('return [tab.bytesUndo.length, tab.bytesRedo.length];'), [0, 1], 'undo/redo stack sizes');
  // Let the undo's reload finish before redoing, so the two reloads cannot interleave.
  await page.waitForFunction(() => { const t = window.ashStudio.state.tabs[0]; return t.pages?.[1]?.rotate === 0 && window.__thumbsDoc === t.pdfDoc; }, null, { timeout: 10_000 });
  await ev('await pt.redo(tab);');
  await thumbCount(6);
  eq(await rotations(), [0, 90, 0, 0, 0, 0], 'redo re-applies rotation');

  step = 'thumbnails follow page and view rotation';
  // Orientation ('L'/'P') of [canvas, box, main-view page] for thumbnails 1 and 2, once both
  // have a canvas rendered since the last markOld().
  const shapes = () => page.waitForFunction(() => {
    const o = (w, hh) => (w > hh ? 'L' : 'P');
    const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId);
    const out = [0, 1].map((i) => {
      const el = document.querySelector(`.thumb-list .thumb[data-page-index="${i}"]`);
      const c = el?.querySelector('canvas'), b = el?.querySelector('.thumb-img').getBoundingClientRect();
      const p = a.viewer.getPageEl(t, i).getBoundingClientRect();
      return c && !c.__old ? [o(c.width, c.height), o(b.width, b.height), o(p.width, p.height)] : null;
    });
    return out.every(Boolean) && out;
  }, null, { timeout: 10_000 }).then((hd) => hd.jsonValue());
  // Wait for the thumbnail list to be rebuilt from the redone document (a late rebuild from the
  // undo could otherwise land after the checks below).
  await page.waitForFunction(() => { const t = window.ashStudio.state.tabs[0]; return t.pages?.[1]?.rotate === 90 && window.__thumbsDoc === t.pdfDoc; }, null, { timeout: 10_000 });
  eq(await shapes(), [['P', 'P', 'P'], ['L', 'L', 'L']], 'thumbnails after page-tools rotate (/Rotate 90 on page 2)');
  const markOld = () => page.evaluate(() => { for (const c of document.querySelectorAll('.thumb-list canvas')) c.__old = true; });
  await markOld();
  await ev('v.rotateView(tab, 90);');
  eq(await shapes(), [['L', 'L', 'L'], ['P', 'P', 'P']], 'thumbnails re-rendered after view rotation 90');
  await markOld();
  await ev('v.rotateView(tab, -90);');
  eq(await shapes(), [['P', 'P', 'P'], ['L', 'L', 'L']], 'thumbnails re-rendered after view rotation back');
  await fresh();

  step = 'delete 3-4 (context menu + confirm)';
  await thumb(2).click();
  await thumb(3).click({ modifiers: ['Shift'] });
  await ctxAction(3, 'delete');
  await page.waitForSelector('.dialog');
  await page.click('.dialog button[data-value="ok"]');
  await thumbCount(4);
  eq(await lastMap(), [[1, 1], [2, 2], [3, null], [4, null], [5, 3], [6, 4]], 'delete map');
  eq(await texts(), ['Page 1', 'Page 2', 'Page 5', 'Page 6'], 'texts after delete');

  step = 'refuse delete-all';
  await thumb(0).click();
  await page.keyboard.press('Control+a');
  eq(await ev('return [...app.thumbs.selection].sort();'), [0, 1, 2, 3], 'Ctrl+A selection');
  await page.keyboard.press('Delete');
  await page.waitForSelector('.dialog');
  check((await page.textContent('.dialog-title')).includes('Cannot delete'), 'no refusal dialog for delete-all');
  await page.click('.dialog button[data-value="ok"]');
  check((await ev('return tab.numPages;')) === 4, 'delete-all changed the document');

  step = 'insert blank + move + keyboard rotate';
  await thumb(0).click();
  let sn = await snap();
  await ctxAction(0, 'insert-after');
  await done(sn);
  await thumbCount(5);
  eq(await texts(), ['Page 1', '(blank)', 'Page 2', 'Page 5', 'Page 6'], 'texts after insert blank');
  eq(await lastMap(), [[1, 1], [2, 3], [3, 4], [4, 5]], 'insert map');
  await thumb(1).click();
  sn = await snap();
  await ctxAction(1, 'move-end');
  await done(sn);
  eq(await texts(), ['Page 1', 'Page 2', 'Page 5', 'Page 6', '(blank)'], 'texts after move to end');
  await thumb(2).click();
  sn = await snap();
  await ctxAction(2, 'move-up');
  await done(sn);
  eq(await texts(), ['Page 1', 'Page 5', 'Page 2', 'Page 6', '(blank)'], 'texts after move up');
  await thumb(0).click();
  sn = await snap();
  await page.keyboard.press(']');
  await done(sn);
  eq((await rotations())[0], 90, 'keyboard ] rotation');

  step = 'drag reorder';
  await fresh();
  const ctxShot = async () => {
    await thumb(2).click({ button: 'right' });
    await page.waitForSelector('.ctx-menu');
    await page.screenshot({ path: join(OUT, 'pagetools-context.png') });
    await page.keyboard.press('Escape');
    check(await page.locator('.ctx-menu').count() === 0, 'Escape did not close the context menu');
  };
  await ctxShot();
  await thumb(0).click();
  sn = await snap();
  if (process.env.PT_DEBUG) await page.evaluate(() => { window.__dbg = []; for (const t of ['dragstart', 'dragover', 'drop', 'dragend']) document.addEventListener(t, () => window.__dbg.push(t), true); });
  const a = await thumb(0).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 20, { steps: 4 });
  // Hold the pointer in the panel's bottom auto-scroll zone until the last thumbnail is in
  // view, then drop on the lower half of the last thumbnail (= after it).
  const panel = await page.locator('.sb-panel[data-sb-panel="thumbs"]').boundingBox();
  const x = a.x + a.width / 2;
  for (let k = 0; k < 200; k++) {
    await page.mouse.move(x, panel.y + panel.height - 10 - (k % 2));
    const last = await thumb(5).boundingBox();
    if (last.y + last.height < panel.y + panel.height - 40) break;
  }
  const last = await thumb(5).boundingBox();
  await page.mouse.move(x, last.y + last.height * 0.8, { steps: 3 });
  await page.mouse.up();
  if (process.env.PT_DEBUG) console.log(await page.evaluate(() => [window.__dbg, document.querySelector('.thumb').draggable, window.__maps.length]));
  await done(sn);
  await thumbCount(6);
  eq(await texts(), ['Page 2', 'Page 3', 'Page 4', 'Page 5', 'Page 6', 'Page 1'], 'texts after dragging page 1 to the end');
  eq(await lastMap(), [[1, 6], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5]], 'drag map');

  step = 'merge dialog';
  await fresh();
  await page.click('.menu-btn:text-is("File")');
  await page.click('.menu-item[data-id="merge"]');
  await page.waitForSelector('.pt-merge');
  await page.click('.dialog button[data-value="ok"]');
  check(await page.locator('.pt-error:not([hidden])').count() === 1, 'no inline error for an empty merge');
  let chooser = page.waitForEvent('filechooser');
  await page.click('#pt-merge-add');
  await (await chooser).setFiles([{ name: 'extra-a.pdf', mimeType: 'application/pdf', buffer: two }, { name: 'extra-b.pdf', mimeType: 'application/pdf', buffer: two }]);
  await page.waitForFunction(() => document.querySelectorAll('.pt-filelist li:not(.pt-empty)').length === 2);
  await page.click('.pt-radio label:text-is("Insert after page")');
  await page.fill('#pt-merge-after', '2');
  await page.screenshot({ path: join(OUT, 'pagetools-merge.png') });
  await page.click('.dialog button[data-value="ok"]');
  await thumbCount(10);
  eq(await texts(), ['Page 1', 'Page 2', 'Extra 1', 'Extra 2', 'Extra 1', 'Extra 2', 'Page 3', 'Page 4', 'Page 5', 'Page 6'], 'texts after merge');
  eq(await lastMap(), [[1, 1], [2, 2], [3, 7], [4, 8], [5, 9], [6, 10]], 'merge map');

  step = 'split dialog';
  await fresh();
  await ev('pt.splitDialog(tab);');
  await page.waitForSelector('#pt-split-ranges');
  await page.fill('#pt-split-ranges', '1-3,9');
  await page.click('.dialog button[data-value="ok"]');
  check((await page.textContent('.pt-error')).includes('"9"'), 'invalid split range not reported inline');
  await page.fill('#pt-split-ranges', '1-3,5,6-');
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.click('.dialog button[data-value="ok"]');
  await page.waitForFunction(() => true);
  for (let k = 0; k < 50 && downloads.length < 3; k++) await page.waitForTimeout(100);
  eq(downloads.map((d) => d.suggestedFilename()), ['six-part-1.pdf', 'six-part-2.pdf', 'six-part-3.pdf'], 'split file names');
  const counts = [];
  for (const d of downloads) counts.push(await pageCount(await readFile(await d.path())));
  eq(counts, [3, 1, 1], 'split page counts');

  step = 'crop';
  await ev('app.thumbs.setSelection([]); tab.currentPage = 0; pt.cropDialog(tab);');
  await page.waitForSelector('#pt-crop-top');
  await page.selectOption('#pt-crop-unit', 'pt');
  await page.fill('#pt-crop-top', '10');
  await page.fill('#pt-crop-left', '700');
  await page.click('.dialog button[data-value="ok"]');
  check((await page.textContent('.pt-error')).includes('larger than page'), 'oversized crop not reported inline');
  await page.fill('#pt-crop-left', '12');
  await page.click('.pt-radio label:text-is("All pages (6)")');
  await page.click('.dialog button[data-value="ok"]');
  await page.waitForFunction(() => window.__maps.length >= 1 && document.querySelectorAll('.dialog').length === 0);
  await page.waitForFunction(() => window.ashStudio.state.tabs[0].bytesUndo?.length === 1);
  const sizes = await ev('const { getInfo } = await import("../src/core/pdfOps.js"); return (await getInfo(tab.bytes)).pages.map((p) => [p.width, p.height]);');
  eq(sizes[0], [600, 782], 'cropped visible size'); eq(sizes[5], [600, 782], 'cropped visible size of last page');

  step = 'properties';
  await ev('pt.propertiesDialog(tab);');
  await page.waitForSelector('#pt-meta-title');
  await page.fill('#pt-meta-title', 'Ductwork review');
  await page.click('.dialog button[data-value="ok"]');
  await page.waitForFunction(() => window.ashStudio.state.tabs[0].bytesUndo?.length === 2);
  eq(await ev('const { getMetadata } = await import("../src/core/pdfOps.js"); return (await getMetadata(tab.bytes)).title;'), 'Ductwork review', 'title metadata');

  step = 'insert pages from PDF';
  await ev('pt.insertFromDialog(tab);');
  await page.waitForSelector('#pt-ins-pick');
  chooser = page.waitForEvent('filechooser');
  await page.click('#pt-ins-pick');
  await (await chooser).setFiles({ name: 'extra.pdf', mimeType: 'application/pdf', buffer: two });
  await page.waitForFunction(() => document.querySelector('#pt-ins-file').textContent.includes('2 pages'));
  await page.fill('#pt-ins-pages', '2');
  await page.fill('#pt-ins-after', '0');
  await page.click('.dialog button[data-value="ok"]');
  await thumbCount(7);
  eq((await texts()).slice(0, 2), ['Extra 2', 'Page 1'], 'insert from PDF at start');

  step = 'pages:remapped keeps an annotation-like spy consistent';
  // A consumer that keeps objects by page index must be able to follow any op via the map.
  await ev(`window.__objs = [{ page: 0, id: 'a' }, { page: 3, id: 'b' }, { page: 6, id: 'c' }];
    bus.on('pages:remapped', ({ map }) => { window.__objs = window.__objs.flatMap((o) => map.get(o.page) == null ? [] : [{ ...o, page: map.get(o.page) }]); });
    await pt.deletePages(tab, [3], { confirm: false });`);
  await thumbCount(6);
  eq(await page.evaluate(() => window.__objs), [{ page: 0, id: 'a' }, { page: 5, id: 'c' }], 'spy objects after delete');

  step = 'images to PDF';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAh9AMBnGWk6wAAAABJRU5ErkJggg==', 'base64');
  await page.click('.menu-btn:text-is("File")');
  await page.click('.menu-item[data-id="images-to-pdf"]');
  chooser = page.waitForEvent('filechooser');
  await page.click('#pt-img-add');
  await (await chooser).setFiles([{ name: 'a.png', mimeType: 'image/png', buffer: png }, { name: 'b.png', mimeType: 'image/png', buffer: png }]);
  await page.waitForFunction(() => document.querySelectorAll('.pt-filelist li:not(.pt-empty)').length === 2);
  await page.selectOption('#pt-img-size', 'A4');
  await page.click('.dialog button[data-value="ok"]');
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 2 && window.ashStudio.state.tabs[1].numPages === 2);
  eq(await ev('return [tab.name, Math.round(v.pageSize(tab, 0).width)];'), ['a-images.pdf', 595], 'images tab');

  step = 'read-only tab disables page tools';
  await ev('tab.readOnly = true;');
  await page.click('.menu-btn:text-is("Tools")');
  check(await page.locator('.menu-item[data-id="crop"]').isDisabled(), 'Crop enabled on a read-only tab');
  check((await page.getAttribute('.menu-item[data-id="crop"]', 'title')).includes('Encrypted'), 'no read-only tooltip');
  await page.keyboard.press('Escape');
  await thumb(0).click({ button: 'right' });
  check(await page.locator('.ctx-menu [data-pt-action="rotate-left"]').isDisabled(), 'context rotate enabled on read-only');
  await page.keyboard.press('Escape');

  step = 'core errors are shown';
  await ev('tab.readOnly = false; tab.bytes = new Uint8Array([1, 2, 3]); pt.rotate(tab, [0], 90);');
  await page.waitForSelector('.dialog.error');
  await page.click('.dialog.error button');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('PAGETOOLS FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('PAGETOOLS OK');
