#!/usr/bin/env node
// End-to-end test of drag-and-drop insertion (renderer/app.js drop handlers, pagetools.js thumbnail
// list): PDF files dropped on the page view / thumbnails of an editable document are inserted there,
// dropped on the tab strip (or a read-only document) they open as tabs; thumbnails dragged onto another
// tab (spring-loaded tab header) are copied into it. Chromium via playwright-core. Prints "DROPINSERT OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf(n, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= n; k++) doc.addPage([612, 792]).drawText(`${label} ${k}`, { x: 72, y: 700, size: 28, font });
  return Buffer.from(await doc.save());
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const [three, two, bee] = await Promise.all([makePdf(3, 'A'), makePdf(2, 'X'), makePdf(2, 'B')]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, pt = app.pageTools, tabs = app.state.tabs, tab = tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const b64 = (buf) => buf.toString('base64');
  // Page texts of tab k (from its bytes, which page operations use).
  const texts = (k) => ev(`const t = tabs[arg]; const d = await v.pdfjs.getDocument({ data: t.bytes.slice() }).promise; const out = [];
    for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join('').trim());
    await d.loadingTask.destroy(); return out;`, k);
  const open = (name, buf) => ev('const bytes = Uint8Array.from(atob(arg.data), (c) => c.charCodeAt(0)); await app.openBytes({ name: arg.name, bytes });', { name, data: b64(buf) });
  // Tab k has n pages and, when active, n thumbnails.
  const settle = (k, n) => page.waitForFunction(([k, n]) => {
    const app = window.ashStudio, t = app.state.tabs[k];
    return t?.numPages === n && (t.id !== app.state.activeId || document.querySelectorAll('.thumb-list .thumb').length === n);
  }, [k, n], { timeout: 10_000 });
  // Dispatch a file drag (dragenter + dragover, then drop unless `drop` is false) at a client point.
  const fileDrag = (arg) => page.evaluate(({ x, y, files, drop = true }) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: 'application/pdf' }));
    const el = document.elementFromPoint(x, y);
    const fire = (type) => el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    fire('dragenter');
    fire('dragover');
    const hint = document.querySelector('.drop-hint'), line = document.querySelector('.drop-insert-line');
    const shown = { hint: hint.hidden ? null : hint.textContent, line: !line.hidden };
    if (drop) fire('drop');
    return shown;
  }, arg);
  const viewPoint = (i, fy) => page.evaluate(([i, fy]) => {
    const sc = document.querySelector(`.viewer-scroll[data-tab-id="${window.ashStudio.state.activeId}"]`);
    const r = sc.querySelectorAll('.pages > .page')[i].getBoundingClientRect(), s = sc.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: Math.max(s.top + 4, Math.min(s.bottom - 4, r.top + r.height * fy)) };
  }, [i, fy]);
  // A point in page i of the active view at fraction fy of its height (scrolled to the page first).
  const pagePoint = async (i, fy) => { await ev('v.scrollToPage(tab, arg); await new Promise((r) => setTimeout(r, 100));', i); return viewPoint(i, fy); };
  const tabPoint = (k) => page.evaluate((k) => {
    const r = document.querySelectorAll('.doc-tab')[k].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, k);
  const thumbAt = (i) => page.locator(`.thumb-list .thumb[data-page-index="${i}"]`).boundingBox();
  // Real pointer drag of thumbnail i of the active tab: press, start the drag, then visit `points`.
  const thumbDrag = async (i, points, release = true) => {
    const a = await thumbAt(i);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 20, { steps: 4 });
    for (const p of points) await (typeof p === 'function' ? p() : page.mouse.move(p.x, p.y, { steps: 4 }));
    if (release) await page.mouse.up();
  };
  // Hold the dragged pointer over tab header k (small moves keep dragover coming) until the tab is active.
  const hoverTab = (k) => async () => {
    const t = await tabPoint(k);
    for (let i = 0; i < 40; i++) {
      await page.mouse.move(t.x + (i % 2), t.y);
      if (await page.evaluate((k) => window.ashStudio.state.activeId === window.ashStudio.state.tabs[k]?.id, k)) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`tab ${k + 1} was not activated by hovering`);
  };
  const hintText = () => page.evaluate(() => { const el = document.querySelector('.drop-hint'); return el.hidden ? null : el.textContent; });
  // Move the dragged pointer to point() (small moves keep dragover coming) until the hint reads `text`.
  const moveUntilHint = (point, text) => async () => {
    const q = await point();
    let got = null;
    for (let i = 0; i < 40 && got !== text; i++) {
      await page.mouse.move(q.x, q.y + (i % 2));
      await page.waitForTimeout(50);
      got = await hintText();
    }
    eq(got, text, 'drop hint');
  };
  const X = [{ name: 'extra.pdf', data: b64(two) }];

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await open('a.pdf', three);
  await settle(0, 3);

  step = 'file dropped on the lower half of page 2 inserts after it';
  let p = await pagePoint(1, 0.75);
  let shown = await fileDrag({ ...p, files: X });
  eq(shown, { hint: 'Insert at page 3 · drop on the tab bar to open', line: true }, 'indicator over page 2 lower half');
  await settle(0, 5);
  eq(await texts(0), ['A 1', 'A 2', 'X 1', 'X 2', 'A 3'], 'pages after the drop');
  eq(await ev('return tabs.length;'), 1, 'no new tab');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Inserted 2 pages from extra.pdf')), null, { timeout: 5000 });
  check(await page.locator('.drop-hint').isHidden() && await page.locator('.drop-insert-line').isHidden(), 'indicator left after the drop');
  eq(await ev('return tab.bytesUndo.length;'), 1, 'one undo step');
  await ev('await pt.undoAny(tab);');
  await settle(0, 3);
  eq(await texts(0), ['A 1', 'A 2', 'A 3'], 'undo restores');

  step = 'upper half inserts before the page';
  p = await pagePoint(1, 0.25);
  shown = await fileDrag({ ...p, files: X });
  eq(shown.hint, 'Insert at page 2 · drop on the tab bar to open', 'hint over page 2 upper half');
  await settle(0, 5);
  eq(await texts(0), ['A 1', 'X 1', 'X 2', 'A 2', 'A 3'], 'pages after an upper-half drop');
  await ev('await pt.undoAny(tab);');
  await settle(0, 3);

  step = 'file dropped on the thumbnail list inserts at the line';
  p = await thumbAt(0);
  shown = await fileDrag({ x: p.x + p.width / 2, y: p.y + p.height * 0.8, files: X });
  eq(shown.hint, 'Insert at page 2 · drop on the tab bar to open', 'hint over thumbnail 1 lower half');
  await settle(0, 5);
  eq(await texts(0), ['A 1', 'X 1', 'X 2', 'A 2', 'A 3'], 'pages after a thumbnail drop');
  check(await page.locator('.thumb-drop-line').count() === 0, 'thumbnail drop line left');
  await ev('await pt.undoAny(tab);');
  await settle(0, 3);

  step = 'Escape hides the indicator';
  p = await pagePoint(0, 0.5);
  await fileDrag({ ...p, files: X, drop: false });
  check(await page.locator('.drop-hint').isVisible(), 'no hint while dragging');
  await page.keyboard.press('Escape');
  check(await page.locator('.drop-hint').isHidden() && await page.locator('.drop-insert-line').isHidden(), 'Escape left the indicator');

  step = 'file dropped on the tab strip opens a new tab';
  p = await tabPoint(0);
  await fileDrag({ ...p, files: X });
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 2, null, { timeout: 10_000 });
  eq(await ev('return [tabs[0].numPages, tabs[1].name, tab === tabs[1]];'), [3, 'extra.pdf', true], 'opened as a tab');
  await ev('tabs[1].dirty = false; await app.closeTab(tabs[1]);');

  step = 'file dropped on a read-only document opens a new tab';
  await ev('tab.readOnly = true;');
  p = await pagePoint(1, 0.75);
  await fileDrag({ ...p, files: X });
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 2, null, { timeout: 10_000 });
  eq(await ev('return [tabs[0].numPages, tabs[1].name];'), [3, 'extra.pdf'], 'read-only: opened as a tab');
  await ev('tabs[1].dirty = false; await app.closeTab(tabs[1]);');
  await settle(0, 3);
  p = await thumbAt(1);
  shown = await fileDrag({ x: p.x + p.width / 2, y: p.y + p.height * 0.8, files: X });
  eq(shown.hint, 'Open in a new tab', 'hint over a read-only thumbnail list');
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 2, null, { timeout: 10_000 });
  eq(await ev('return [tabs[0].numPages, tabs[1].name];'), [3, 'extra.pdf'], 'read-only thumbnails: opened as a tab');
  await ev('tabs[0].readOnly = false; tabs[1].dirty = false; await app.closeTab(tabs[1]);');

  step = 'thumbnail dragged to another tab (spring-loaded) is copied into its thumbnail list';
  await open('b.pdf', bee);
  await settle(1, 2);
  await ev('app.activate(tabs[0].id);');
  await settle(0, 3);
  await thumbDrag(1, [hoverTab(1), () => settle(1, 2),
    moveUntilHint(async () => { const b = await thumbAt(0); return { x: b.x + b.width / 2, y: b.y + b.height * 0.8 }; }, 'Insert copies at page 2')]);
  await settle(1, 3);
  eq(await texts(1), ['B 1', 'A 2', 'B 2'], 'B after the cross-tab drop');
  eq(await texts(0), ['A 1', 'A 2', 'A 3'], 'A unchanged');
  eq(await ev('return tabs[1].bytesUndo.length;'), 1, 'one undo step in the target');
  check(await page.locator('.thumb.dragging').count() === 0 && await page.locator('.drop-hint').isHidden(), 'drag state left');

  step = 'thumbnail dropped on another tab header is appended';
  await ev('app.activate(tabs[0].id);');
  await settle(0, 3);
  await thumbDrag(2, [moveUntilHint(() => tabPoint(1), 'Append 1 page to b.pdf')]);
  await page.waitForFunction(() => window.ashStudio.state.tabs[1].numPages === 4, null, { timeout: 10_000 });
  eq(await texts(1), ['B 1', 'A 2', 'B 2', 'A 3'], 'B after a header drop');
  eq(await texts(0), ['A 1', 'A 2', 'A 3'], 'A unchanged after a header drop');

  step = 'a page copied to another tab keeps its unsaved annotations';
  await ev('app.activate(tabs[0].id);');
  await settle(0, 3);
  await ev('app.annotations.add(tabs[0], { type: "rect", page: 0, x: 40, y: 40, w: 100, h: 60, stroke: "#d0021b", strokeWidth: 2, fill: null });');
  await thumbDrag(0, [moveUntilHint(() => tabPoint(1), 'Append 1 page to b.pdf')]);
  await page.waitForFunction(() => window.ashStudio.state.tabs[1].numPages === 5, null, { timeout: 10_000 });
  eq(await texts(1), ['B 1', 'A 2', 'B 2', 'A 3', 'A 1'], 'B after copying an annotated page');
  eq(await ev('const { readAnnotations } = await import("../src/core/index.js"); return (await readAnnotations(tabs[1].bytes)).objects.map((o) => o.page);'), [4], 'annotation copied with the page');
  await ev('await pt.undoAny(tabs[1]); app.annotations.remove(tabs[0], app.annotations.list(tabs[0]).map((o) => o.id));');
  await settle(1, 4);

  step = 'a file dropped on a dialog backdrop is ignored';
  await ev('app.activate(tabs[0].id);');
  await settle(0, 3);
  await ev('pt.reverseDialog(tab);');
  await page.locator('.dialog-backdrop').waitFor();
  const bd = await page.evaluate(() => { const r = document.querySelector('.dialog').getBoundingClientRect(); return { x: Math.max(4, r.left - 20), y: r.top + 10 }; });
  check(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('dialog-backdrop'), bd), 'backdrop point not on the backdrop');
  shown = await fileDrag({ ...bd, files: X });
  eq(shown, { hint: null, line: false }, 'no insert indicator over a dialog backdrop');
  await page.waitForTimeout(300);
  eq(await ev('return [tabs.length, tabs[0].numPages];'), [2, 3], 'backdrop drop opened or inserted nothing');
  await page.keyboard.press('Escape');
  await page.locator('.dialog-backdrop').waitFor({ state: 'detached' });

  step = 'thumbnail dropped on another tab page view is inserted there';
  await ev('app.activate(tabs[0].id);');
  await settle(0, 3);
  await thumbDrag(0, [hoverTab(1), () => settle(1, 4),
    moveUntilHint(() => viewPoint(0, 0.25), 'Insert copies at page 1')]);
  await settle(1, 5);
  eq(await texts(1), ['A 1', 'B 1', 'A 2', 'B 2', 'A 3'], 'B after a page view drop');
  eq(await texts(0), ['A 1', 'A 2', 'A 3'], 'A unchanged after a page view drop');
  await ev('await pt.undoAny(tabs[1]);');
  await settle(1, 4);

  step = 'Escape cancels a thumbnail drag';
  await ev('app.activate(tabs[0].id);');
  await settle(0, 3);
  await thumbDrag(0, [hoverTab(1), () => settle(1, 4),
    moveUntilHint(() => viewPoint(0, 0.25), 'Insert copies at page 1'), () => page.keyboard.press('Escape')]);
  await page.waitForTimeout(300);
  eq(await ev('return [tabs[0].numPages, tabs[1].numPages];'), [3, 4], 'nothing inserted after Escape');
  check(await page.locator('.drop-hint').isHidden() && await page.locator('.drop-insert-line').isHidden(), 'indicator left after Escape');

  step = 'same-tab drag still reorders';
  await ev('app.activate(tabs[0].id);');
  await settle(0, 3);
  const last = await thumbAt(2);
  await thumbDrag(0, [{ x: last.x + last.width / 2, y: last.y + last.height * 0.8 }]);
  await page.waitForFunction(() => window.ashStudio.state.tabs[0].bytesUndo?.length === 1, null, { timeout: 10_000 });
  await settle(0, 3);
  eq(await texts(0), ['A 2', 'A 3', 'A 1'], 'A after a same-tab move');
  eq(await ev('return tabs.length;'), 2, 'tab count');

  step = 'source pages changed mid-drag';
  const beforeB = await texts(1);
  await page.evaluate(async () => {
    const app = window.ashStudio, [A, B] = app.state.tabs;
    const dt = new DataTransfer();
    const fire = (el, type, x = 0, y = 0) => el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    fire(document.querySelector('.thumb-list .thumb'), 'dragstart');
    await app.pageTools.deletePages(A, [0], { confirm: false });
    const tabEl = document.querySelector(`.doc-tab[data-tab-id="${B.id}"]`), r = tabEl.getBoundingClientRect();
    fire(tabEl, 'dragover', r.left + 5, r.top + 5);
    fire(tabEl, 'drop', r.left + 5, r.top + 5);
    fire(tabEl, 'dragend');
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('changed during the drag')), null, { timeout: 5000 });
  eq(await texts(1), beforeB, 'B unchanged after a drop of stale pages');
  await ev('await pt.undoAny(tabs[0]);');
  await settle(0, 3);

  step = 'source tab closed mid-drag';
  const before = await texts(1);
  await page.evaluate(async () => {
    const app = window.ashStudio, [A, B] = app.state.tabs;
    const dt = new DataTransfer();
    const fire = (el, type, x = 0, y = 0) => el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    fire(document.querySelector('.thumb-list .thumb'), 'dragstart');
    A.dirty = false;
    await app.closeTab(A);
    const tabEl = document.querySelector(`.doc-tab[data-tab-id="${B.id}"]`), r = tabEl.getBoundingClientRect();
    fire(tabEl, 'dragover', r.left + 5, r.top + 5);
    fire(tabEl, 'drop', r.left + 5, r.top + 5);
  });
  await page.waitForTimeout(300);
  eq(await ev('return tabs.length;'), 1, 'one tab left');
  eq(await texts(0), before, 'B unchanged after a drop from a closed tab');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('DROPINSERT FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('DROPINSERT OK');
