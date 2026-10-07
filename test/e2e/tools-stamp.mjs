#!/usr/bin/env node
// End-to-end test of the Stamp, Image and Signature tools (renderer/ui/tools-stamp.js) in
// Chromium via playwright-core: stamps by preset / custom text / with date (one undo), stamp
// geometry at 100 %, 150 %, view rotation 90 and on a /Rotate 90 page, PNG and JPEG placement
// (aspect, clamping, signature-based type check), signature pad + typed name -> settings ->
// placement, then saves through app.saveTab and checks the output with pdf.js (stamp text
// position, image pixels). Prints "TOOLS-STAMP OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { flattenAnnotations } from '../../src/core/annots.js';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

const sharp = createRequire(import.meta.url)('/opt/npm-tools/node_modules/sharp');
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
const solid = (w, h, c) => sharp({ create: { width: w, height: h, channels: 3, background: c } });
const PNG = await solid(2, 2, { r: 0, g: 200, b: 0 }).png().toBuffer();
const JPEG = await solid(40, 20, { r: 0, g: 0, b: 230 }).jpeg({ quality: 95 }).toBuffer();
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const key = async (k) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(k); };
  const objs = () => ev('return tab.objects.map((o) => ({ ...o, bytes: o.bytes ? o.bytes.length : undefined }));');
  const toClient = (i, x, y) => ev('const c = v.pageToClient(tab, arg[0], arg[1], arg[2]); return [c.clientX, c.clientY];', [i, x, y]);
  const toPage = (c) => ev('return v.clientToPage(tab, arg[0], arg[1]);', c);
  const drag = async (a, b) => { await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(b[0], b[1], { steps: 6 }); await page.mouse.up(); };
  const openTools = async () => { if (await page.$eval('.menu[aria-label="Tools"]', (l) => l.hidden)) await page.click('.menu-btn:text-is("Tools")'); };
  const menu = async (id) => { await openTools(); await page.click(`.menu-item[data-id="${id}"]`); };
  const pickFile = async (trigger, file) => { const fc = page.waitForEvent('filechooser'); await trigger(); await (await fc).setFiles(file); };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await pickFile(() => page.click('#btn-open'), { name: 'three.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 3 && a.viewer.getOverlaySvg(t, 1); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await frames();

  // ------------------------------------------------------------ preset stamp
  step = 'preset stamp';
  await key('s');
  check(await ev('return app.state.tool;') === 'stamp', 'S did not pick the Stamp tool');
  const presets = await page.$$eval('.opt-stamp-text option', (os) => os.map((o) => o.textContent));
  check(presets.includes('REVISE AND RESUBMIT') && presets.includes('APPROVED AS NOTED') && presets.at(-1) === 'Custom text…', `presets ${presets}`);
  await page.selectOption('.opt-stamp-text', 'REJECTED');
  await page.click('.opt-swatch[data-color="#d62828"]');
  await frames();
  await page.mouse.click(...await toClient(0, 300, 330));
  let o = (await objs()).at(-1);
  check(o.type === 'stamp' && o.text === 'REJECTED' && o.color === '#d62828' && o.borderWidth === 2 && o.page === 0, `preset stamp ${JSON.stringify(o)}`);
  near(o.x + o.w / 2, 300, 'click stamp centred x'); near(o.y + o.h / 2, 330, 'click stamp centred y');
  check(o.h > 20 && o.h < 40 && o.w > o.h * 3, `default stamp size ${o.w}x${o.h}`);
  check(await ev('return !!v.getOverlaySvg(tab, 0).querySelector(`[data-obj-id="${arg}"] text`);', o.id), 'stamp not rendered');
  check(JSON.stringify(await ev('return an.getSelection(tab);')) === JSON.stringify([o.id]), 'new stamp not selected');

  step = 'custom text';
  const dlg = page.waitForSelector('#stamp-custom');
  await page.selectOption('.opt-stamp-text', '__custom');
  await (await dlg).fill('Site copy');
  await page.click('.dialog-buttons button[data-value="ok"]');
  await page.waitForFunction(() => document.querySelector('.opt-stamp-text')?.value === 'SITE COPY');

  step = 'add date';
  await page.selectOption('.opt-stamp-text', 'APPROVED');
  await page.click('.opt-swatch[data-color="#1b7f3b"]');
  await page.check('.opt-stamp-date');
  let n0 = (await objs()).length;
  await drag(await toClient(0, 60, 420), await toClient(0, 260, 470));
  let all = await objs();
  check(all.length === n0 + 2, `add date: ${all.length - n0} objects`);
  const [main, dated] = all.slice(-2);
  check(main.text === 'APPROVED' && /^DATE: \d{4}-\d{2}-\d{2}$/.test(dated.text) && dated.color === '#1b7f3b' && dated.y >= main.y + main.h, `date stamp ${JSON.stringify(dated)}`);
  check((await ev('return an.getSelection(tab);')).length === 2, 'both stamps not selected');
  await key('Control+z');
  check((await objs()).length === n0, 'one undo did not remove both stamps');
  await page.uncheck('.opt-stamp-date');

  // ------------------------------------------------------------ geometry
  await page.selectOption('.opt-stamp-text', 'APPROVED AS NOTED');
  const SCEN = [
    { name: 'zoom 100%', pageIndex: 0, zoom: 1, rot: 0, a: [40, 40], b: [240, 90] },
    { name: 'zoom 150%', pageIndex: 0, zoom: 1.5, rot: 0, a: [40, 110], b: [260, 160] },
    { name: 'view rotation 90', pageIndex: 0, zoom: 1, rot: 90, a: [40, 180], b: [220, 230] },
    { name: '/Rotate 90 page', pageIndex: 1, zoom: 1, rot: 0, a: [60, 60], b: [300, 120] },
  ];
  for (const sc of SCEN) {
    step = `geometry (${sc.name})`;
    await ev('v.setZoom(tab, arg.zoom); if (tab.viewRotation !== arg.rot) v.rotateView(tab, arg.rot - tab.viewRotation); v.scrollToPage(tab, arg.pageIndex);', sc);
    await frames();
    const ca = await toClient(sc.pageIndex, ...sc.a), cb = await toClient(sc.pageIndex, ...sc.b);
    n0 = (await objs()).length;
    await drag(ca, cb);
    all = await objs();
    check(all.length === n0 + 1, `${sc.name}: count`);
    o = all.at(-1);
    const A = await toPage(ca), B = await toPage(cb);
    check(o.page === sc.pageIndex && A.pageIndex === sc.pageIndex, `${sc.name}: page ${o.page}`);
    near(o.x, Math.min(A.x, B.x), `${sc.name} x`); near(o.y, Math.min(A.y, B.y), `${sc.name} y`);
    near(o.w, Math.abs(B.x - A.x), `${sc.name} w`); near(o.h, Math.abs(B.y - A.y), `${sc.name} h`);
  }
  // 75 % keeps a whole page on screen for the placement clicks near the bottom edge.
  await ev('v.setZoom(tab, 0.75); if (tab.viewRotation) v.rotateView(tab, -tab.viewRotation); v.scrollToPage(tab, 0);');
  await frames();

  // ------------------------------------------------------------ images
  step = 'image rejected';
  await key('Escape');
  await pickFile(() => key('i'), { name: 'fake.png', mimeType: 'image/png', buffer: GIF });
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Only PNG and JPEG/.test(t.textContent)));
  check(!(await ev('return document.body.classList.contains("img-armed");')), 'GIF armed the image tool');
  n0 = (await objs()).length;
  await page.mouse.click(...await toClient(0, 300, 600));
  check((await objs()).length === n0, 'a rejected file was placed');

  step = 'png clamped';
  await pickFile(() => page.click('.opt-image-pick'), { name: 'green.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => document.body.classList.contains('img-armed'));
  await page.mouse.click(...await toClient(0, 600, 780));
  o = (await objs()).at(-1);
  check(o.type === 'image' && o.mime === 'image/png' && o.bytes === PNG.length, `png object ${JSON.stringify(o)}`);
  near(o.w, 612 * 0.4, 'png width 40%', 0.01); near(o.h, o.w, 'png aspect', 0.01);
  near(o.x + o.w, 612, 'png clamped right', 0.01); near(o.y + o.h, 792, 'png clamped bottom', 0.01);
  check(await ev('return app.state.tool;') === 'select', 'image placement did not return to Select');
  const pngObj = o;

  step = 'image corner resize keeps aspect';
  const nw = await toClient(0, o.x, o.y);
  await drag(nw, [nw[0] + 40, nw[1] + 10]);
  o = (await objs()).find((x) => x.id === pngObj.id);
  near(o.w / o.h, 1, 'resize aspect', 0.001); near(o.x + o.w, 612, 'resize anchored at se x', 0.01); check(o.w < pngObj.w - 5, `resize did nothing (${o.w})`);
  await key('Control+z');

  step = 'jpeg';
  await ev('v.scrollToPage(tab, 2);'); await frames();
  await pickFile(() => key('i'), { name: 'photo.JPG.bin', mimeType: 'application/octet-stream', buffer: JPEG });
  await page.waitForFunction(() => document.body.classList.contains('img-armed'));
  await page.mouse.click(...await toClient(2, 306, 300));
  o = (await objs()).at(-1);
  check(o.type === 'image' && o.mime === 'image/jpeg' && o.page === 2, `jpeg object ${JSON.stringify(o)}`);
  near(o.w, 244.8, 'jpeg width', 0.01); near(o.h, 122.4, 'jpeg aspect', 0.01); near(o.x + o.w / 2, 306, 'jpeg centred');
  await ev('v.scrollToPage(tab, 0);'); await frames();

  // ------------------------------------------------------------ signature
  step = 'signature menu disabled';
  await openTools();
  check(await page.$eval('.menu-item[data-id="signature-place"]', (b) => b.disabled), 'Place saved signature enabled without a signature');

  step = 'typed signature';
  await menu('signature-draw');
  await page.waitForSelector('.sig-pad');
  check(/not a cryptographic digital signature/.test(await page.textContent('.sig-note')), 'signature disclaimer missing');
  await page.fill('.sig-name', 'A. Example');
  await page.click('.sig-type');
  await page.click('.dialog-buttons button[data-value="save"]');
  await page.waitForSelector('.sig-pad', { state: 'detached' });
  const typed = await ev('return await window.api.settingsGet("signature");');
  check(typeof typed === 'string' && typed.startsWith('data:image/png'), 'typed signature not saved');

  step = 'drawn signature';
  await menu('signature-draw');
  const pad = await (await page.waitForSelector('.sig-pad')).boundingBox();
  await page.click('.dialog-buttons button[data-value="save"]');
  check(/empty/.test(await page.textContent('.sig-status')), 'empty pad was accepted');
  const P = (fx, fy) => [pad.x + pad.width * fx, pad.y + pad.height * fy];
  await page.mouse.move(...P(0.15, 0.7)); await page.mouse.down();
  for (const [fx, fy] of [[0.25, 0.3], [0.35, 0.75], [0.45, 0.35], [0.55, 0.7], [0.7, 0.4], [0.85, 0.55]]) await page.mouse.move(...P(fx, fy), { steps: 8 });
  await page.mouse.up();
  await page.click('.dialog-buttons button[data-value="save"]');
  await page.waitForSelector('.sig-pad', { state: 'detached' });
  const sig = await ev('return await window.api.settingsGet("signature");');
  check(typeof sig === 'string' && sig.startsWith('data:image/png') && sig !== typed, 'drawn signature not saved');
  const dims = await page.evaluate(async (u) => { const i = new Image(); i.src = u; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, sig);
  // Ink spans 70 % x 45 % of a 480x160 pad at 2x; cropped with 4 px padding.
  near(dims[0], 0.7 * 960 + 8, 'signature crop width', 12); near(dims[1], 0.45 * 320 + 8, 'signature crop height', 12);

  step = 'place signature';
  await menu('signature-place');
  await page.waitForFunction(() => document.body.classList.contains('img-armed'));
  await page.mouse.click(...await toClient(0, 200, 640));
  o = (await objs()).at(-1);
  check(o.type === 'image' && o.mime === 'image/png', 'signature not placed as PNG image');
  near(o.w, 612 * 0.25, 'signature width 25%', 0.01); near(o.h, o.w * dims[1] / dims[0], 'signature aspect', 0.5);

  step = 'screenshot';
  await ev('an.select(tab, []);');
  await page.mouse.move(5, 500);
  await frames();
  const box = await ev('const r = v.getPageEl(tab, 0).getBoundingClientRect(); return [r.left, r.top];');
  await page.screenshot({ path: join(OUT, 'tools-stamp.png'), clip: { x: box[0], y: Math.max(0, box[1]), width: 816, height: 1000 - Math.max(0, box[1]) } });

  // ------------------------------------------------------------ save + verify
  step = 'save';
  const final = await objs();
  check(await ev('return !document.querySelector(".st-annots").hidden && /\\d+ annotations/.test(document.querySelector(".st-annots").textContent);'), 'status-bar annotation count');
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  // Overlay objects are saved as PDF annotations: flatten them so the checks below see what they draw.
  const out = await flattenAnnotations(Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));')));
  check((await PDFDocument.load(out)).getPageCount() === 3, 'saved page count');

  step = 'verify output';
  const stamps = final.filter((x) => x.type === 'stamp');
  const img = { x: pngObj.x, y: pngObj.y, w: pngObj.w, h: pngObj.h };
  const res = await ev(`
    const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg.out) }).promise, found = [];
    for (const s of arg.stamps) {
      const pg = await d.getPage(s.page + 1), vp = pg.getViewport({ scale: 1 });
      const tc = await pg.getTextContent();
      const hits = tc.items.filter((it) => it.str === s.text).map((it) => {
        const [a, b] = it.transform, L = Math.hypot(a, b), size = Math.hypot(a, b);
        const p0 = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        const p1 = vp.convertToViewportPoint(it.transform[4] + it.width * a / L, it.transform[5] + it.width * b / L);
        return { mx: (p0[0] + p1[0]) / 2, my: (p0[1] + p1[1]) / 2, size };
      });
      found.push({ id: s.id, page: s.page, ex: s.x + s.w / 2, hits });
    }
    const S = 3, pg = await d.getPage(1), vp = pg.getViewport({ scale: S });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const green = (x, y) => { const D = ctx.getImageData(Math.round(x * S), Math.round(y * S), 1, 1).data; return D[0] < 40 && D[1] > 160 && D[2] < 40; };
    const r = arg.img, inside = [], outside = [];
    for (const fx of [0.05, 0.5, 0.95]) for (const fy of [0.05, 0.5, 0.95]) inside.push(green(r.x + r.w * fx, r.y + r.h * fy));
    outside.push(green(r.x - 4, r.y + r.h / 2), green(r.x + r.w / 2, r.y - 4));
    await d.loadingTask.destroy();
    return { found, inside, outside };`, { out: Array.from(out), stamps, img });
  for (const f of res.found) {
    const s = stamps.find((x) => x.id === f.id);
    const ok = f.hits.some((hh) => Math.abs(hh.mx - f.ex) <= 3 && Math.abs(hh.my - (s.y + s.h / 2 + 0.718 * hh.size / 2)) <= 3);
    check(ok, `stamp "${s.text}" on page ${s.page + 1} not extractable at its position: ${JSON.stringify(f.hits)} expected centre ${f.ex}`);
  }
  check(res.found.some((f) => f.page === 1), 'no stamp checked on the /Rotate 90 page');
  check(res.inside.every(Boolean) && !res.outside.some(Boolean), `image pixels inside ${res.inside} outside ${res.outside}`);

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('TOOLS-STAMP OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
