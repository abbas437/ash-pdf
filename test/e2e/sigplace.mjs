#!/usr/bin/env node
// End-to-end test of the Sign button (renderer/ui/sign.js) in Chromium via playwright-core: pick a
// saved signature from the Sign menu and place it, a locked item asks for its password, Place on
// pages 1-3 (page 3 a different size: centre scaled by the page size, one undo), Signature block
// (image + name + date in one group, moved together, one undo), save -> one /Stamp annotation per
// placed signature; Apply signature on the block (confirm; burned into the page content, no longer
// objects or selectable, ink in the page render, one page undo brings the group back at the same rect,
// redo burns it again, saved file: no annotation there, ink in the content); light and dark screenshots of the open menu with a contrast check.
// Prints "SIGPLACE OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName } from 'pdf-lib';

const sharp = createRequire(import.meta.url)('/opt/npm-tools/node_modules/sharp');
const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const SIZES = [[612, 792], [612, 792], [900, 600]];

async function makePdf() {
  const doc = await PDFDocument.create();
  for (const s of SIZES) doc.addPage(s);
  return Buffer.from(await doc.save());
}
const SIG = await sharp({ create: { width: 120, height: 40, channels: 4, background: { r: 26, g: 43, b: 109, alpha: 1 } } }).png().toBuffer();
const INI = await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 90, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();

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
const near = (a, b, msg, tol = 0.5) => check(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} (±${tol})`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const key = async (k) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(k); };
  const objs = () => ev('return tab.objects.map((o) => ({ ...o, bytes: o.bytes ? o.bytes.length : undefined }));');
  const sigs = async () => (await objs()).filter((o) => o.type === 'image' && o.sig);
  const toClient = (i, x, y) => ev('const c = v.pageToClient(tab, arg[0], arg[1], arg[2]); return [c.clientX, c.clientY];', [i, x, y]);
  const top = '.dialog-backdrop:last-child .dialog';
  // Dark pixels of page `i` of `bytes` rendered as page content only (pdf.js annotationMode 0) in [x0, y0, x1, y1].
  const ink = (bytes, i, [x0, y0, x1, y1]) => ev(`
    const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg.bytes) }).promise, S = 2;
    const pg = await d.getPage(arg.i + 1), vp = pg.getViewport({ scale: S });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: 0 }).promise;
    const [x0, y0, x1, y1] = arg.r.map((q) => Math.round(q * S));
    const D = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let n = 0; for (let k = 0; k < D.length; k += 4) if (D[k] < 120 && D[k + 1] < 120) n++;
    await d.loadingTask.destroy(); return n / (D.length / 4);`, { bytes, i, r: [x0, y0, x1, y1] });
  const tabBytes = () => ev('return Array.from(tab.bytes);');
  const openSign = async () => { if (await page.$eval('.sign-menu', (m) => m.hidden)) await page.click('#btn-sign'); await page.waitForSelector('.sign-menu:not([hidden]) .sign-manage'); };
  const placeAt = async (i, x, y) => {
    await page.waitForFunction(() => document.body.classList.contains('img-armed'));
    await ev('v.scrollToPage(tab, arg);', i); await frames();
    await page.mouse.click(...await toClient(i, x, y));
  };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const fc = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await fc).setFiles({ name: 'mixed.pdf', mimeType: 'application/pdf', buffer: await makePdf() });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 3 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);'); await frames();
  // Library: one plain signature (default) and one password-locked initials item.
  const ids = await ev(`const { encryptBytes } = await import('/src/core/siglib.js');
    await window.api.libraryPut('signature', 'sigA', { meta: { name: 'Ahmad', kind: 'signature', isDefault: true, order: 0 }, bytes: new Uint8Array(arg.sig) });
    const { lock, data } = await encryptBytes(new Uint8Array(arg.ini), 'open sesame');
    await window.api.libraryPut('signature', 'iniB', { meta: { name: 'AT', kind: 'initials', isDefault: true, order: 1, lock }, bytes: data });
    return ['sigA', 'iniB'];`, { sig: [...SIG], ini: [...INI] });

  step = 'pick and place';
  await openSign();
  check(JSON.stringify(await page.$$eval('.sign-menu .sign-pick', (bs) => bs.map((b) => b.dataset.id))) === JSON.stringify(ids), 'Sign menu items');
  check(/password/.test(await page.textContent(`.sign-pick[data-id="iniB"] .sign-meta`)), 'locked item not marked');
  await page.click('.sign-pick[data-id="sigA"]');
  check(await page.$eval('.sign-menu', (m) => m.hidden), 'menu stayed open after a pick');
  await placeAt(0, 300, 600);
  let all = await sigs();
  check(all.length === 1, `placed: ${all.length}`);
  const src = all[0];
  check(src.page === 0 && src.sig === 'sigA' && src.mime === 'image/png', `placed object ${JSON.stringify(src)}`);
  near(src.w, 612 * 0.25, 'width 25 %'); near(src.h, src.w / 3, 'aspect');
  near(src.x + src.w / 2, 300, 'centre x'); near(src.y + src.h / 2, 600, 'centre y');

  step = 'locked item';
  await openSign();
  await page.click('.sign-pick[data-id="iniB"]');
  await page.waitForSelector('.sigman-pw-wrap input[type=password]');
  await page.fill('.sigman-pw-wrap input[type=password]', 'wrong');
  await page.click('.sigman-pw-wrap .dialog-buttons button:text-is("Unlock")');
  await page.waitForFunction(() => /Incorrect password/.test(document.querySelector('.sigman-pw-wrap .sig-status')?.textContent ?? ''));
  check(!(await ev('return document.body.classList.contains("img-armed");')), 'armed before the right password');
  await page.fill('.sigman-pw-wrap input[type=password]', 'open sesame');
  await page.click('.sigman-pw-wrap .dialog-buttons button:text-is("Unlock")');
  await page.waitForFunction(() => document.body.classList.contains('img-armed'));
  await key('Escape');
  await page.waitForFunction(() => !document.body.classList.contains('img-armed'));
  check((await sigs()).length === 1, 'Esc placed the initials');

  step = 'place on pages';
  await ev('an.select(tab, [arg]); app.setTool?.("select");', src.id); await frames();
  await page.waitForSelector('.opt-sign-pages');
  await page.click('.opt-sign-pages');
  await page.waitForSelector(`${top} .sign-range`);
  await page.fill(`${top} .sign-range`, '1-3');
  check(await page.$eval(`${top} input[value="range"]`, (r) => r.checked), 'range radio not chosen');
  await page.click(`${top} .dialog-buttons button:text-is("Place")`);
  await page.waitForSelector('.sign-pages-wrap', { state: 'detached' });
  all = await sigs();
  check(all.length === 3 && JSON.stringify(all.map((o) => o.page).sort()) === '[0,1,2]', `place on pages: ${JSON.stringify(all.map((o) => o.page))}`);
  const [, c1, c2] = [0, 1, 2].map((p) => all.find((o) => o.page === p));
  check(c1.sig === 'sigA' && c2.sig === 'sigA', 'copies lost extra.sig');
  near(c1.x, src.x, 'page 2 x'); near(c1.y, src.y, 'page 2 y'); near(c1.w, src.w, 'page 2 w'); near(c1.h, src.h, 'page 2 h');
  near(c2.w, src.w, 'page 3 keeps width'); near(c2.h, src.h, 'page 3 keeps height');
  near(c2.x + c2.w / 2, 300 * 900 / 612, 'page 3 centre x scaled'); near(c2.y + c2.h / 2, 600 * 600 / 792, 'page 3 centre y scaled');
  await key('Control+z');
  all = await sigs();
  check(all.length === 1 && all[0].id === src.id, `one undo left ${all.length} signatures`);
  await key('Control+y');
  check((await sigs()).length === 3, 'redo did not restore the copies');

  step = 'signature block';
  await ev('an.select(tab, []);');
  await openSign();
  await page.click('.sign-menu .sign-block');
  await page.waitForSelector(`${top} .sign-block-name`);
  await page.fill(`${top} .sign-block-name`, 'Ahmad Test');
  await page.selectOption(`${top} .sign-block-sig`, 'sigA');
  await page.click(`${top} .dialog-buttons button:text-is("Place block")`);
  const n0 = (await objs()).length;
  await placeAt(0, 300, 200);
  let blk = (await objs()).slice(n0);
  check(blk.length === 3, `block: ${blk.length} objects`);
  const g = blk[0].group;
  check(g && blk.every((o) => o.group === g), `block group ${JSON.stringify(blk.map((o) => o.group))}`);
  check(blk[0].type === 'image' && blk[0].sig === 'sigA' && blk[1].text === 'Ahmad Test' && /\d/.test(blk[2].text), `block objects ${JSON.stringify(blk.map((o) => [o.type, o.text]))}`);
  check(blk[1].y >= blk[0].y + blk[0].h && blk[2].y > blk[1].y, 'block text not below the image');
  // Click the name line (selects the whole group), then drag the image.
  await ev('an.select(tab, []);'); await frames();
  await page.mouse.click(...await toClient(0, blk[1].x + 5, blk[1].y + blk[1].h / 2)); await frames();
  check((await ev('return an.getSelection(tab);')).length === 3, 'clicking one member did not select the block');
  const from = await toClient(0, blk[0].x + blk[0].w / 2, blk[0].y + blk[0].h / 2);
  await page.mouse.move(...from); await page.mouse.down();
  await page.mouse.move(from[0] + 40, from[1] + 30, { steps: 6 }); await page.mouse.up();
  const moved = (await objs()).slice(n0);
  const [p0, p1] = await ev('return [v.clientToPage(tab, ...arg[0]), v.clientToPage(tab, ...arg[1])];', [from, [from[0] + 40, from[1] + 30]]);
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  check(dx > 10 && dy > 10, `drag distance in page units ${dx},${dy}`);
  for (const [k, o] of moved.entries()) { near(o.x - blk[k].x, dx, `block member ${k} moved x`, 1); near(o.y - blk[k].y, dy, `block member ${k} moved y`, 1); }
  await key('Control+z');
  await key('Control+z');
  check((await objs()).length === n0, `one undo left ${(await objs()).length - n0} block objects`);
  await key('Control+y');
  blk = (await objs()).slice(n0);
  check(blk.length === 3, 'redo did not restore the block');

  step = 'apply signature';
  const rects = blk.map(({ id, x, y, w, h, group }) => ({ id, x, y, w, h, group }));
  const inner = [blk[0].x + 4, blk[0].y + 4, blk[0].x + blk[0].w - 4, blk[0].y + blk[0].h - 4];
  check(await ink(await tabBytes(), 0, inner) < 0.05, 'signature already in the page content before Apply');
  await ev('an.select(tab, []);'); await frames();
  await openSign();
  check(await page.$eval('.sign-menu .sign-apply', (b) => b.disabled), 'Apply signature enabled without a selection');
  await page.keyboard.press('Escape');
  await ev('an.select(tab, [arg]); app.setTool?.("select");', blk[1].id); await frames(); // a text member: the group counts
  await openSign();
  check(!(await page.$eval('.sign-menu .sign-apply', (b) => b.disabled)), 'Apply signature disabled with a block selected');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.opt-sign-apply');
  await page.click('.opt-sign-apply');
  await page.waitForSelector(`${top} .sign-apply-noask`);
  check(/can no longer be moved or edited/.test(await page.textContent(`${top} .sign-apply`)), 'confirm text');
  await page.click(`${top} .dialog-buttons button:text-is("Apply")`);
  const gone = () => page.waitForFunction((ids) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return ids.every((id) => !t.objects.some((o) => o.id === id)); }, rects.map((r) => r.id), { timeout: 10_000 });
  await gone();
  check((await objs()).length === n0, `apply left ${(await objs()).length - n0} block objects`);
  check(await ink(await tabBytes(), 0, inner) > 0.9, 'applied signature not in the page content');
  await ev('an.select(tab, []);'); await frames();
  await page.mouse.click(...await toClient(0, blk[0].x + blk[0].w / 2, blk[0].y + blk[0].h / 2)); await frames();
  check((await ev('return an.getSelection(tab);')).length === 0, 'something selectable at the applied signature');
  await key('Control+z');
  await page.waitForFunction((n) => window.ashStudio.state.tabs[0].objects.length === n, n0 + 3, { timeout: 10_000 });
  const back = (await objs()).slice(n0).map(({ id, x, y, w, h, group }) => ({ id, x, y, w, h, group }));
  check(JSON.stringify(back) === JSON.stringify(rects), `undo restored ${JSON.stringify(back)}, expected ${JSON.stringify(rects)}`);
  check(await ink(await tabBytes(), 0, inner) < 0.05, 'undo left the signature in the page content');
  await key('Control+y');
  await gone();
  check(await ink(await tabBytes(), 0, inner) > 0.9, 'redo did not apply the signature again');

  step = 'save';
  const final = await sigs();
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  const saved = await ev('return Array.from(await window.api.readFile(tab.path));');
  const doc = await PDFDocument.load(Uint8Array.from(saved));
  const stamps = doc.getPages().map((p) => (p.node.Annots()?.asArray() ?? []).map((r) => doc.context.lookup(r)).filter((a) => a.get(PDFName.of('Subtype'))?.toString() === '/Stamp').length);
  const want = [0, 1, 2].map((p) => final.filter((o) => o.page === p).length);
  check(JSON.stringify(stamps) === JSON.stringify(want), `/Stamp per page ${stamps}, expected ${want}`);
  // The applied block: no annotation over it, its ink in the page content of the saved file.
  const H = doc.getPage(0).getHeight(), bx0 = blk[0].x, by0 = blk[0].y, bx1 = bx0 + blk[0].w, by1 = Math.max(...rects.map((r) => r.y + r.h));
  const over = (doc.getPage(0).node.Annots()?.asArray() ?? []).map((r) => doc.context.lookup(r)).filter((a) => {
    const [x0, y0, x1, y1] = a.get(PDFName.of('Rect')).asArray().map((n) => n.asNumber());
    return x0 < bx1 && x1 > bx0 && H - y1 < by1 && H - y0 > by0;
  });
  check(!over.length, `${over.length} annotation(s) over the applied block in the saved file`);
  check(await ink(saved, 0, inner) > 0.9, 'applied signature not in the saved page content');

  step = 'apply after reopen';
  // A block saved as annotations, the file reopened: the reopened signature still offers Apply.
  await ev('an.select(tab, []);'); await frames();
  await openSign();
  await page.click('.sign-menu .sign-block');
  await page.waitForSelector(`${top} .sign-block-name`);
  await page.fill(`${top} .sign-block-name`, 'Reopen Test');
  await page.selectOption(`${top} .sign-block-sig`, 'sigA');
  await page.click(`${top} .dialog-buttons button:text-is("Place block")`);
  await placeAt(1, 200, 300);
  const rb = (await objs()).filter((o) => o.page === 1 && o.group);
  check(rb.length === 3, `reopen block: ${rb.length} objects`);
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab (reopen block) returned false');
  const keep = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  await ev('await app.openBytes({ name: "reopened.pdf", bytes: new Uint8Array(arg) });', Array.from(keep));
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.name === 'reopened.pdf'; }, null, { timeout: 10_000 });
  const re = (await objs()).filter((o) => o.page === 1 && o.type === 'image' && o.sig && o.group);
  check(re.length === 1 && re[0].sig === 'sigA' && re[0].group, `reopened signature lost sig/group ${JSON.stringify(re.map((o) => [o.sig, o.group]))}`);
  check((await objs()).filter((o) => o.group === re[0].group).length === 3, 'reopened block lost its members');
  await ev('an.select(tab, [arg]); app.setTool?.("select");', re[0].id); await frames();
  await openSign();
  check(!(await page.$eval('.sign-menu .sign-apply', (b) => b.disabled)), 'Apply signature disabled on a reopened signature');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.opt-sign-apply');
  await page.click('.opt-sign-apply');
  await page.waitForSelector(`${top} .sign-apply-noask`);
  await page.click(`${top} .dialog-buttons button:text-is("Apply")`);
  await page.waitForFunction((g) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return !t.objects.some((o) => o.group === g); }, re[0].group, { timeout: 10_000 });
  const rin = [re[0].x + 4, re[0].y + 4, re[0].x + re[0].w - 4, re[0].y + re[0].h - 4];
  check(await ink(await tabBytes(), 1, rin) > 0.9, 'reopened signature not applied to the page content');
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab after reopen-apply returned false');
  const after = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  const rdoc = await PDFDocument.load(after);
  const RH = rdoc.getPage(1).getHeight();
  const rover = (rdoc.getPage(1).node.Annots()?.asArray() ?? []).map((r) => rdoc.context.lookup(r)).filter((a) => {
    const [x0, y0, x1, y1] = a.get(PDFName.of('Rect')).asArray().map((n) => n.asNumber());
    return x0 < re[0].x + re[0].w && x1 > re[0].x && RH - y1 < re[0].y + re[0].h && RH - y0 > re[0].y;
  });
  check(!rover.length, `${rover.length} annotation(s) left over the applied reopened signature`);
  check(await ink(after, 1, rin) > 0.9, 'applied reopened signature not in the saved page content');

  step = 'screenshots';
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => window.ashStudio.setTheme(t, false), theme);
    await openSign();
    await page.waitForTimeout(100);
    await page.locator('.sign-menu').screenshot({ path: join(OUT, `sigplace-${theme}.png`) });
    const low = await page.evaluate(() => {
      const rgb = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
      const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bg = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length === 3 || c[3] > 0.5) return c; } return [255, 255, 255]; };
      const out = [];
      const els = document.querySelectorAll('.sign-menu .sign-item, .sign-menu .sign-name, .sign-menu .sign-meta, .sign-menu .sign-lock, .sign-menu .sign-note, .sign-menu .sign-empty');
      for (const el of els) {
        if (el.closest('button')?.disabled) continue;
        const a = lum(rgb(getComputedStyle(el).color)), b = lum(bg(el));
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (ratio < 4.5) out.push(`${el.className} ${ratio.toFixed(2)}`);
      }
      return [els.length, out];
    });
    check(low[0] >= 8, `${theme}: only ${low[0]} menu elements checked`);
    check(!low[1].length, `${theme}: low contrast ${low[1].join('; ')}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.sign-menu').hidden);
  }
  await page.evaluate(() => window.ashStudio.setTheme('light', false));

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('SIGPLACE OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
