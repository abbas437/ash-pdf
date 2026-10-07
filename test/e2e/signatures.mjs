#!/usr/bin/env node
// End-to-end test of the signature foundations: renderer/ui/tools-stamp.js armImage (image plus
// companion objects placed as ONE undo step) and annotation groups in renderer/ui/annotations.js
// (a click selects the whole group, which moves, deletes and pastes together), then saves and
// checks the image reached the PDF. Prints "SIGNATURES OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';

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
const PNG = await solid(40, 20, { r: 0, g: 200, b: 0 }).png().toBuffer();

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
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const key = async (k) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(k); };
  const objs = () => ev('return tab.objects.map((o) => ({ ...o, bytes: o.bytes ? o.bytes.length : undefined }));');
  const toClient = (i, x, y) => ev('const c = v.pageToClient(tab, arg[0], arg[1], arg[2]); return [c.clientX, c.clientY];', [i, x, y]);
  const drag = async (a, b) => { await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(b[0], b[1], { steps: 6 }); await page.mouse.up(); };
  const pickFile = async (trigger, file) => { const fc = page.waitForEvent('filechooser'); await trigger(); await (await fc).setFiles(file); };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await pickFile(() => page.click('#btn-open'), { name: 'three.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 3 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await frames();

  // ------------------------------------------------------------ block: image + companions, one undo step
  step = 'arm block';
  const armed = await ev(`const { armImage } = await import('/renderer/ui/tools-stamp.js');
    return armImage(new Uint8Array(arg), { label: 'signature', width: 120, extra: { group: 'g-test' },
      companions: (img) => ['A. Example', '2026-10-07'].map((text, k) => ({ type: 'stamp', page: img.page, x: img.x, y: img.y + img.h + 4 + k * 26, w: img.w, h: 22, text, color: '#111111', rotation: 0, borderWidth: 0, group: 'g-test' })) });`, [...PNG]);
  check(armed === true, 'armImage did not arm');
  await page.mouse.click(...await toClient(0, 200, 300));
  let all = await objs();
  check(all.length === 3 && all.every((o) => o.group === 'g-test' && o.page === 0), `block objects ${JSON.stringify(all)}`);
  near(all[0].w, 120, 'block image width', 0.01); near(all[0].h, 60, 'block image aspect', 0.01);
  check(all[1].text === 'A. Example', 'name companion'); near(all[1].y, all[0].y + 64, 'name below image', 0.01);
  check(await ev('return tab.undo.length;') === 1, 'block is not one undo step');
  await key('Control+z');
  check((await objs()).length === 0, 'one undo did not remove the whole block');
  await key('Control+y');
  all = await objs();
  check(all.length === 3, 'redo did not restore the block');

  // ------------------------------------------------------------ group: select, move, delete together
  step = 'group move together';
  await ev('an.select(tab, []);');
  const img0 = all[0];
  await drag(await toClient(0, img0.x + img0.w / 2, img0.y + img0.h / 2), await toClient(0, img0.x + img0.w / 2 + 50, img0.y + img0.h / 2 + 30));
  const moved = await objs();
  const ddx = moved[0].x - all[0].x, ddy = moved[0].y - all[0].y;
  near(ddx, 50, 'dragged image moved x', 2);
  for (const [k, o] of moved.entries()) { near(o.x - all[k].x, ddx, `group member ${k} moved with the image (x)`, 0.01); near(o.y - all[k].y, ddy, `group member ${k} moved with the image (y)`, 0.01); }
  check((await ev('return an.getSelection(tab).length;')) === 3, 'clicking one member did not select the whole group');

  step = 'group paste regroups';
  await key('Control+c'); await key('Control+v');
  const pasted = (await objs()).slice(3);
  check(pasted.length === 3 && new Set(pasted.map((o) => o.group)).size === 1 && pasted[0].group !== 'g-test', `pasted copies not a new group ${JSON.stringify(pasted.map((o) => o.group))}`);
  await key('Control+z');

  step = 'shift-click deselects the group';
  await ev('an.select(tab, [tab.objects[0].id]);');
  check((await ev('return an.getSelection(tab).length;')) === 3, 'select() did not widen to the group');
  await page.keyboard.down('Shift');
  await page.mouse.click(...await toClient(0, moved[1].x + 10, moved[1].y + 11));
  await page.keyboard.up('Shift');
  check((await ev('return an.getSelection(tab).length;')) === 0, 'shift-click on a member left part of the group selected');

  step = 'group delete together';
  await ev('an.select(tab, [tab.objects[2].id]);');
  await key('Delete');
  check((await objs()).length === 0, 'Delete did not remove the whole group');
  await key('Control+z');

  // ------------------------------------------------------------ save
  step = 'save';
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  const out = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  const doc = await PDFDocument.load(out);
  // The signature image is saved as a /Stamp annotation whose appearance carries the image.
  const annots = doc.getPages()[0].node.Annots()?.asArray().map((r) => doc.context.lookup(r)) ?? [];
  check(annots.some((a) => a.get(PDFName.of('Subtype'))?.toString() === '/Stamp' && a.get(PDFName.of('AP'))), 'saved page 1 has no Stamp annotation with an appearance for the signature image');

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('SIGNATURES OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
