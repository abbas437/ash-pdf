#!/usr/bin/env node
// End-to-end test of the Text tool (renderer/ui/tools-text.js) in Chromium via playwright-core:
// drags text boxes and types with the real keyboard at 100 %, 150 %, view rotation 90 and on a
// /Rotate 90 page, checks the editor box and glyph baseline against the overlay, commit/cancel,
// re-edit, styling, wrapping, "Replace text…", the WinAnsi warning, then saves through
// app.saveTab and finds the text with pdf-lib / pdf.js. Prints "TOOLS-TEXT OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= 3; k++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${k}`, { x: 360, y: 700, size: 20, font });
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
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]|\[text\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, bus = app.bus, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const key = async (k) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(k); };
  const objs = () => ev('return tab.objects.map((o) => ({ ...o }));');
  const texts = async () => (await objs()).filter((o) => o.type === 'text');
  const toClient = (i, x, y) => ev('const c = v.pageToClient(tab, arg[0], arg[1], arg[2]); return [c.clientX, c.clientY];', [i, x, y]);
  const toPage = (c) => ev('return v.clientToPage(tab, arg[0], arg[1]);', c);
  const drag = async (pts) => {
    await page.mouse.move(...pts[0]);
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1], { steps: 5 });
    await page.mouse.up();
  };
  const editorRect = () => ev('const t = document.querySelector("textarea.text-editor"); if (!t) return null; const r = t.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, focused: document.activeElement === t, value: t.value, sh: t.scrollHeight, ch: t.clientHeight };');
  /** Client bounding box of a page-space box (any view rotation). */
  const boxClient = async (i, b) => {
    const c = [await toClient(i, b.x, b.y), await toClient(i, b.x + b.w, b.y), await toClient(i, b.x, b.y + b.h), await toClient(i, b.x + b.w, b.y + b.h)];
    return { l: Math.min(...c.map((p) => p[0])), t: Math.min(...c.map((p) => p[1])), r: Math.max(...c.map((p) => p[0])), b: Math.max(...c.map((p) => p[1])) };
  };
  const sameRect = (a, b, msg, tol = 1.5) => { for (const k of ['l', 't', 'r', 'b']) near(a[k], b[k], `${msg} ${k}`, tol); };
  const measure = (text, o) => ev('const core = await import("/src/core/index.js"); return core.measureText(arg[0], { font: arg[1].font, bold: arg[1].bold, italic: arg[1].italic, fontSize: arg[1].fontSize, maxWidth: arg[1].w, lineHeight: arg[1].lineHeight });', [text, o]);
  const tspans = (id) => ev('const g = v.getOverlaySvg(tab, arg[0]).querySelector(`[data-obj-id="${arg[1]}"]`); return g ? [...g.querySelectorAll("tspan")].map((t) => ({ x: +t.getAttribute("x"), y: +t.getAttribute("y"), s: t.textContent })) : null;', id);
  /** Lowest screen row (client px, fractional by device pixels) holding dark ink inside clip. */
  const inkBottom = async (clip) => {
    const png = await page.screenshot({ clip });
    return ev(`
      const img = await createImageBitmap(new Blob([Uint8Array.from(atob(arg.b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const c = new OffscreenCanvas(img.width, img.height), ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const D = ctx.getImageData(0, 0, img.width, img.height).data;
      for (let y = img.height - 1; y >= 0; y--) for (let x = 0; x < img.width; x++) { const k = (y * img.width + x) * 4; if (D[k + 1] < 110 && D[k + 2] < 110) return arg.top + (y + 1) * arg.h / img.height; }
      return null;`, { b64: png.toString('base64'), top: clip.y, h: clip.height });
  };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'three.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 3 && a.viewer.getOverlaySvg(t, 1); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await frames();

  // ------------------------------------------------------------ drag + type, 4 geometries
  const SCENARIOS = [
    { name: 'zoom 100%', pageIndex: 0, zoom: 1, rot: 0, a: [60, 140], b: [260, 170] },
    { name: 'zoom 150%', pageIndex: 0, zoom: 1.5, rot: 0, a: [70, 220], b: [300, 236] },
    { name: 'view rotation 90', pageIndex: 0, zoom: 1, rot: 90, a: [300, 330], b: [80, 300] },
    { name: '/Rotate 90 page', pageIndex: 1, zoom: 1, rot: 0, a: [100, 120], b: [320, 150] },
  ];
  const created = [];
  for (const sc of SCENARIOS) {
    step = `type (${sc.name})`;
    await ev('v.setZoom(tab, arg.zoom); if (tab.viewRotation !== arg.rot) v.rotateView(tab, arg.rot - tab.viewRotation); v.scrollToPage(tab, arg.pageIndex);', sc);
    await frames();
    await key('Escape');
    await key('t');
    check(await ev('return app.state.tool;') === 'text', 'T did not pick the Text tool');
    await frames(); // options bar height
    const ca = await toClient(sc.pageIndex, ...sc.a), cb = await toClient(sc.pageIndex, ...sc.b);
    const n0 = (await texts()).length;
    await drag([ca, cb]);
    const er = await editorRect();
    check(er?.focused, `${sc.name}: editor not open/focused after the drag`);
    const typed = `Text ${sc.name}`;
    await page.keyboard.type(typed);
    const er2 = await editorRect();
    check(er2.value === typed, `${sc.name}: editor value "${er2.value}"`);
    await page.keyboard.press('Control+Enter');
    check(!(await editorRect()), `${sc.name}: Ctrl+Enter did not close the editor`);
    const list = await texts();
    check(list.length === n0 + 1, `${sc.name}: text count ${list.length}`);
    const o = list.at(-1);
    const A = await toPage(ca), B = await toPage(cb);
    check(o.page === sc.pageIndex && o.text === typed, `${sc.name}: page/text ${o.page}/${o.text}`);
    near(o.x, Math.min(A.x, B.x), `${sc.name} x`); near(o.y, Math.min(A.y, B.y), `${sc.name} y`); near(o.w, Math.abs(B.x - A.x), `${sc.name} w`);
    near(o.h, 12 * 1.2, `${sc.name} h fits one line`, 1e-6);
    sameRect(er2, await boxClient(sc.pageIndex, o), `${sc.name}: editor box vs object box`);
    const ts = await tspans([sc.pageIndex, o.id]);
    const m = await measure(o.text, o);
    check(ts?.length === 1 && ts[0].s === typed, `${sc.name}: SVG text ${JSON.stringify(ts)}`);
    near(ts[0].y, o.y + m.firstBaseline, `${sc.name}: SVG baseline`, 1e-3);
    check(JSON.stringify(await ev('return an.getSelection(tab);')) === JSON.stringify([o.id]), `${sc.name}: new text not selected`);
    created.push(o);
  }
  await ev('v.setZoom(tab, 1); if (tab.viewRotation) v.rotateView(tab, -tab.viewRotation); v.scrollToPage(tab, 0);');
  await frames();

  // ------------------------------------------------------------ plain click, Esc cancel
  step = 'plain click';
  await key('Escape');
  await key('t');
  await frames();
  await page.mouse.click(...await toClient(0, 60, 400));
  check((await editorRect())?.focused, 'click did not open the editor');
  await page.keyboard.type('Clicked');
  // A click elsewhere commits (and does not start a new box).
  await page.mouse.click(...await toClient(0, 500, 600));
  let n = (await texts()).length;
  check(!(await editorRect()), 'click outside did not commit');
  const clicked = (await texts()).at(-1);
  check(clicked.text === 'Clicked', 'click-outside commit text');
  near(clicked.w, 200, 'plain click width', 1e-6); near(clicked.x, 60, 'plain click x'); near(clicked.y, 400, 'plain click y');

  step = 'Esc cancels';
  await drag([await toClient(0, 60, 450), await toClient(0, 200, 470)]);
  check((await editorRect())?.focused, 'editor not open');
  await page.keyboard.type('discard me');
  await page.keyboard.press('Escape');
  check(!(await editorRect()) && (await texts()).length === n, 'Esc did not cancel');
  check(await ev('return app.state.tool;') === 'text', 'Esc in the editor left the Text tool');

  // ------------------------------------------------------------ baseline: editor glyphs vs SVG
  step = 'baseline';
  await key('Escape');
  await key('t');
  await frames();
  await page.$eval('.opt-font', (el) => { el.value = '36'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  for (const font of ['Helvetica', 'Times', 'Courier']) {
    await page.selectOption('.opt-text-font', font);
    const bx = { x: 320, y: 300 + 60 * ['Helvetica', 'Times', 'Courier'].indexOf(font), w: 200 };
    await drag([await toClient(0, bx.x, bx.y), await toClient(0, bx.x + bx.w, bx.y + 10)]);
    await page.keyboard.type('HHH');
    const r = await editorRect();
    const clip = { x: r.l + 2, y: r.t + 1, width: 60, height: r.b - r.t - 2 };
    const inEditor = await inkBottom(clip);
    await page.keyboard.press('Control+Enter');
    await key('Escape'); // drop the selection frame
    await frames();
    const ob = await boxClient(0, (await texts()).at(-1));
    const inSvg = await inkBottom({ x: ob.l + 2, y: ob.t + 1, width: 60, height: clip.height }) - ob.t + r.t;
    const scale = await ev('return v.scale(tab);');
    check(inEditor != null && inSvg != null, `${font}: no ink found ${inEditor} ${inSvg} ${JSON.stringify(clip)}`);
    const offPt = (inEditor - inSvg) / scale;
    console.log(`baseline ${font} 36pt: editor - svg = ${offPt.toFixed(2)} pt`);
    check(Math.abs(offPt) <= 1.5, `${font}: editor baseline is ${offPt.toFixed(2)} pt off the SVG/PDF baseline`);
    await key('t');
  }
  await page.$eval('.opt-font', (el) => { el.value = '12'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.selectOption('.opt-text-font', 'Helvetica');

  // ------------------------------------------------------------ wrapping
  step = 'wrapping';
  const long = 'The quick brown fox jumps over the lazy dog and keeps running across the page';
  await drag([await toClient(0, 60, 500), await toClient(0, 180, 510)]);
  await page.keyboard.type(long);
  const ew = await editorRect();
  check(ew.sh <= ew.ch + 1, `editor wraps into more lines than measureText (scrollHeight ${ew.sh} > ${ew.ch})`);
  await page.keyboard.press('Control+Enter');
  const wrapped = (await texts()).at(-1);
  const mw = await measure(long, wrapped);
  const tw = await tspans([0, wrapped.id]);
  check(mw.lines.length >= 4 && tw.length === mw.lines.length, `wrapped lines: svg ${tw.length}, measureText ${mw.lines.length}`);
  check(tw.map((t) => t.s).join('|') === mw.lines.join('|'), 'wrapped line text differs');
  near(wrapped.h, mw.height, 'wrapped height', 1e-6);
  sameRect(ew, await boxClient(0, wrapped), 'wrapped editor box');

  // ------------------------------------------------------------ select + style
  step = 'style';
  await key('Escape');
  await key('v');
  const target = created[0];
  await page.mouse.click(...await toClient(0, target.x + 5, target.y + target.h / 2));
  check(JSON.stringify(await ev('return an.getSelection(tab);')) === JSON.stringify([target.id]), 'click did not select the text');
  await frames();
  check(await page.$('.opt-text-font') && await page.$('.opt-text-bold') && !(await page.$('.opt-dash')), 'options bar does not show the text controls');
  await page.selectOption('.opt-text-font', 'Times');
  await page.$eval('.opt-font', (el) => { el.value = '18'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('.opt-text-bold');
  await page.$eval('.opt-color', (el) => { el.value = '#ff0000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  let t1 = (await objs()).find((o) => o.id === target.id);
  check(t1.font === 'Times' && t1.fontSize === 18 && t1.bold === true && t1.color === '#ff0000', `style patch ${JSON.stringify(t1)}`);
  near(t1.h, 18 * 1.2, 'restyled height', 1e-6);
  near(t1.x, target.x, 'restyle keeps x', 1e-6); near(t1.w, target.w, 'restyle keeps w', 1e-6);
  const st = await ev('const t = v.getOverlaySvg(tab, 0).querySelector(`[data-obj-id="${arg}"] text`); return [t.getAttribute("font-family"), t.getAttribute("font-size"), t.getAttribute("font-weight"), t.getAttribute("fill")];', target.id);
  check(/Times/.test(st[0]) && st[1] === '18' && st[2] === 'bold' && st[3] === '#ff0000', `rendered style ${st}`);
  check(JSON.stringify(await ev('return an.getSelection(tab);')) === JSON.stringify([target.id]), 'style change lost the selection');
  // Handles: only w / e.
  check(JSON.stringify(await ev('return [...v.getOverlaySvg(tab, 0).querySelectorAll("[data-handle]")].map((h) => h.dataset.handle).sort();')) === '["e","w"]', 'text handles are not w/e only');

  // ------------------------------------------------------------ double-click re-edit
  step = 're-edit';
  await page.mouse.dblclick(...await toClient(0, t1.x + 5, t1.y + t1.h / 2));
  let er = await editorRect();
  check(er?.focused && er.value === t1.text, `dblclick did not open the editor on "${t1.text}": ${JSON.stringify(er)}`);
  check((await tspans([0, t1.id]))?.length === 0, 'object still drawn under the editor');
  sameRect(er, await boxClient(0, t1), 're-edit editor box');
  await page.keyboard.press('End');
  await page.keyboard.type(' more');
  await page.keyboard.press('Control+Enter');
  t1 = (await objs()).find((o) => o.id === target.id);
  check(t1.text === `${target.text} more` && t1.font === 'Times', `re-edit result ${t1.text}`);
  check((await tspans([0, t1.id])).length >= 1, 're-edited object not drawn');
  await key('Control+z');
  check((await objs()).find((o) => o.id === target.id).text === target.text, 'undo re-edit');
  await key('Control+y');

  step = 'empty edit deletes';
  await page.mouse.dblclick(...await toClient(0, clicked.x + 5, clicked.y + clicked.h / 2));
  check((await editorRect())?.value === 'Clicked', 'dblclick on second text');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+Enter');
  check(!(await objs()).some((o) => o.id === clicked.id), 'empty edit did not delete');

  // ------------------------------------------------------------ non-WinAnsi warning
  step = 'WinAnsi warning';
  await key('Escape');
  await key('t');
  await frames();
  await drag([await toClient(0, 320, 520), await toClient(0, 520, 540)]);
  await page.keyboard.type('Café ok');
  check(await ev('return document.querySelector(".text-editor-warn").hidden;'), 'warning shown for WinAnsi text');
  await page.keyboard.type(' ✓ 中');
  check(await ev('const w = document.querySelector(".text-editor-warn"); return !w.hidden && w.getBoundingClientRect().height > 0;'), 'no warning for non-WinAnsi text');
  await page.keyboard.press('Escape');

  // ------------------------------------------------------------ Replace text
  step = 'replace text';
  const replaceVia = async () => {
    await key('Escape');
    await page.click('.menu-btn:text-is("Tools")');
    await page.click('.menu-item[data-id="replace-text"]');
    await page.click('.dialog button:text-is("Draw rectangle")');
    check(await ev('return app.state.tool;') === 'text', 'Replace text did not pick the Text tool');
    await frames();
  };
  await replaceVia();
  n = (await objs()).length;
  const rr = { a: [355, 74], b: [445, 98] };
  await drag([await toClient(0, ...rr.a), await toClient(0, ...rr.b)]);
  let all = await objs();
  check(all.length === n + 1 && all.at(-1).type === 'whiteout' && all.at(-1).color === '#ffffff', 'no whiteout under the replace editor');
  near(all.at(-1).x, 355, 'whiteout x'); near(all.at(-1).w, 90, 'whiteout w');
  check((await editorRect())?.focused, 'replace editor not open');
  await page.keyboard.type('Replaced');
  await page.keyboard.press('Control+Enter');
  all = await objs();
  const rep = all.at(-1);
  check(all.length === n + 2 && rep.type === 'text' && rep.text === 'Replaced' && rep.fontSize === 19, `replace result ${JSON.stringify(rep)}`);
  // Cancel removes the whiteout.
  await replaceVia();
  await drag([await toClient(0, 355, 120), await toClient(0, 445, 140)]);
  check((await objs()).length === n + 3, 'second replace whiteout');
  await page.keyboard.press('Escape');
  check((await objs()).length === n + 2 && !(await editorRect()), 'cancelled replace kept its whiteout');

  // ------------------------------------------------------------ screenshot
  step = 'screenshot';
  await key('Escape');
  await key('v');
  await page.mouse.click(...await toClient(0, wrapped.x + 5, wrapped.y + 5));
  await page.mouse.move(5, 500);
  await frames();
  const pr = await ev('const r = v.getPageEl(tab, 0).getBoundingClientRect(); return [r.left, r.top];');
  await page.screenshot({ path: join(OUT, 'tools-text.png'), clip: { x: pr[0], y: Math.max(0, pr[1]), width: 816, height: 760 } });

  // ------------------------------------------------------------ save + read back
  step = 'save';
  const final = await texts();
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  const out = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  check((await PDFDocument.load(out)).getPageCount() === 3, 'saved page count');
  const items = await ev(`
    const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg) }).promise, res = [];
    for (const n of [1, 2]) {
      const pg = await d.getPage(n), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent();
      for (const it of tc.items) { const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]); res.push({ page: n - 1, s: it.str, x, y }); }
    }
    await d.loadingTask.destroy(); return res;`, Array.from(out));
  for (const o of final) {
    const m = await measure(o.text, o);
    const first = m.lines[0];
    const by = o.y + m.firstBaseline, d = (i) => Math.hypot(i.x - o.x, i.y - by);
    const it = items.filter((i) => i.page === o.page && i.s.includes(first)).sort((a, b) => d(a) - d(b))[0];
    check(it, `saved PDF lacks "${first}" on page ${o.page + 1}: ${JSON.stringify(items.filter((i) => i.page === o.page).map((i) => i.s))}`);
    near(it.x, o.x, `saved "${first}" x`, 3); near(it.y, by, `saved "${first}" baseline y`, 3);
  }
  check(final.some((o) => o.page === 1), 'no text on the /Rotate 90 page');

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('TOOLS-TEXT OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
