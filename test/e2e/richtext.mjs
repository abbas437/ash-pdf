#!/usr/bin/env node
// End-to-end test of the rich-text editor (openTextEditor in renderer/ui/tools-text.js) in Chromium:
// types, styles a word through the editor handle (setSelection + applyStyle), commits runs, re-edits
// them, keeps typing in the run style, pastes HTML as plain text, undo / Enter inside the editor.
// Prints "RICHTEXT OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { flattenAnnotations } from '../../src/core/annots.js';
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
  const editorRect = () => ev('const t = document.querySelector("div.text-editor[contenteditable]"); if (!t) return null; const ed = (await import("/renderer/ui/tools-text.js")).activeTextEditor(); const r = t.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, focused: document.activeElement === t, value: ed?.el === t ? ed.getText() : null, sh: t.scrollHeight, ch: t.clientHeight };');
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

  const E = 'const ed = (await import("/renderer/ui/tools-text.js")).activeTextEditor();';
  const ed = (body, arg) => ev(`${E}\n${body}`, arg);
  const spans = () => ed('return [...ed.el.querySelectorAll("span")].map((s) => ({ t: s.textContent, w: getComputedStyle(s).fontWeight, c: getComputedStyle(s).color }));');
  const paste = (data) => ed('const dt = new DataTransfer(); for (const [k, v] of Object.entries(arg)) dt.setData(k, v); ed.el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));', data);

  step = 'type + style';
  await key('t');
  await frames();
  await page.mouse.click(...await toClient(0, 60, 200));
  await page.keyboard.type('Hello big world');
  check(await ed('return ed.getText();') === 'Hello big world', 'typed text');
  await ed('ed.setSelection(6, 9);');
  check(JSON.stringify(await ed('return ed.getSelection();')) === '{"start":6,"end":9}', 'getSelection');
  await ed("ed.applyStyle({ bold: true, color: '#ff0000' });");
  check(JSON.stringify(await ed('return ed.getSelection();')) === '{"start":6,"end":9}', 'selection kept after applyStyle');
  check((await ed('return ed.styleAtSelection();')).bold === true, 'styleAtSelection bold');
  await page.keyboard.press('Control+Enter');
  let o = (await texts()).at(-1);
  check(o.text === 'Hello big world', `text ${o.text}`);
  check(JSON.stringify(o.runs) === JSON.stringify([{ text: 'Hello ' }, { text: 'big', bold: true, color: '#ff0000' }, { text: ' world' }]), `runs ${JSON.stringify(o.runs)}`);
  const ts = await ev('return [...v.getOverlaySvg(tab, 0).querySelectorAll(`[data-obj-id="${arg}"] tspan`)].map((t) => [t.textContent, t.getAttribute("font-weight"), t.getAttribute("fill")]);', o.id);
  check(ts.some(([t, w, f]) => t === 'big' && w === 'bold' && f === '#ff0000'), `SVG tspans ${JSON.stringify(ts)}`);

  step = 're-edit';
  await key('Escape');
  await key('v');
  await page.mouse.dblclick(...await toClient(0, o.x + 5, o.y + o.h / 2));
  check(await ed('return ed?.getText();') === 'Hello big world', 're-edit text');
  const sp = await spans();
  check(sp.some((s) => s.t === 'big' && Number(s.w) >= 600 && s.c === 'rgb(255, 0, 0)'), `re-edit spans ${JSON.stringify(sp)}`);
  await ed('ed.setSelection(9, 9);');
  await page.keyboard.type('ger');
  const r1 = await ed('return ed.getRuns();');
  check(JSON.stringify(r1) === JSON.stringify([{ text: 'Hello ' }, { text: 'bigger', bold: true, color: '#ff0000' }, { text: ' world' }]), `typing continues the run: ${JSON.stringify(r1)}`);

  step = 'paste html';
  await ed('ed.setSelection(18, 18);');
  await paste({ 'text/html': '<b style="color:blue">X<i>Y</i></b>' });
  check(await ed('return ed.getText();') === 'Hello bigger worldXY', `paste text ${await ed('return ed.getText();')}`);
  check(!(await ed('return !!ed.el.querySelector("b, i");')), 'pasted markup kept');
  check(JSON.stringify(await ed('return ed.getRuns();')) === JSON.stringify(r1.map((r, i) => (i === 2 ? { text: ' worldXY' } : r))), 'pasted text took a style of its own');
  await paste({ 'text/plain': '!', 'text/html': '<b>!</b>' });
  check(await ed('return ed.getText();') === 'Hello bigger worldXY!', 'paste prefers text/plain');
  await page.keyboard.press('Control+z');
  check(await ed('return ed.getText();') === 'Hello bigger worldXY', 'undo inside the editor');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Z');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+Enter');
  o = (await texts()).at(-1);
  check(o.text === 'Hello bigger worldXY\n', `final text ${JSON.stringify(o.text)}`);
  check(o.h > 12 * 1.2 * 1.5, `box grew for the new line: h ${o.h}`);

  // Format controls style the editor's selection and keep it (DOM selection still "big", editor focused).
  const domSel = () => ev('const t = document.querySelector("div.text-editor[contenteditable]"); return { s: getSelection().toString(), focused: !!t && document.activeElement === t };');
  const keptBig = async (what) => { const d = await domSel(); check(d.s === 'big' && d.focused, `${what}: selection not kept ${JSON.stringify(d)}`); };
  const sortRuns = (rs) => JSON.stringify((rs ?? []).map((r) => Object.fromEntries(Object.entries(r).sort())));
  const typeAndSelectBig = async (y) => {
    await page.mouse.click(...await toClient(0, 60, y));
    await page.keyboard.type('Hello big world');
    for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowLeft');
    for (let k = 0; k < 3; k++) await page.keyboard.press('Shift+ArrowLeft');
    await keptBig('keyboard selection');
  };

  step = 'floating format bar';
  await key('Escape');
  await key('t');
  await frames();
  // Box colour black (the default is the review red, which would make a red run no override).
  await page.$eval('.options-bar .opt-color', (el) => { el.value = '#000000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const boxStyle = await ev('return { ...app.state.toolStyle };');
  check(boxStyle.color === '#000000', `box colour ${boxStyle.color}`);
  await typeAndSelectBig(400);
  await frames();
  const fb = await page.locator('.text-format-bar').boundingBox(), er = await editorRect();
  check(fb && fb.y + fb.height <= er.t && er.t - (fb.y + fb.height) < 20 && Math.abs(fb.x - er.l) < 2, `floating bar not just above the box: ${JSON.stringify(fb)} vs ${JSON.stringify(er)}`);
  await page.keyboard.press('Control+b');
  await keptBig('Ctrl+B');
  check(await page.getAttribute('.text-format-bar .tfb-bold', 'aria-pressed') === 'true' && await page.getAttribute('.options-bar .opt-text-bold', 'aria-pressed') === 'true', 'B not shown pressed for the selection');
  await page.click('.text-format-bar .tfb-swatch[data-color="#d62828"]');
  await keptBig('red swatch');
  await page.keyboard.press('Control+u');
  await keptBig('Ctrl+U');
  await page.focus('.text-format-bar .tfb-font');
  await page.selectOption('.text-format-bar .tfb-font', 'Times');
  await keptBig('floating font select');
  await page.keyboard.press('Control+Shift+X');
  check((await ed('return ed.styleAtSelection();')).strike === true, 'Ctrl+Shift+X did not strike');
  await page.keyboard.press('Control+Shift+X');
  await keptBig('Ctrl+Shift+X twice');
  await page.keyboard.press('Control+Enter');
  o = (await texts()).at(-1);
  check(sortRuns(o.runs) === sortRuns([{ text: 'Hello ' }, { text: 'big', bold: true, underline: true, color: '#d62828', font: 'Times' }, { text: ' world' }]), `floating bar runs ${JSON.stringify(o.runs)}`);
  check(o.font === boxStyle.font && !o.bold, `box style changed: ${o.font} ${o.bold}`);
  await frames();
  check(!(await page.$('.text-format-bar')), 'floating bar left after commit');

  step = 'main options bar';
  await key('Escape');
  if (await ev('return app.state.tool;') !== 'text') await key('t');
  await frames();
  await typeAndSelectBig(480);
  await page.focus('.options-bar .opt-text-font');
  await page.selectOption('.options-bar .opt-text-font', 'Times');
  await keptBig('main font select');
  await page.focus('.options-bar .opt-font');
  await page.$eval('.options-bar .opt-font', (el) => { el.value = '18'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await keptBig('main size input');
  for (const b of ['bold', 'underline', 'strike']) {
    await page.click(`.options-bar .opt-text-${b}`);
    await keptBig(`main ${b}`);
  }
  await page.focus('.options-bar .opt-color');
  await page.$eval('.options-bar .opt-color', (el) => { el.value = '#1d4ed8'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await keptBig('main colour input');
  await page.keyboard.press('ArrowLeft');
  await frames();
  check(await page.getAttribute('.options-bar .opt-text-bold', 'aria-pressed') === 'false', 'B pressed at a caret after plain text');
  await page.keyboard.press('Shift+ArrowRight');
  await frames();
  check(await page.getAttribute('.options-bar .opt-text-strike', 'aria-pressed') === 'true' && await page.getAttribute('.text-format-bar .tfb-strike', 'aria-pressed') === 'true', 'S not pressed for a struck selection');
  await page.keyboard.press('Control+Enter');
  o = (await texts()).at(-1);
  check(sortRuns(o.runs) === sortRuns([{ text: 'Hello ' }, { text: 'big', font: 'Times', fontSize: 18, bold: true, underline: true, strike: true, color: '#1d4ed8' }, { text: ' world' }]), `main bar runs ${JSON.stringify(o.runs)}`);
  const after = await ev('return { ...app.state.toolStyle };');
  check(['font', 'fontSize', 'bold', 'italic', 'color'].every((k) => after[k] === boxStyle[k]), `selection styling changed the box style: ${JSON.stringify(after)}`);

  step = 'collapsed caret = box style';
  await key('Escape');
  if (await ev('return app.state.tool;') !== 'text') await key('t');
  await frames();
  await page.mouse.click(...await toClient(0, 60, 560));
  await page.keyboard.type('Box style');
  await page.focus('.options-bar .opt-text-font');
  await page.selectOption('.options-bar .opt-text-font', 'Courier');
  check((await domSel()).focused, 'editor not refocused after the font change');
  await page.keyboard.press('Control+Enter');
  o = (await texts()).at(-1);
  check(o.text === 'Box style' && o.font === 'Courier' && !o.runs, `collapsed caret font: ${JSON.stringify(o)}`);
  check(await ev('return app.state.toolStyle.font;') === 'Courier', 'box style (toolStyle) not set');
  await page.selectOption('.options-bar .opt-text-font', boxStyle.font);

  // A box-level underline is drawn by the run spans, so one word can drop it (and keeps it dropped
  // through a native edit read back from the DOM).
  step = 'box underline off for one word';
  await key('Escape');
  await key('v');
  o = await ev("const o = an.add(tab, { type: 'text', page: 0, x: 60, y: 640, w: 300, h: 20, text: 'Hello big world', font: 'Helvetica', fontSize: 12, color: '#000000', underline: true }); return { ...o };");
  await frames();
  const reopen = async () => { await page.mouse.dblclick(...await toClient(0, o.x + 5, o.y + 8)); check(await ed('return ed?.getText();') != null, 'editor not reopened'); };
  /** text-decoration-line of the span holding `word` and of every ancestor up to the editor's parent. */
  const decoOf = (word) => ed('const n = [...ed.el.querySelectorAll("span")].find((s) => s.textContent.includes(arg)); const out = []; for (let e = n; e && e !== ed.el.parentNode; e = e.parentNode) out.push(getComputedStyle(e).textDecorationLine); return out;', word);
  await reopen();
  check((await decoOf('big')).includes('underline'), `box underline not shown: ${await decoOf('big')}`);
  await ed('ed.setSelection(6, 9);');
  await page.keyboard.press('Control+u');
  let dl = await decoOf('big');
  check(dl.every((v) => v === 'none'), `word still underlined in the editor: ${dl}`);
  check((await decoOf('Hello')).includes('underline'), 'rest of the box lost its underline');
  await page.keyboard.press('Control+Enter');
  const plainBig = sortRuns([{ text: 'Hello ' }, { text: 'big', underline: false }, { text: ' world' }]);
  let ob = (await objs()).find((x) => x.id === o.id);
  check(sortRuns(ob.runs) === plainBig && ob.underline === true, `runs ${JSON.stringify(ob.runs)}`);
  await frames();
  const ov = await ev('const g = v.getOverlaySvg(tab, 0).querySelector(`[data-obj-id="${arg}"]`); return { t: [...g.querySelectorAll("tspan")].map((t) => ({ s: t.textContent, x: +t.getAttribute("x") })), u: [...g.querySelectorAll("rect.ann-text-underline")].map((r) => ({ x: +r.getAttribute("x"), w: +r.getAttribute("width") })) };', o.id);
  const bi = ov.t.findIndex((t) => t.s === 'big');
  check(bi > 0 && bi < ov.t.length - 1 && ov.u.length >= 2, `overlay ${JSON.stringify(ov)}`);
  const [x0, x1] = [ov.t[bi].x, ov.t[bi + 1].x];
  check(!ov.u.some((r) => r.x < x1 - 0.5 && r.x + r.w > x0 + 0.5), `underline drawn under the word: ${JSON.stringify(ov)}`);
  await reopen();
  await ed('ed.setSelection(7, 7);');
  await page.keyboard.type('X');
  // A native edit (as IME / execCommand do): change the DOM text, the editor reads it back.
  await ed('const n = [...ed.el.querySelectorAll("span")].find((s) => s.textContent === "bXig").firstChild; n.data = "bXYig"; ed.el.dispatchEvent(new InputEvent("input", { bubbles: true }));');
  dl = await decoOf('bXYig');
  check(dl.every((v) => v === 'none'), `word underlined again after typing: ${dl}`);
  const nativeRuns = sortRuns([{ text: 'Hello ' }, { text: 'bXYig', underline: false }, { text: ' world' }]);
  check(sortRuns(await ed('return ed.getRuns();')) === nativeRuns, `runs after a native edit ${JSON.stringify(await ed('return ed.getRuns();'))}`);
  // Text the browser puts straight into the editor element (IME into an empty box) has the box style.
  await ed('ed.el.append(document.createTextNode("Z")); ed.el.dispatchEvent(new InputEvent("input", { bubbles: true }));');
  const finalRuns = sortRuns([{ text: 'Hello ' }, { text: 'bXYig', underline: false }, { text: ' worldZ' }]);
  check(sortRuns(await ed('return ed.getRuns();')) === finalRuns, `runs after text in the editor element ${JSON.stringify(await ed('return ed.getRuns();'))}`);
  await page.keyboard.press('Control+Enter');
  ob = (await objs()).find((x) => x.id === o.id);
  check(ob.text === 'Hello bXYig worldZ' && sortRuns(ob.runs) === finalRuns, `committed ${JSON.stringify(ob)}`);

  step = 're-edit with the core not loaded';
  const before = JSON.stringify(ob.runs);
  await ev('globalThis.__prevCore = (await import("/renderer/ui/tools-text.js")).setCoreForTests(null);');
  await reopen();
  await ed('ed.setSelection(ed.getText().length, ed.getText().length);');
  await page.keyboard.type('Q');
  await page.keyboard.press('Control+Enter');
  await ev('(await import("/renderer/ui/tools-text.js")).setCoreForTests(globalThis.__prevCore);');
  ob = (await objs()).find((x) => x.id === o.id);
  check(ob.text.endsWith('Q') && JSON.stringify(ob.runs) === before, `runs kept without the core: ${JSON.stringify(ob)}`);

  step = 'colour input drag is one undo step';
  await reopen();
  await ed('ed.setSelection(0, 5);');
  const runsBefore = JSON.stringify(await ed('return ed.getRuns();'));
  await ev('const i = document.querySelector(".tfb-color"); for (const c of ["#ff0000", "#00ff00", "#0000ff"]) { i.value = c; i.dispatchEvent(new Event("input", { bubbles: true })); }');
  check(JSON.stringify(await ed('return ed.getRuns();')) !== runsBefore && (await ed('return ed.styleAtSelection();')).color === '#0000ff', 'colour applied');
  await ed('ed.el.focus();');
  await page.keyboard.press('Control+z');
  check(JSON.stringify(await ed('return ed.getRuns();')) === runsBefore, `one Ctrl+Z restores the colour before the first change: ${JSON.stringify(await ed('return ed.getRuns();'))}`);
  await page.keyboard.press('Control+Enter');

  step = 'selected text shows its colour; text cursor inside, move frame around';
  await key('Escape');
  await key('t');
  await frames();
  await frames();
  await page.mouse.click(...await toClient(0, 300, 600)); // clear of the boxes above, below the options bar
  await page.keyboard.type('Hello big world');
  await ed('ed.setSelection(6, 9);');
  await page.click('.text-format-bar .tfb-swatch >> nth=2'); // blue swatch: the selection stays
  await frames();
  check(JSON.stringify(await ed('return ed.getSelection();')) === '{"start":6,"end":9}', 'selection kept after the swatch');
  const bigRect = await ed('const sp = [...ed.el.querySelectorAll("span")].find((x) => x.textContent === "big"); const r = sp.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };');
  const shot = await page.screenshot({ clip: bigRect });
  const blue = await ev(`
    const img = await createImageBitmap(new Blob([Uint8Array.from(atob(arg), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const c = new OffscreenCanvas(img.width, img.height), ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const D = ctx.getImageData(0, 0, img.width, img.height).data; let n = 0;
    for (let k = 0; k < D.length; k += 4) if (D[k + 2] > 150 && D[k] < 110 && D[k + 1] < 140) n++;
    return n;`, shot.toString('base64'));
  check(blue >= 10, `the selected word is drawn in its new colour while still selected (blue pixels: ${blue})`);
  const r0 = await editorRect();
  await drag([[r0.l - 3, (r0.t + r0.b) / 2], [r0.l + 37, (r0.t + r0.b) / 2 + 20]]);
  const r1m = await editorRect();
  near(r1m.l - r0.l, 40, 'frame drag moves the editor (x)', 1.5);
  near(r1m.t - r0.t, 20, 'frame drag moves the editor (y)', 1.5);
  check(r1m.focused && await ed('return ed.getText();') === 'Hello big world', 'still editing after the move');
  await page.keyboard.press('Control+Enter');
  o = (await texts()).at(-1);
  const want = await toPage([r1m.l, r1m.t]);
  near(o.x, want.x, 'new box x after the move', 1.5);
  near(o.y, want.y, 'new box y after the move', 1.5);
  // Re-edit: dragging the frame moves the existing box (one update with the text).
  await key('Escape');
  await key('v');
  await frames();
  await page.mouse.dblclick(...await toClient(0, o.x + 5, o.y + o.h / 2));
  check(await ed('return ed?.objectId;') === o.id, 're-editing the moved box');
  // Select tool: the viewer shows the move cursor over the box; inside the editor it is the text cursor, on the frame the move cursor.
  await page.mouse.move(...await toClient(0, o.x + 20, o.y + o.h / 2));
  const cur = await ed('const f = ed.el.parentNode.querySelector(".text-editor-frame"); return { sc: v.getScrollEl(tab).style.cursor, text: getComputedStyle(ed.el).cursor, frame: f && getComputedStyle(f).cursor };');
  check(cur.sc === 'move' && cur.text === 'text' && cur.frame === 'move', `cursors ${JSON.stringify(cur)}`);
  const r2 = await editorRect();
  await drag([[(r2.l + r2.r) / 2, r2.t - 3], [(r2.l + r2.r) / 2 + 15, r2.t + 27]]);
  await page.keyboard.press('Control+Enter');
  const o2 = (await objs()).find((x) => x.id === o.id);
  const s1 = await ev('return v.scale(tab);');
  near(o2.x - o.x, 15 / s1, 're-edit move x', 0.5);
  near(o2.y - o.y, 30 / s1, 're-edit move y', 0.5);
  check(o2.text === 'Hello big world', 're-edit move keeps the text');

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('RICHTEXT OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
