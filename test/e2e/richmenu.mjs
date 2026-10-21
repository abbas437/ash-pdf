#!/usr/bin/env node
// End-to-end test of the text editor's context menu (renderer/ui/text-menu.js) in Chromium: right-click
// in a text box opens the app menu without committing the editor or losing its selection; Bold / Colour /
// Size / Font act on the selected word; right-click on a word selects it; Cut / Paste / Custom size /
// Custom colour; keyboard navigation and Esc; a callout comment formatted through the menu renders its
// runs and fits its box to them. Prints "RICHMENU OK".
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
  const paste = (data) => ed('const dt = new DataTransfer(); for (const [k, v] of Object.entries(arg)) dt.setData(k, v); ed.el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));', data);
  const editorOpen = () => ed('return !!ed && ed.el.isConnected && document.activeElement === ed.el;');
  const sel = async () => JSON.stringify(await ed('return ed.getSelection();'));
  const canon = (runs) => JSON.stringify((runs ?? []).map((r) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))));
  /** Client centre of the first occurrence of `word` in the open editor. */
  const wordAt = (word) => ed(`const w = document.createTreeWalker(ed.el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(arg); if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + arg.length); const b = r.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }
    return null;`, word);
  const menuShown = () => page.evaluate(() => { const m = document.querySelector('.text-context-menu'); return m ? [...m.querySelectorAll(':scope > button.menu-item > span')].map((s) => s.textContent) : null; });
  const rightClick = async (word) => { await page.mouse.click(...await wordAt(word), { button: 'right' }); await frames(); };
  const item = (label, sub = false) => page.locator(`.text-context-menu${sub ? ' .text-submenu' : ''} button.menu-item`, { hasText: new RegExp(`^${label}`) }).first();
  const settle = async () => { await frames(); await page.evaluate(() => new Promise((r) => setTimeout(r, 50))); };

  step = 'open the menu on a selection';
  await key('t');
  await frames();
  await page.mouse.click(...await toClient(0, 60, 200));
  await page.keyboard.type('Hello big world');
  await ed('ed.setSelection(6, 9);');
  await rightClick('big');
  const labels = await menuShown();
  check(JSON.stringify(labels) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Select all', 'Bold', 'Italic', 'Underline', 'Strikethrough', 'Font', 'Size', 'Colour']), `menu items ${JSON.stringify(labels)}`);
  await settle();
  check(await editorOpen(), 'menu open: editor still open and focused');
  check(await sel() === '{"start":6,"end":9}', `menu open: selection ${await sel()}`);
  check((await texts()).length === 0, 'menu open: nothing committed');

  step = 'Bold';
  await item('Bold').click();
  await settle();
  check(!(await menuShown()), 'menu closed after Bold');
  check(await editorOpen(), 'Bold: editor still open');
  check(await sel() === '{"start":6,"end":9}', `Bold: selection ${await sel()}`);
  check((await ed('return ed.styleAtSelection();')).bold === true, 'Bold applied');

  step = 'Colour';
  await rightClick('big');
  check(await item('Bold').getAttribute('aria-checked') === 'true', 'Bold is checked');
  await item('Colour').hover();
  await page.click('.text-submenu .tm-swatch[data-color="#1d4ed8"]');
  await settle();
  check(await sel() === '{"start":6,"end":9}', `Colour: selection ${await sel()}`);

  step = 'Size';
  await rightClick('big');
  await item('Size').hover();
  await item('18', true).click();
  await settle();
  check(await sel() === '{"start":6,"end":9}', `Size: selection ${await sel()}`);

  step = 'Font';
  await rightClick('big');
  await item('Font').hover();
  await item('Courier', true).click();
  await settle();
  check(await sel() === '{"start":6,"end":9}', `Font: selection ${await sel()}`);

  step = 'keyboard + Esc';
  await rightClick('big');
  for (const k of ['End', 'ArrowUp', 'ArrowRight', 'ArrowDown']) await page.keyboard.press(k);
  const active = await page.evaluate(() => [...document.querySelectorAll('.text-context-menu .menu-item.active > span')].map((s) => s.textContent));
  check(JSON.stringify(active) === '["Size","9"]', `keyboard highlight ${JSON.stringify(active)}`);
  await page.keyboard.press('Escape');
  check(!!(await menuShown()) && !(await page.$('.text-submenu')), 'Esc in the submenu closes only the submenu');
  await page.keyboard.press('Escape');
  await settle();
  check(!(await menuShown()), 'Esc closes the menu');
  check(await editorOpen(), 'Esc: editor still open (not cancelled)');
  check(await sel() === '{"start":6,"end":9}', `Esc: selection ${await sel()}`);
  await page.keyboard.press('Control+Enter');
  let o = (await texts()).at(-1);
  check(o?.text === 'Hello big world', `committed text ${o?.text}`);
  check(canon(o.runs) === canon([{ text: 'Hello ' }, { text: 'big', bold: true, color: '#1d4ed8', fontSize: 18, font: 'Courier' }, { text: ' world' }]), `runs ${JSON.stringify(o.runs)}`);

  step = 'right-click selects the word';
  await key('Escape');
  await ev("if (app.state.tool !== 'text') document.querySelector('.tb-tools [data-tool=\"text\"]').click();");
  await frames();
  await page.mouse.click(...await toClient(0, 60, 400));
  await page.keyboard.type('alpha beta gamma');
  await ed('ed.setSelection(2, 2);');
  await rightClick('beta');
  check(await sel() === '{"start":6,"end":10}', `word selected: ${await sel()}`);

  step = 'Cut / Paste';
  await item('Cut').click();
  await settle();
  check(await ed('return ed.getText();') === 'alpha  gamma', `after Cut: ${await ed('return ed.getText();')}`);
  check(await page.evaluate(() => window.api.readText()) === 'beta', 'Cut wrote the clipboard');
  await rightClick('gamma');
  check(await sel() === '{"start":7,"end":12}', `gamma selected: ${await sel()}`);
  await item('Paste').click();
  await settle();
  check(await ed('return ed.getText();') === 'alpha  beta', `after Paste: ${await ed('return ed.getText();')}`);
  check(await editorOpen(), 'Cut / Paste: editor still open');

  step = 'Custom size / colour';
  await rightClick('alpha');
  await item('Size').hover();
  await item('Custom', true).click();
  await page.locator('.tm-size').fill('22');
  await page.keyboard.press('Enter');
  await settle();
  check(await editorOpen(), 'Custom size: editor still open');
  check(await sel() === '{"start":0,"end":5}', `Custom size: selection ${await sel()}`);
  await rightClick('beta');
  await item('Colour').hover();
  await item('Custom', true).click();
  await page.evaluate(() => { const i = document.querySelector('.tm-color'); i.value = '#123456'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
  check(await editorOpen(), 'Custom colour: editor still open');
  await page.keyboard.press('Control+Enter');
  o = (await texts()).at(-1);
  check(canon(o.runs) === canon([{ text: 'alpha', fontSize: 22 }, { text: '  ' }, { text: 'beta', color: '#123456' }]), `custom runs ${JSON.stringify(o.runs)}`);

  step = 'callout';
  await key('Escape');
  await key('c');
  await frames();
  await page.mouse.click(...await toClient(0, 300, 600));
  await page.keyboard.type('Note big text');
  await rightClick('big');
  await item('Size').hover();
  await item('18', true).click();
  await settle();
  check(await sel() === '{"start":5,"end":8}', `callout selection ${await sel()}`);
  const prevH = () => ev('const r = v.getOverlaySvg(tab, 0).querySelector("g.ann-preview .ann-callout-box"); return r ? +r.getAttribute("height") : null;');
  const fitCo = (text, runs, w) => ev('const core = await import("/src/core/index.js"); return Math.round((core.layoutRich({ type: "callout", text: arg[0], runs: arg[1], fontSize: 10, lineHeight: 1.2 }, arg[2] - 8).height + 8) * 1000) / 1000;', [text, runs, w]);
  near(await prevH(), await fitCo('Note big text', [{ text: 'Note ' }, { text: 'big', fontSize: 18 }, { text: ' text' }], 160), 'preview box fits the 18 pt word', 0.01);
  // Options change while editing (session.restyle): the runs survive.
  await ev("bus.emit('state:changed', { key: 'toolStyle', value: app.state.toolStyle });");
  check(canon(await ed('return ed.getRuns();')) === canon([{ text: 'Note ' }, { text: 'big', fontSize: 18 }, { text: ' text' }]), `runs after restyle ${JSON.stringify(await ed('return ed.getRuns();'))}`);
  await ed('ed.setSelection(13, 13);');
  await paste({ 'text/plain': '\nmore' });
  await settle();
  near(await prevH(), await fitCo('Note big text\nmore', [{ text: 'Note ' }, { text: 'big', fontSize: 18 }, { text: ' text\nmore' }], 160), 'preview follows a paste', 0.01);
  await page.keyboard.press('Control+Enter');
  const co = (await objs()).filter((x) => x.type === 'callout').at(-1);
  check(co?.text === 'Note big text\nmore', `callout text ${JSON.stringify(co?.text)}`);
  check(canon(co.runs) === canon([{ text: 'Note ' }, { text: 'big', fontSize: 18 }, { text: ' text\nmore' }]), `callout runs ${JSON.stringify(co.runs)}`);
  near(co.h, await fitCo(co.text, co.runs, co.w), 'callout box fits mixed sizes', 0.01);
  const cts = await ev('return [...v.getOverlaySvg(tab, 0).querySelectorAll(`[data-obj-id="${arg}"] tspan`)].map((t) => [t.textContent, t.getAttribute("font-size"), +t.getAttribute("x")]);', co.id);
  check(cts.some(([t, fs]) => t === 'big' && fs === '18'), `callout tspans ${JSON.stringify(cts)}`);
  check(cts.every(([, , x]) => x >= co.x + 4 - 0.01), `callout tspans inside the padding ${JSON.stringify(cts)}`);

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('RICHMENU OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

