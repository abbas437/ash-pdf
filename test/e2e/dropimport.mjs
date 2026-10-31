#!/usr/bin/env node
// End-to-end test of getting pictures and documents into a PDF (renderer/app.js drop handlers,
// tools-stamp.js placeImages, image-import.js, pagetools.js insertFiles / insertFromFile): pictures
// dropped on a page are placed on it (GIF and SVG converted to PNG, several in one undo step), Shift
// inserts them as pages, a picture dropped on the tab strip opens as a new PDF, a .txt is converted and
// inserted, unsupported and unreadable entries are reported in one toast without costing the rest of the
// drop, Insert from file inserts a picture as a page right after the selected one, sized like the page before it.
// Chromium via playwright-core. Prints "DROPIMPORT OK".
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
const b64 = (buf) => Buffer.from(buf).toString('base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0xff, 0, 0, 0, 0, 0, 0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="blue"/></svg>');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const [three, onePage] = await Promise.all([makePdf(3, 'A'), makePdf(1, 'T')]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, pt = app.pageTools, tabs = app.state.tabs, tab = tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const texts = (k) => ev(`const t = tabs[arg]; const d = await v.pdfjs.getDocument({ data: t.bytes.slice() }).promise; const out = [];
    for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join('').trim());
    await d.loadingTask.destroy(); return out;`, k);
  const settle = (k, n) => page.waitForFunction(([k, n]) => {
    const app = window.ashStudio, t = app.state.tabs[k];
    return t?.numPages === n && (t.id !== app.state.activeId || document.querySelectorAll('.thumb-list .thumb').length === n);
  }, [k, n], { timeout: 10_000 });
  const sizes = (k) => ev(`const t = tabs[arg]; const d = await v.pdfjs.getDocument({ data: t.bytes.slice() }).promise; const out = [];
    for (let i = 1; i <= d.numPages; i++) { const vp = (await d.getPage(i)).getViewport({ scale: 1 }); out.push([Math.round(vp.width), Math.round(vp.height)]); }
    await d.loadingTask.destroy(); return out;`, k);
  const images = () => ev('return app.annotations.list(tab).filter((o) => o.type === "image").map((o) => ({ page: o.page, mime: o.mime, cx: o.x + o.w / 2, cy: o.y + o.h / 2 }));');
  const fileDrag = (arg) => page.evaluate(({ x, y, files, shift = false }) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const file = new File([Uint8Array.from(atob(f.data ?? ''), (c) => c.charCodeAt(0))], f.name, { type: f.type ?? '' });
      if (f.reject) file.arrayBuffer = () => Promise.reject(new DOMException('is a directory', 'NotReadableError')); // like a folder
      dt.items.add(file);
    }
    const el = document.elementFromPoint(x, y);
    const fire = (type) => el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, shiftKey: shift, bubbles: true, cancelable: true }));
    fire('dragenter');
    fire('dragover');
    const hint = document.querySelector('.drop-hint');
    const shown = hint.hidden ? null : hint.textContent;
    fire('drop');
    return shown;
  }, arg);
  const pagePoint = async (i, fy) => {
    await ev('v.scrollToPage(tab, arg); await new Promise((r) => setTimeout(r, 100));', i);
    return page.evaluate(([i, fy]) => {
      const sc = document.querySelector(`.viewer-scroll[data-tab-id="${window.ashStudio.state.activeId}"]`);
      const r = sc.querySelectorAll('.pages > .page')[i].getBoundingClientRect(), s = sc.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: Math.max(s.top + 4, Math.min(s.bottom - 4, r.top + r.height * fy)) };
    }, [i, fy]);
  };
  const toPage = (p) => ev('const h = v.clientToPage(tab, arg.x, arg.y); return { page: h.pageIndex, x: h.x, y: h.y };', p);
  const near = (a, b, msg) => check(Math.abs(a - b) < 2, `${msg}: ${a} vs ${b}`);
  const toastHas = (text) => page.waitForFunction((t) => [...document.querySelectorAll('.toast')].some((n) => n.textContent.includes(t)), text, { timeout: 5000 });
  const png = (name) => ({ name, data: b64(PNG), type: 'image/png' });

  step = 'boot';
  // The browser shim freezes window.api; keep a writable copy so the test can stub openFiles / officeHtmlToPdf.
  await page.addInitScript(() => {
    let api;
    Object.defineProperty(window, 'api', { configurable: true, get: () => api, set: (v) => { api = { ...v }; } });
  });
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await ev('await app.openBytes({ name: "a.pdf", bytes: Uint8Array.from(atob(arg), (c) => c.charCodeAt(0)) });', b64(three));
  await settle(0, 3);

  step = 'a PNG dropped on page 2 is placed there';
  let p = await pagePoint(1, 0.4);
  let at = await toPage(p); // the page point under the pointer at drop time
  eq(await fileDrag({ ...p, files: [png('dot.png')] }), 'Place picture on page 2', 'hint over page 2');
  await page.waitForFunction(() => window.ashStudio.annotations.list(window.ashStudio.state.tabs[0]).length === 1, null, { timeout: 5000 });
  let objs = await images();
  eq(objs.map((o) => [o.page, o.mime]), [[1, 'image/png']], 'one image on page index 1');
  near(objs[0].cx, at.x, 'centred x'); near(objs[0].cy, at.y, 'centred y');
  eq(await ev('return tab.numPages;'), 3, 'no page added');
  await ev('await pt.undoAny(tab);');
  eq((await images()).length, 0, 'undo removes it');

  step = 'GIF and SVG are placed as PNG; one undo removes both';
  await fileDrag({ ...p, files: [{ name: 'one.gif', data: b64(GIF), type: 'image/gif' }, { name: 'box.svg', data: b64(SVG), type: 'image/svg+xml' }] });
  await page.waitForFunction(() => window.ashStudio.annotations.list(window.ashStudio.state.tabs[0]).length === 2, null, { timeout: 5000 });
  objs = await images();
  eq(objs.map((o) => [o.page, o.mime]), [[1, 'image/png'], [1, 'image/png']], 'GIF + SVG as PNG');
  near(objs[1].cx - objs[0].cx, 16, 'staggered x'); near(objs[1].cy - objs[0].cy, 16, 'staggered y');
  await ev('await pt.undoAny(tab);');
  eq((await images()).length, 0, 'one undo removed both');

  step = 'two PNGs: two objects, one undo';
  await fileDrag({ ...p, files: [png('a.png'), png('b.png')] });
  await page.waitForFunction(() => window.ashStudio.annotations.list(window.ashStudio.state.tabs[0]).length === 2, null, { timeout: 5000 });
  await ev('await pt.undoAny(tab);');
  eq((await images()).length, 0, 'one undo removed both PNGs');

  step = 'Shift-drop inserts a page at the line';
  p = await pagePoint(1, 0.75);
  eq(await fileDrag({ ...p, files: [png('page.png')], shift: true }), 'Insert as pages at page 3 (Shift)', 'Shift hint');
  await settle(0, 4);
  eq(await texts(0), ['A 1', 'A 2', '', 'A 3'], 'picture page at the line');
  eq((await images()).length, 0, 'nothing placed');
  await ev('await pt.undoAny(tab);');
  await settle(0, 3);

  step = 'a .txt dropped on the page view is converted and inserted';
  await ev('window.api.officeHtmlToPdf = async (o) => { window.__html = o.html; return Uint8Array.from(atob(arg), (c) => c.charCodeAt(0)); };', b64(onePage));
  p = await pagePoint(0, 0.75);
  eq(await fileDrag({ ...p, files: [{ name: 'notes.txt', data: b64(Buffer.from('a < b\nمرحبا')), type: 'text/plain' }] }), 'Insert at page 2 · drop on the tab bar to open', 'document hint');
  await settle(0, 4);
  eq(await texts(0), ['A 1', 'T 1', 'A 2', 'A 3'], 'text pages at the line');
  check(await ev('return window.__html.includes("a &lt; b") && window.__html.includes("مرحبا");'), 'html from the text');
  await ev('await pt.undoAny(tab);');
  await settle(0, 3);

  step = 'an unsupported file is reported';
  await fileDrag({ ...p, files: [{ name: 'x.zip', data: b64(Buffer.from('PK\x03\x04')), type: 'application/zip' }] });
  await toastHas('Not inserted: x.zip (unsupported type)');
  eq(await ev('return tab.numPages;'), 3, 'nothing inserted');

  step = 'Insert from file with a picture';
  await ev('window.api.openFiles = async () => [{ name: "pic.png", bytes: Uint8Array.from(atob(arg), (c) => c.charCodeAt(0)) }]; tab.currentPage = 0; app.thumbs.setSelection?.([0]); await pt.insertFromFile(tab);', b64(PNG));
  await settle(0, 4);
  eq(await ev('return [tab.bytesUndo.length, tab.numPages];'), [1, 4], 'one undo step, +1 page');
  eq(await texts(0), ['A 1', '', 'A 2', 'A 3'], 'picture page right after the selected page');
  eq((await sizes(0))[1], [612, 792], 'new page the size of the page before it');
  await ev('await pt.undoAny(tab);');
  await settle(0, 3);

  step = 'a PDF is inserted although one entry cannot be read; the skipped entries are named in one toast';
  p = await pagePoint(0, 0.75);
  await fileDrag({ ...p, files: [{ name: 'one.pdf', data: b64(onePage), type: 'application/pdf' }, { name: 'broken.png', type: 'image/png', reject: true }, { name: 'x.zip', data: b64(Buffer.from('PK\x03\x04')), type: 'application/zip' }] });
  await settle(0, 4);
  eq(await texts(0), ['A 1', 'T 1', 'A 2', 'A 3'], 'the PDF pages were inserted');
  await toastHas('Not inserted: broken.png (could not be read), x.zip (unsupported type)');
  await ev('await pt.undoAny(tab);');
  await settle(0, 3);

  step = 'a PNG dropped on the tab strip opens a new PDF';
  p = await page.evaluate(() => { const r = document.querySelector('.doc-tab').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await fileDrag({ ...p, files: [png('photo.png')] });
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 2, null, { timeout: 10_000 });
  await settle(1, 1);
  eq(await ev('return [tabs[1].name, tabs[0].numPages];'), ['photo.pdf', 3], 'new tab');

  step = 'pictures on the tab strip: the unreadable one is skipped and named';
  await fileDrag({ ...p, files: [png('good1.png'), { name: 'bad.png', data: b64(Buffer.from('not a picture')), type: 'image/png' }, png('good2.png')] });
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 3, null, { timeout: 10_000 });
  await settle(2, 2);
  eq(await ev('return tabs[2].name;'), 'good1-images.pdf', 'new tab named after the first picture');
  await toastHas('bad.png (could not be read)');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('DROPIMPORT FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('DROPIMPORT OK');
