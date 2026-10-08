#!/usr/bin/env node
// End-to-end test of cut / copy / paste (renderer/ui/copytext.js) in Chromium via playwright-core, with the
// browser shim's in-memory clipboard: the page context menu (Cut / Copy / Paste at the click point),
// objects across pages, a changed system clipboard pasting a text box, page text Copy (Cut disabled),
// Ctrl+X / Ctrl+Z, a clipboard image pasted as an image object (text preferred when both are there), image
// objects copied to the clipboard as PNG, and Ctrl+V / Ctrl+X inside the Edit text editor. Prints "CLIPBOARD OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= 2; k++) doc.addPage([612, 792]).drawText(`Hello copy ${k}`, { x: 72, y: 700, size: 24, font });
  return Buffer.from(await doc.save());
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, tol, msg) => check(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} ±${tol}`);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const problems = [];
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const objs = () => ev('return tab.objects.map((o) => ({ id: o.id, type: o.type, page: o.page, x: o.x, y: o.y, w: o.w, h: o.h, text: o.text }));');
  const clientOf = async (i, x, y) => { const c = await ev('return v.pageToClient(tab, arg[0], arg[1], arg[2]);', [i, x, y]); return [c.clientX, c.clientY]; };
  const clip = () => page.evaluate(() => window.__ashShim.clipboardText());
  const menuAt = async (i, x, y) => {
    const pt = await clientOf(i, x, y);
    await page.mouse.click(...pt, { button: 'right' });
    await page.waitForSelector('.page-context-menu', { timeout: 3000 });
  };
  const choose = async (action) => { await page.click(`.page-context-menu [data-action="${action}"]`); await frames(); await frames(); };
  const settleObjs = (n) => page.waitForFunction((k) => window.ashStudio.state.tabs[0].objects.length === k, n, { timeout: 3000 }).catch(() => {});

  step = 'open';
  const pdf = await makePdf();
  await page.evaluate((b) => window.ashStudio.openBytes({ name: 'clip.pdf', bytes: new Uint8Array(b) }), [...pdf]);
  await page.waitForFunction(() => document.querySelector('.page[data-page-index="0"] .textLayer span'));

  step = 'right-click a rectangle -> Cut -> gone (one undo step)';
  await ev("an.add(tab, { type: 'rect', page: 0, x: 100, y: 300, w: 80, h: 60, stroke: '#ff0000', strokeWidth: 2 });");
  await menuAt(0, 140, 330);
  const items = await page.$$eval('.page-context-menu .menu-item', (b) => b.map((x) => `${x.dataset.action}:${x.disabled}`));
  check(items.join() === 'cut:false,copy:false,paste:false,delete:false,select-all:false', `menu items ${items}`);
  check(await page.evaluate(() => document.activeElement?.dataset.action) === 'cut', 'menu: first item not focused');
  await page.keyboard.press('ArrowDown');
  check(await page.evaluate(() => document.activeElement?.dataset.action) === 'copy', 'menu: ArrowDown did not move focus');
  await choose('cut');
  check((await objs()).length === 0, 'Cut did not remove the rectangle');
  check(await clip() === '1 object (ASH PDF Studio)', `Cut clipboard text ${JSON.stringify(await clip())}`);
  check(!(await page.$('.page-context-menu')), 'menu still open after Cut');

  step = 'right-click elsewhere -> Paste -> back at the click point';
  await menuAt(0, 400, 420);
  await choose('paste');
  await settleObjs(1);
  let o = await objs();
  check(o.length === 1 && o[0].type === 'rect' && o[0].page === 0, `paste: ${JSON.stringify(o)}`);
  near(o[0].x + o[0].w / 2, 400, 0.5, 'pasted centre x'); near(o[0].y + o[0].h / 2, 420, 0.5, 'pasted centre y');

  step = 'Copy + Paste on another page';
  await menuAt(0, 400, 420);
  await choose('copy');
  await ev('v.getPageEl(tab, 1).scrollIntoView();');
  await page.waitForFunction(() => document.querySelector('.page[data-page-index="1"] .textLayer span'));
  await frames();
  await menuAt(1, 200, 250);
  await choose('paste');
  await settleObjs(2);
  o = await objs();
  check(o.length === 2 && o[1].page === 1 && o[1].type === 'rect', `paste on page 2: ${JSON.stringify(o)}`);
  near(o[1].x + o[1].w / 2, 200, 0.5, 'page 2 centre x'); near(o[1].y + o[1].h / 2, 250, 0.5, 'page 2 centre y');

  step = 'system clipboard changed to text after the object copy -> Paste makes a text box';
  await page.evaluate(() => window.__ashShim.setClipboardText('Hello paste'));
  await menuAt(1, 100, 450);
  await choose('paste');
  await settleObjs(3);
  o = await objs();
  check(o.length === 3 && o[2].type === 'text' && o[2].text === 'Hello paste' && o[2].page === 1, `text paste: ${JSON.stringify(o.slice(2))}`);
  near(o[2].x, 100, 0.5, 'text box x'); near(o[2].y, 450, 0.5, 'text box y');

  step = 'keyboard: Ctrl+X cuts the selection, Ctrl+Z restores it in one step';
  await ev('an.select(tab, [tab.objects[0].id]);');
  await page.locator('.viewer-scroll:not([hidden])').focus();
  await page.keyboard.press('Control+x');
  await settleObjs(2);
  check((await objs()).length === 2, 'Ctrl+X did not cut');
  await page.keyboard.press('Control+z');
  check((await objs()).length === 3, 'Ctrl+Z did not restore the cut object');

  step = 'page text selection -> Copy; Cut disabled with a tip';
  await ev('an.select(tab, []); v.getPageEl(tab, 0).scrollIntoView();');
  await frames();
  const span = page.locator('.page[data-page-index="0"] .textLayer span').first();
  const box = await span.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection().toString());
  check(/Hello copy/.test(selected), `selection ${JSON.stringify(selected)}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.waitForSelector('.page-context-menu');
  const cutBtn = await page.$eval('.page-context-menu [data-action="cut"]', (b) => [b.disabled, b.title]);
  check(cutBtn[0] === true && cutBtn[1] === "Use Edit text (D) to change the document's text", `Cut for page text: ${cutBtn}`);
  await choose('copy');
  check(await clip() === selected, `copied page text ${JSON.stringify(await clip())}`);

  step = 'system clipboard holds only an image -> Paste places an image object within half the page';
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const png = await page.evaluate(async () => {
    const c = new OffscreenCanvas(800, 400), g = c.getContext('2d');
    g.fillStyle = '#2060c0'; g.fillRect(0, 0, 800, 400);
    return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())];
  });
  await page.evaluate((b) => window.__ashShim.setClipboardImage(new Uint8Array(b)), png);
  let before = (await objs()).length;
  await menuAt(0, 300, 400);
  await choose('paste');
  await settleObjs(before + 1);
  o = await objs();
  let img = o[o.length - 1];
  check(o.length === before + 1 && img.type === 'image' && img.page === 0, `image paste: ${JSON.stringify(o.slice(before))}`);
  near(img.w, 306, 0.01, 'pasted image width (half the page)'); near(img.h, 153, 0.01, 'pasted image height (aspect kept)');
  near(img.x + img.w / 2, 300, 0.5, 'pasted image centre x'); near(img.y + img.h / 2, 400, 0.5, 'pasted image centre y');

  step = 'image and non-empty text on the clipboard -> the text wins';
  await page.evaluate((b) => window.__ashShim.setClipboardImage(new Uint8Array(b), 'Caption'), png);
  before = (await objs()).length;
  await menuAt(0, 150, 150);
  await choose('paste');
  await settleObjs(before + 1);
  o = await objs();
  check(o.length === before + 1 && o[before].type === 'text' && o[before].text === 'Caption', `image+text paste: ${JSON.stringify(o.slice(before))}`);

  step = 'Copy an image object -> the system clipboard holds its PNG and the summary; Paste pastes the object';
  await menuAt(0, 300, 400);
  await choose('copy');
  const sig = (b) => b && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v);
  let held = await page.evaluate(async () => {
    const b = window.__ashShim.clipboardImage();
    const bmp = b && await createImageBitmap(new Blob([b], { type: 'image/png' }));
    return { bytes: b ? [...b.slice(0, 8)] : null, w: bmp?.width, h: bmp?.height, text: window.__ashShim.clipboardText() };
  });
  check(sig(held.bytes) && held.w === 800 && held.h === 400 && held.text === '1 object (ASH PDF Studio)', `clipboard after image copy: ${JSON.stringify(held)}`);
  before = (await objs()).length;
  await menuAt(0, 450, 250);
  await choose('paste');
  await settleObjs(before + 1);
  o = await objs();
  check(o.length === before + 1 && o[before].type === 'image' && o[before].page === 0 && Math.abs(o[before].w - 306) < 0.01, `image object paste: ${JSON.stringify(o.slice(before))}`);

  step = 'Ctrl+C on a JPEG image object -> the system clipboard holds a PNG of it';
  await ev(`const c = new OffscreenCanvas(30, 20); c.getContext('2d').fillRect(0, 0, 30, 20);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());
    const o = an.add(tab, { type: 'image', page: 0, x: 40, y: 40, w: 30, h: 20, bytes, mime: 'image/jpeg', opacity: 1, rotation: 0 });
    an.select(tab, [o.id]);`);
  await page.locator('.viewer-scroll:not([hidden])').focus();
  await page.keyboard.press('Control+c');
  await page.waitForFunction(() => window.__ashShim.clipboardImage(), null, { timeout: 3000 }).catch(() => {});
  held = await page.evaluate(async () => {
    const b = window.__ashShim.clipboardImage();
    const bmp = b && await createImageBitmap(new Blob([b], { type: 'image/png' }));
    return { bytes: b ? [...b.slice(0, 8)] : null, w: bmp?.width, h: bmp?.height };
  });
  check(sig(held.bytes) && held.w === 30 && held.h === 20, `clipboard after JPEG object copy: ${JSON.stringify(held)}`);
  await ev('an.select(tab, []);');

  step = 'Ctrl+V in the Edit text editor inserts text there, no text box';
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('d');
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await page.waitForSelector('input.te-editor', { timeout: 10000 });
  await page.evaluate(() => { window.__ashShim.setClipboardText(' XYZ'); const i = document.querySelector('input.te-editor'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
  const n = (await objs()).length;
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => document.querySelector('input.te-editor')?.value.endsWith(' XYZ'), null, { timeout: 3000 }).catch(() => {});
  const val = await page.inputValue('input.te-editor');
  check(val.endsWith('Hello copy 1 XYZ'), `editor value ${JSON.stringify(val)}`);
  check((await objs()).length === n, 'Ctrl+V in the editor created an object');
  await page.evaluate(() => { const i = document.querySelector('input.te-editor'); i.setSelectionRange(0, 5); });
  await page.keyboard.press('Control+x');
  check(await clip() === 'Hello' && (await page.inputValue('input.te-editor')).startsWith(' copy 1'), `editor Ctrl+X: ${await clip()}`);
  await page.keyboard.press('Escape');

  if (problems.length) throw new Error(problems.join('\n'));
  console.log('CLIPBOARD OK');
} catch (err) {
  console.error(`FAILED at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
