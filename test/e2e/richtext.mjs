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
