#!/usr/bin/env node
// End-to-end test of the Stamp, Image and Signature tools (renderer/ui/tools-stamp.js) in
// Chromium via playwright-core: stamps by preset / custom text / with date (one undo), stamp
// geometry at 100 %, 150 %, view rotation 90 and on a /Rotate 90 page, PNG and JPEG placement
// (aspect, clamping, signature-based type check), signature drawn through Sign > Manage
// signatures… > Draw… -> library -> placement from the Sign menu, then saves through
// app.saveTab and checks the output with pdf.js (stamp text position, image pixels). Prints "TOOLS-STAMP OK".
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
// White background with a red block: after background removal the corner must be transparent.
const STAMPPNG = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .composite([{ input: await solid(20, 20, { r: 200, g: 0, b: 0 }).png().toBuffer(), left: 20, top: 10 }]).png().toBuffer();
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
  const pickStamp = async (cat, id) => {
    if (!(await page.$('.stamp-palette'))) await page.click('.opt-stamp-pick');
    await page.click(`.stamp-cat[data-cat="${cat}"]`);
    await page.click(`.stamp-palette .stamp-item[data-id="${id}"]`);
    await page.waitForSelector('.stamp-palette', { state: 'detached' });
  };
  await page.click('.opt-stamp-pick');
  const presets = await page.$$eval('.stamp-palette .stamp-item', (os) => os.map((o) => o.title));
  for (const t of ['APPROVED', 'NOT APPROVED', 'REVISE AND RESUBMIT', 'APPROVED AS NOTED', 'CONFIDENTIAL', 'SIGN HERE', 'WITNESS', 'PAID']) check(presets.includes(t), `standard stamps ${presets}`);
  check(await page.$$eval('.stamp-palette .stamp-preview text', (t) => t.length) >= 18, 'palette previews not drawn');
  // Palette legibility in both themes: stamp ink on its paper, labels on their tile (WCAG contrast >= 4.5).
  for (const theme of ['light', 'dark']) {
    step = `palette ${theme}`;
    await ev('document.documentElement.dataset.theme = arg;', theme);
    for (const cat of ['standard', 'dynamic']) {
      await page.click(`.stamp-cat[data-cat="${cat}"]`);
      const worst = await page.evaluate(() => {
        const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
        const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
        let min = 99;
        for (const it of document.querySelectorAll('.stamp-palette .stamp-item')) {
          const paper = getComputedStyle(it.querySelector('.stamp-preview')).backgroundColor, tile = getComputedStyle(it).backgroundColor;
          min = Math.min(min, ratio(it.querySelector('.stamp-preview text').getAttribute('fill').replace(/^#(..)(..)(..)$/, (_, r, g, b) => `rgb(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)})`), paper), ratio(getComputedStyle(it.querySelector('.stamp-label')).color, tile));
        }
        return min;
      });
      check(worst >= 4.5, `${theme} ${cat} palette contrast ${worst.toFixed(2)} < 4.5`);
    }
    const pb = await (await page.$('.stamp-palette')).boundingBox();
    await page.screenshot({ path: join(OUT, `stamp-palette-${theme}.png`), clip: { x: pb.x - 8, y: pb.y - 50, width: pb.width + 16, height: pb.height + 58 } });
  }
  await ev('document.documentElement.dataset.theme = "light";');
  step = 'preset stamp';
  await page.click('.stamp-cat[data-cat="standard"]');
  await page.click('.stamp-palette .stamp-item[data-id="std-rejected"]');
  await page.waitForSelector('.stamp-palette', { state: 'detached' });
  await page.click('.opt-swatch[data-color="#d62828"]');
  await frames();
  await page.mouse.click(...await toClient(0, 300, 330));
  await frames();
  let o = (await objs()).at(-1);
  check(o.type === 'stamp' && o.text === 'REJECTED' && o.color === '#d62828' && o.borderWidth === 3 && o.page === 0 && !o.subtext, `preset stamp ${JSON.stringify(o)}`);
  near(o.x + o.w / 2, 300, 'click stamp centred x'); near(o.y + o.h / 2, 330, 'click stamp centred y');
  check(o.h > 20 && o.h < 40 && o.w > o.h * 3, `default stamp size ${o.w}x${o.h}`);
  check(await ev('return !!v.getOverlaySvg(tab, 0).querySelector(`[data-obj-id="${arg}"] text`);', o.id), 'stamp not rendered');
  check(JSON.stringify(await ev('return an.getSelection(tab);')) === JSON.stringify([o.id]), 'new stamp not selected');
  check(await ev('return await window.api.settingsGet("stamps.last");') === 'std-rejected', 'last used stamp not remembered');

  step = 'dynamic stamp';
  await ev('await window.api.settingsSet("annotations.author", "A. Example");');
  await page.click('.opt-stamp-pick');
  await page.click('.stamp-cat[data-cat="dynamic"]');
  await page.selectOption('.stamp-dyn-format', 'DD/MM/YYYY');
  await page.check('.stamp-dyn-time');
  await page.click('.stamp-palette .stamp-item[data-id="dyn-approved"]');
  await page.mouse.click(...await toClient(0, 300, 260));
  await page.waitForFunction(() => window.ashStudio.state.tabs[0].objects.at(-1)?.subtext);
  o = (await objs()).at(-1);
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  check(o.text === 'APPROVED' && o.subtext.startsWith(`by A. Example · ${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} `) && /\d\d:\d\d$/.test(o.subtext), `dynamic stamp ${JSON.stringify(o)}`);
  check(await ev('return v.getOverlaySvg(tab, 0).querySelectorAll(`[data-obj-id="${arg}"] text`).length;', o.id) === 2, 'dynamic stamp second line not drawn');
  const dynId = o.id;

  step = 'custom text';
  await page.click('.opt-stamp-pick');
  await page.click('.stamp-cat[data-cat="custom"]');
  const dlg = page.waitForSelector('#stamp-new-text');
  await page.click('.stamp-create');
  await (await dlg).fill('Site copy');
  await page.selectOption('.stamp-new-colour', '#1d4ed8');
  await page.click('.dialog-buttons button[data-value="ok"]');
  await page.waitForSelector('.stamp-palette .stamp-item[title="SITE COPY"]');
  const libList = await ev('return await window.api.libraryList("stamp");');
  check(libList.length === 1 && libList[0].meta.text === 'SITE COPY' && libList[0].meta.color === '#1d4ed8', `custom stamps persist: ${JSON.stringify(libList)}`);
  await page.click('.stamp-palette .stamp-item[title="SITE COPY"]');
  await page.mouse.click(...await toClient(0, 300, 200));
  await frames();
  o = (await objs()).at(-1);
  check(o.text === 'SITE COPY' && o.color === '#1d4ed8', `custom stamp ${JSON.stringify(o)}`);
  step = 'custom rename/delete';
  await page.click('.opt-stamp-pick'); await page.click('.stamp-cat[data-cat="custom"]');
  const rn = page.waitForSelector('#stamp-new-text');
  await page.click('.stamp-rename');
  await (await rn).fill('Site copy 2');
  await page.click('.dialog-buttons button[data-value="ok"]');
  await page.waitForSelector('.stamp-palette .stamp-item[title="SITE COPY 2"]');
  check((await ev('return await window.api.libraryList("stamp");')).length === 1, 'rename duplicated the item');
  await page.click('.stamp-delete');
  await page.waitForSelector('.stamp-palette .stamp-item[title="SITE COPY 2"]', { state: 'detached' });
  check((await ev('return await window.api.libraryList("stamp");')).length === 0, 'delete left the item');
  await page.click('.stamp-cat[data-cat="standard"]');
  await page.click('.stamp-palette .stamp-item[data-id="std-approved"]');

  step = 'image stamp';
  await page.click('.opt-stamp-pick');
  await page.click('.stamp-cat[data-cat="custom"]');
  await page.click('.stamp-create-image');
  await pickFile(() => page.click('.stamp-img-pick'), { name: 'logo.png', mimeType: 'image/png', buffer: STAMPPNG });
  await page.waitForFunction(() => document.querySelector('.stamp-img-preview')?.width === 60);
  check(await page.$eval('#stamp-img-name', (i) => i.value) === 'logo', 'image stamp name not defaulted from the file');
  await page.fill('#stamp-img-name', 'Logo stamp');
  await page.click('.dialog-buttons button[data-value="ok"]');
  await page.waitForFunction(() => document.body.classList.contains('img-armed'));
  const imgLib = await ev('return await window.api.libraryList("stamp");');
  check(imgLib.length === 1 && imgLib[0].meta.kind === 'image' && imgLib[0].meta.name === 'Logo stamp', `image stamp persists: ${JSON.stringify(imgLib)}`);
  const px = await ev(`const it = await window.api.libraryGet("stamp", arg); const bmp = await createImageBitmap(new Blob([it.bytes], { type: 'image/png' }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    return { corner: [...x.getImageData(0, 0, 1, 1).data], centre: [...x.getImageData(30, 20, 1, 1).data] };`, imgLib[0].id);
  check(px.corner[3] === 0, `background not removed: corner ${px.corner}`);
  check(px.centre[3] === 255 && px.centre[0] > 150 && px.centre[1] < 60, `image stamp content lost: ${px.centre}`);
  await page.mouse.click(...await toClient(0, 150, 500));
  await frames();
  o = (await objs()).at(-1);
  check(o.type === 'image' && o.mime === 'image/png' && o.page === 0, `image stamp placed ${JSON.stringify(o)}`);
  near(o.w, 153, 'image stamp width 25%', 0.01);
  const imgStamp = o;
  await key('s');
  await page.click('.opt-stamp-pick');
  await page.click('.stamp-cat[data-cat="custom"]');
  check(await page.$('.stamp-palette .stamp-item[title="Logo stamp"] img.stamp-preview'), 'image stamp preview missing');

  step = 'add date';
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
  await pickStamp('standard', 'std-approved-as-noted');
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
  const top = '.dialog-backdrop:last-child .dialog';
  const openSign = async () => { if (await page.$eval('.sign-menu', (m) => m.hidden)) await page.click('#btn-sign'); await page.waitForSelector('.sign-menu:not([hidden])'); };
  step = 'sign menu empty';
  await openSign();
  check(!(await page.$('.sign-menu .sign-pick')) && await page.isVisible('.sign-menu .sign-empty'), 'Sign menu lists a signature before any was saved');
  check(await page.$eval('.sign-menu .sign-block', (b) => b.disabled), 'Signature block enabled without a signature');
  check(/not digital certificates/.test(await page.textContent('.sign-menu .sign-note')), 'Sign menu disclaimer missing');

  step = 'drawn signature';
  await page.click('.sign-menu .sign-manage');
  await page.click('.sigman-wrap .sigman-add-draw');
  const pad = await (await page.waitForSelector(`${top} .sig-pad`)).boundingBox();
  check(/not a digital certificate/.test(await page.textContent(`${top} .sig-note`)), 'signature disclaimer missing');
  await page.click(`${top} .dialog-buttons button:text-is("Add to library")`);
  check(/empty/.test(await page.textContent(`${top} .sig-status`)), 'empty pad was accepted');
  const P = (fx, fy) => [pad.x + pad.width * fx, pad.y + pad.height * fy];
  await page.mouse.move(...P(0.15, 0.7)); await page.mouse.down();
  for (const [fx, fy] of [[0.25, 0.3], [0.35, 0.75], [0.45, 0.35], [0.55, 0.7], [0.7, 0.4], [0.85, 0.55]]) await page.mouse.move(...P(fx, fy), { steps: 8 });
  await page.mouse.up();
  await page.fill(`${top} .sigman-new-name`, 'A. Example');
  await page.click(`${top} .dialog-buttons button:text-is("Add to library")`);
  await page.waitForSelector('.sig-pad', { state: 'detached' });
  await page.waitForSelector('.sigman-wrap .sigman-item');
  await page.click('.sigman-wrap .dialog-buttons button:text-is("Close")');
  await page.waitForSelector('.sigman-wrap', { state: 'detached' });
  const lib = await ev('const { signatureLibrary: L } = await import("/renderer/ui/signatures.js"); return L.list();');
  check(lib.length === 1 && lib[0].name === 'A. Example' && lib[0].kind === 'signature', `library after Draw: ${JSON.stringify(lib)}`);
  const dims = await ev(`const { signatureLibrary: L } = await import("/renderer/ui/signatures.js"); const b = await L.getPng(arg);
    const bmp = await createImageBitmap(new Blob([b], { type: 'image/png' })); return [bmp.width, bmp.height];`, lib[0].id);
  // Ink spans 70 % x 45 % of a 480x160 pad at 2x; cropped with 4 px padding.
  near(dims[0], 0.7 * 960 + 8, 'signature crop width', 12); near(dims[1], 0.45 * 320 + 8, 'signature crop height', 12);

  step = 'place signature';
  await openSign();
  await page.click(`.sign-menu .sign-pick[data-id="${lib[0].id}"]`);
  await page.waitForFunction(() => document.body.classList.contains('img-armed'));
  await page.mouse.click(...await toClient(0, 200, 640));
  o = (await objs()).at(-1);
  check(o.type === 'image' && o.mime === 'image/png' && o.sig === lib[0].id, 'signature not placed as PNG image');
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
  const stamps = final.filter((x) => x.type === 'stamp' && !x.subtext);
  const saved = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  const ann = await ev(`const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg) }).promise; const a = await (await d.getPage(1)).getAnnotations(); await d.loadingTask.destroy();
    return a.filter((x) => x.subtype === 'Stamp').map((x) => ({ id: x.id, has: !!x.hasAppearance, c: x.contentsObj?.str, rect: x.rect }));`, Array.from(saved));
  check(ann.length >= 3 && ann.every((x) => x.has), `saved Stamp annotations ${JSON.stringify(ann)}`);
  const cx = imgStamp.x + imgStamp.w / 2, cy = 792 - (imgStamp.y + imgStamp.h / 2);
  check(ann.some((x) => x.has && Math.abs((x.rect[0] + x.rect[2]) / 2 - cx) < 2 && Math.abs((x.rect[1] + x.rect[3]) / 2 - cy) < 2), `image stamp not saved as a Stamp with an appearance: ${JSON.stringify(ann)}`);
  const rd = (await (await import('../../src/core/annots.js')).readAnnotations(saved)).objects.find((x) => x.id === dynId);
  check(rd?.subtext === final.find((x) => x.id === dynId).subtext, `dynamic subtext not saved: ${JSON.stringify(rd)}`);
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
