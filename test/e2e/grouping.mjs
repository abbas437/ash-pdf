#!/usr/bin/env node
// End-to-end test of Group / Ungroup (renderer/ui/annotations.js, grouping-lib.js) in Chromium via
// playwright-core: draws a rectangle and a text box, groups them (Ctrl+G), selects the group by
// clicking one member, moves it, resizes it from the se handle of the group box, undoes the resize,
// saves and reopens (the `group` survives), then ungroups (Ctrl+Shift+G). Prints "GROUPING OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText('Page 1', { x: 360, y: 700, size: 20, font });
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
  const sel = () => ev('return an.getSelection(tab);');
  const near = (a, b, tol, msg) => check(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
  const pick = (os) => ({ rect: os.find((o) => o.type === 'rect'), text: os.find((o) => o.type === 'text') });
  const holding = async (k, fn) => { await page.keyboard.down(k); try { await fn(); } finally { await page.keyboard.up(k); } };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'one.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 1 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await frames();

  step = 'group';
  await key('Escape');
  await key('r');
  await frames();
  await drag(await toClient(0, 60, 60), await toClient(0, 200, 140));
  await key('Escape');
  await key('t');
  await frames();
  await drag(await toClient(0, 60, 200), await toClient(0, 300, 240));
  await page.keyboard.type('Hello group');
  await page.keyboard.press('Control+Enter');
  await key('Escape');
  await key('v');
  check(await ev('return app.state.tool;') === 'select', 'V did not select the Select tool');
  await frames();
  check((await objs()).map((o) => o.type).sort().join() === 'rect,text', 'expected a rect and a text box');
  await page.mouse.click(...await toClient(0, 130, 100));
  const tp = await toClient(0, 100, 215);
  await holding('Shift', () => page.mouse.click(...tp));
  check((await sel()).length === 2, `Shift+click did not select both (${(await sel()).length})`);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+g');
  let { rect, text } = pick(await objs());
  check(typeof rect.group === 'string' && rect.group !== '' && rect.group === text.group, `Ctrl+G: groups ${rect.group} / ${text.group}`);

  step = 'select group by one member';
  await key('Escape');
  check((await sel()).length === 0, 'Escape did not clear the selection');
  await page.mouse.click(...await toClient(0, 130, 100));
  check((await sel()).length === 2, `click on the rect selected ${(await sel()).length}, expected both`);
  await frames();

  step = 'move';
  const m0 = pick(await objs());
  await drag(await toClient(0, 130, 100), await toClient(0, 160, 120));
  const m1 = pick(await objs());
  for (const k of ['rect', 'text']) {
    near(m1[k].x - m0[k].x, 30, 0.5, `${k} dx`);
    near(m1[k].y - m0[k].y, 20, 0.5, `${k} dy`);
  }
  check((await sel()).length === 2, 'group not selected after the move');

  step = 'resize';
  await frames();
  const before = pick(await objs());
  const ub = { x: Math.min(before.rect.x, before.text.x), y: Math.min(before.rect.y, before.text.y) };
  ub.w = Math.max(before.rect.x + before.rect.w, before.text.x + before.text.w) - ub.x;
  ub.h = Math.max(before.rect.y + before.rect.h, before.text.y + before.text.h) - ub.y;
  check(!!(await page.$('.ann-group-bbox')), 'group box not drawn');
  check((await page.$$('.ann-handle')).length === 8, 'group box should have 8 handles');
  await drag(await toClient(0, ub.x + ub.w, ub.y + ub.h), await toClient(0, ub.x + ub.w * 1.5, ub.y + ub.h * 1.5));
  const after = pick(await objs());
  const K = 1.5, X = (x) => ub.x + (x - ub.x) * K, Y = (y) => ub.y + (y - ub.y) * K;
  near(after.rect.x, X(before.rect.x), 0.5, 'rect x');
  near(after.rect.y, Y(before.rect.y), 0.5, 'rect y');
  near(after.rect.w, before.rect.w * K, 0.5, 'rect w');
  near(after.rect.h, before.rect.h * K, 0.5, 'rect h');
  near(after.text.x, X(before.text.x), 0.5, 'text x');
  near(after.text.w, before.text.w * K, 0.5, 'text w');
  check(after.text.h >= before.text.h - 1e-9, `text h shrank: ${before.text.h} -> ${after.text.h}`);
  check(after.text.fontSize === before.text.fontSize, `font size changed: ${before.text.fontSize} -> ${after.text.fontSize}`);

  step = 'undo resize';
  await key('Control+z');
  const undone = pick(await objs());
  for (const k of ['rect', 'text']) for (const f of ['x', 'y', 'w', 'h']) check(undone[k][f] === before[k][f], `undo: ${k}.${f} ${undone[k][f]} !== ${before[k][f]}`);

  step = 'save and reopen';
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  const saved = await ev('return Array.from(await window.api.readFile(tab.path));');
  await ev('await app.openBytes({ name: "saved.pdf", bytes: new Uint8Array(arg) });', saved);
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.name === 'saved.pdf' && t.objects.length === 2 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await frames();
  ({ rect, text } = pick(await objs()));
  check(!!rect && !!text, 'reopened file lacks the rect or the text box');
  check(typeof rect.group === 'string' && rect.group !== '' && rect.group === text.group, `after reopen: groups ${rect.group} / ${text.group}`);

  step = 'ungroup';
  await ev('v.setZoom(tab, 1);');
  await frames();
  await key('v');
  const rc = pick(await objs()).rect;
  await page.mouse.click(...await toClient(0, rc.x + rc.w / 2, rc.y + rc.h / 2));
  check((await sel()).length === 2, 'reopened group not selected as one');
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+Shift+G');
  ({ rect, text } = pick(await objs()));
  check(!rect.group && !text.group, `ungroup left groups ${rect.group} / ${text.group}`);
  await key('Escape');
  const rc2 = pick(await objs()).rect;
  await page.mouse.click(...await toClient(0, rc2.x + rc2.w / 2, rc2.y + rc2.h / 2));
  check((await sel()).length === 1, `after ungroup a click selected ${(await sel()).length}, expected 1`);

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('GROUPING OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
