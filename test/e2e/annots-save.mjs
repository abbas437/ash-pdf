#!/usr/bin/env node
// End-to-end test of saving overlay objects as real PDF annotations (renderer/ui/annotations.js
// beforeSave) and of Document > Flatten annotations… (renderer/ui/pagetools.js) in Chromium via
// playwright-core: sets the author through Edit > Author name…, draws a rectangle, a text box and a
// whiteout, saves twice and checks the output with pdf.js getAnnotations() and pixels, then opens
// the saved file, flattens it and undoes the flatten. Prints "ANNOTS-SAVE OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const AUTHOR = 'Ahmad Reviewer';

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText('Page 1', { x: 360, y: 700, size: 20, font });
  // A black block at visible (300,300)-(400,350): the whiteout must hide it.
  p.drawRectangle({ x: 300, y: 792 - 350, width: 100, height: 50, color: rgb(0, 0, 0) });
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = await makePdf();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const key = async (k) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(k); };
  const objs = () => ev('return tab.objects.map((o) => ({ ...o }));');
  const toClient = (i, x, y) => ev('const c = v.pageToClient(tab, arg[0], arg[1], arg[2]); return [c.clientX, c.clientY];', [i, x, y]);
  const drag = async (a, b) => {
    await page.mouse.move(...a);
    await page.mouse.down();
    await page.mouse.move(b[0], b[1], { steps: 5 });
    await page.mouse.up();
  };
  const menu = async (name, id) => {
    await page.click(`.menu-btn:text-is("${name}")`);
    await page.click(`.menu-item[data-id="${id}"]`);
    await page.waitForSelector('.dialog');
  };
  // pdf.js annotations of page 1: [{subtype, title}]
  const annotsOf = (bytes) => ev(`
    const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg) }).promise;
    const a = await (await d.getPage(1)).getAnnotations();
    await d.loadingTask.destroy();
    return a.map((x) => ({ subtype: x.subtype, title: x.titleObj?.str ?? x.title ?? null }));`, Array.from(bytes));
  // Render page 1 (mode 0 = page content only, 2 = with annotation appearances) and count
  // non-white pixels in each visible-space region {name: [x0, y0, x1, y1]}.
  const ink = (bytes, mode, regions) => ev(`
    const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg.bytes) }).promise, S = 2;
    const pg = await d.getPage(1), vp = pg.getViewport({ scale: S });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: arg.mode }).promise;
    const res = {};
    for (const [k, [x0, y0, x1, y1]] of Object.entries(arg.regions)) {
      const D = ctx.getImageData(x0 * S, y0 * S, (x1 - x0) * S, (y1 - y0) * S).data;
      let n = 0; for (let i = 0; i < D.length; i += 4) if (D[i] < 200 || D[i + 1] < 200 || D[i + 2] < 200) n++;
      res[k] = n;
    }
    await d.loadingTask.destroy(); return res;`, { bytes: Array.from(bytes), mode, regions });
  const REGIONS = { rectEdge: [55, 80, 65, 120], text: [62, 202, 298, 238], block: [310, 310, 390, 340] };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'one.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 1 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await frames();

  // ------------------------------------------------------------ Edit > Author name…
  step = 'author setting';
  check(await ev('return await an.getAuthor();') === 'ASH PDF Studio', 'default author is not "ASH PDF Studio"');
  await menu('Edit', 'annots-author');
  check(await page.inputValue('#pt-author') === 'ASH PDF Studio', 'author dialog does not show the default');
  await page.fill('#pt-author', AUTHOR);
  await page.click('.dialog button[data-value="ok"]');
  await page.waitForSelector('.dialog', { state: 'detached' });
  check(await ev('return await window.api.settingsGet("annotations.author");') === AUTHOR, 'author setting was not stored');

  // ------------------------------------------------------------ draw rect, text box, whiteout
  step = 'draw';
  await key('Escape');
  await key('r');
  await frames();
  await drag(await toClient(0, 60, 60), await toClient(0, 200, 140));
  await key('Escape');
  await key('t');
  await frames();
  await drag(await toClient(0, 60, 200), await toClient(0, 300, 240));
  await page.keyboard.type('Hello annots');
  await page.keyboard.press('Control+Enter');
  await key('Escape');
  await page.click('[data-tool="whiteout"]');
  await frames();
  await drag(await toClient(0, 290, 290), await toClient(0, 410, 360));
  await key('Escape');
  const types = (await objs()).map((o) => o.type).sort().join(',');
  check(types === 'rect,text,whiteout', `drawn objects: ${types}`);

  // ------------------------------------------------------------ save twice
  step = 'save';
  check(await ev('window.__orig = tab.bytes; return await app.saveTab(tab, true);'), 'first saveTab returned false');
  const out1 = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  check(await ev('return tab.bytes === window.__orig && tab.objects.length === 3 && !tab.dirty;'), 'save changed tab.bytes / objects / dirty');
  const a1 = await annotsOf(out1);
  const kinds = a1.map((a) => a.subtype).sort().join(',');
  check(kinds === 'FreeText,Square', `Square and FreeText annotations expected, got [${kinds}]`);
  check(a1.every((a) => a.title === AUTHOR), `annotation author: ${JSON.stringify(a1)}`);
  check(await ev('return await app.saveTab(tab, false);'), 'second saveTab returned false');
  const out2 = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  check(await ev('return tab.bytes === window.__orig;'), 'second save changed tab.bytes');
  const a2 = await annotsOf(out2);
  check(a2.length === 2, `second save has ${a2.length} annotations, expected exactly 2`);

  step = 'pixels';
  const shown = await ink(out2, 2, REGIONS);
  check(shown.rectEdge > 0 && shown.text > 0, `annotations not drawn: ${JSON.stringify(shown)}`);
  check(shown.block === 0, `whiteout does not cover the black block: ${shown.block} non-white pixels`);
  const contentOnly = await ink(out2, 0, REGIONS);
  check(contentOnly.block === 0, 'whiteout is not burned into the page content');
  check(contentOnly.rectEdge === 0 && contentOnly.text === 0, `rect/text burned into the content: ${JSON.stringify(contentOnly)}`);

  // ------------------------------------------------------------ Document > Flatten annotations…
  step = 'flatten';
  await ev('await app.openBytes({ name: "saved.pdf", bytes: new Uint8Array(arg) });', Array.from(out2));
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.name === 'saved.pdf' && t.numPages === 1; }, null, { timeout: 10_000 });
  check(await ev('return tab.objects.length === 0 && !tab.dirty;'), 'reopened tab has overlay objects or is dirty');
  check((await annotsOf(await ev('return Array.from(tab.bytes);'))).length === 2, 'reopened tab does not have 2 annotations');
  await menu('Document', 'flatten-annotations');
  check(/already saved in the file/.test(await page.textContent('.dialog')), 'flatten dialog does not explain that it flattens saved annotations');
  check(!(await page.$('.dialog button[data-value="save"]')), 'Save first offered for a clean tab');
  await page.click('.dialog button[data-value="ok"]');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.bytesUndo?.length === 1; }, null, { timeout: 10_000 });
  const flat = Uint8Array.from(await ev('return Array.from(tab.bytes);'));
  const a3 = await annotsOf(flat);
  check(a3.length === 0, `after flatten ${a3.length} annotations remain`);
  const burned = await ink(flat, 0, REGIONS);
  check(burned.rectEdge > 0 && burned.text > 0 && burned.block === 0, `flattened content not visible: ${JSON.stringify(burned)}`);
  check(await ev('return tab.dirty;'), 'flatten did not mark the tab dirty');

  step = 'undo flatten';
  await ev('await app.pageTools.undo(tab);');
  const undone = await annotsOf(await ev('return Array.from(tab.bytes);'));
  check(undone.length === 2, `undo restored ${undone.length} annotations, expected 2`);

  step = 'save first offer';
  await ev('an.add(tab, { type: "rect", page: 0, x: 400, y: 500, w: 40, h: 40, stroke: "#000000" });');
  check(await ev('return tab.dirty;'), 'adding an object did not mark the tab dirty');
  await menu('Document', 'flatten-annotations');
  check(!!(await page.$('.dialog button[data-value="save"]')), 'Save first not offered for a dirty tab');
  await page.click('.dialog button[data-value="cancel"]');
  await page.waitForSelector('.dialog', { state: 'detached' });

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('ANNOTS-SAVE OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
