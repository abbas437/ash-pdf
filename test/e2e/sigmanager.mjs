#!/usr/bin/env node
// End-to-end test of the signature library manager (renderer/ui/signatures.js) in Chromium via
// playwright-core: migration of the old 'signature' setting, Tools > Manage signatures…, new
// items by Type, Draw, Import (background removed) and Paste, rename / default / reorder
// (persisted: listed again), password lock (wrong password refused, right one returns the PNG),
// delete; screenshots in light and dark with a contrast check. Prints "SIGMANAGER OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const sharp = createRequire(import.meta.url)('/opt/npm-tools/node_modules/sharp');
const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

// Old setting: a small dark-blue PNG. Import: white page with a dark ink bar (JPEG, so the white is not pure).
const OLD_PNG = await sharp({ create: { width: 30, height: 10, channels: 4, background: { r: 26, g: 43, b: 109, alpha: 1 } } }).png().toBuffer();
const SCAN = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 250, g: 250, b: 246 } } })
  .composite([{ input: await sharp({ create: { width: 120, height: 30, channels: 3, background: { r: 20, g: 20, b: 30 } } }).png().toBuffer(), left: 40, top: 35 }]).jpeg({ quality: 92 }).toBuffer();
const PASTE = await sharp({ create: { width: 60, height: 24, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await sharp({ create: { width: 40, height: 8, channels: 4, background: { r: 120, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(), left: 10, top: 8 }]).png().toBuffer();

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const AsyncFunction = (async () => {}).constructor;
  const lib = (body, arg) => page.evaluate(new AsyncFunction('arg', `const { signatureLibrary: L } = await import('/renderer/ui/signatures.js');\n${body}`), arg);
  const list = () => lib('return L.list();');
  const top = '.dialog-backdrop:last-child .dialog';
  const btn = (label) => page.click(`${top} .dialog-buttons button:text-is("${label}")`);
  const openTools = async () => { if (await page.$eval('.menu[aria-label="Tools"]', (l) => l.hidden)) await page.click('.menu-btn:text-is("Tools")'); };
  const pngInfo = (id) => lib(`const b = await L.getPng(arg); if (!b) return null;
    const bmp = await createImageBitmap(new Blob([b], { type: 'image/png' })); const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0);
    const px = (i, j) => [...x.getImageData(i, j, 1, 1).data];
    return { png: b[0] === 0x89 && b[1] === 0x50, w: bmp.width, h: bmp.height, corner: px(0, 0), centre: px(bmp.width >> 1, bmp.height >> 1) };`, id);

  step = 'migration';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.evaluate((u) => localStorage.setItem('ash-pdf-studio:signature', JSON.stringify(u)), `data:image/png;base64,${OLD_PNG.toString('base64')}`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await page.waitForFunction(() => localStorage.getItem('ash-pdf-studio:signature') === null, null, { timeout: 5_000 }).catch(() => {});
  let L = await list();
  check(L.length === 1 && L[0].name === 'My signature' && L[0].isDefault && L[0].kind === 'signature', `migration: ${JSON.stringify(L)}`);
  check(await page.evaluate(() => localStorage.getItem('ash-pdf-studio:signature')) === null, 'migration: old setting not deleted');
  const mig = await pngInfo(L[0].id);
  check(mig?.png && mig.w === 30 && mig.h === 10, `migrated bytes ${JSON.stringify(mig)}`);

  step = 'open manager';
  await openTools();
  await page.click('.menu-item[data-id="signature-manage"]');
  await page.waitForSelector('.sigman-wrap .sigman-item');
  check(/not a digital certificate/.test(await page.textContent('.sigman-wrap .sig-note')), 'visual-signature note missing');

  step = 'type';
  await page.click('.sigman-add-type');
  await page.fill(`${top} .sigman-typed`, 'Ahmad Test');
  await page.selectOption(`${top} .sigman-font`, 'Sig Great Vibes');
  await page.selectOption(`${top} .sigman-colour`, '#1a2b6d');
  await btn('Add to library');
  await page.waitForFunction(() => document.querySelectorAll('.sigman-item').length === 2);
  L = await list();
  const typed = L.find((x) => x.name === 'Ahmad Test');
  const ti = await pngInfo(typed.id);
  check(ti.w > 100 && ti.corner[3] === 0, `typed PNG ${JSON.stringify(ti)}`);

  step = 'draw';
  await page.click('.sigman-add-draw');
  const box = await page.locator(`${top} .sig-pad`).boundingBox();
  await page.mouse.move(box.x + 40, box.y + 60); await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 100, { steps: 8 }); await page.mouse.up();
  await page.fill(`${top} .sigman-new-name`, 'AT');
  await page.selectOption(`${top} .sigman-new-kind`, 'initials');
  await page.check(`${top} .sigman-bw`);
  await btn('Add to library');
  await page.waitForFunction(() => document.querySelectorAll('.sigman-item').length === 3);
  L = await list();
  const drawn = L.find((x) => x.name === 'AT');
  check(drawn.kind === 'initials' && drawn.isDefault, `drawn initials ${JSON.stringify(drawn)}`);
  const di = await pngInfo(drawn.id);
  check(di.centre[0] === 0 && di.centre[1] === 0 && di.centre[2] === 0 && di.centre[3] > 0, `black and white: ${JSON.stringify(di)}`);

  step = 'import';
  await page.click('.sigman-add-import');
  const fc = page.waitForEvent('filechooser');
  await page.click(`${top} .sigman-pick`);
  await (await fc).setFiles({ name: 'scan.jpg', mimeType: 'image/jpeg', buffer: SCAN });
  await page.waitForSelector(`${top} .sigman-pane.has-image`);
  await page.locator(`${top} .sigman-threshold`).fill('210');
  await page.fill(`${top} .sigman-new-name`, 'Scanned');
  await btn('Add to library');
  await page.waitForFunction(() => document.querySelectorAll('.sigman-item').length === 4);
  L = await list();
  const scanned = L.find((x) => x.name === 'Scanned');
  const si = await pngInfo(scanned.id);
  check(si.corner[3] === 0 && si.centre[3] === 255 && Math.abs(si.w - 128) <= 3 && Math.abs(si.h - 38) <= 3, `imported: background not removed / cropped ${JSON.stringify(si)}`);

  step = 'paste';
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'clip.png', { type: 'image/png' }));
    document.querySelector('.sigman-wrap .sigman-add-draw').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PASTE.toString('base64'));
  await page.waitForSelector(`${top} .sigman-tab[data-mode="paste"][aria-selected="true"]`);
  await page.waitForSelector(`${top} .sigman-pane.has-image`);
  await page.fill(`${top} .sigman-new-name`, 'Pasted');
  await btn('Add to library');
  await page.waitForFunction(() => document.querySelectorAll('.sigman-item').length === 5);
  L = await list();
  const pasted = L.find((x) => x.name === 'Pasted');
  const pi = await pngInfo(pasted.id);
  check(pi.w === 48 && pi.h === 16 && pi.centre[0] === 120, `pasted PNG ${JSON.stringify(pi)}`);

  step = 'rename, default, reorder';
  const item = (id) => `.sigman-item[data-id="${id}"]`;
  await page.fill(`${item(typed.id)} .sigman-name`, 'Ahmad (typed)');
  await page.press(`${item(typed.id)} .sigman-name`, 'Tab');
  await page.waitForFunction(() => [...document.querySelectorAll('.sigman-name')].some((i) => i.value === 'Ahmad (typed)' && i.isConnected));
  await page.click(`${item(typed.id)} .sigman-set-default`);
  await page.waitForSelector(`${item(typed.id)} .sigman-default`);
  await page.click(`${item(typed.id)} .sigman-up`);
  await page.waitForFunction((id) => document.querySelector('.sigman-item')?.dataset.id === id, typed.id);
  L = await list();
  check(L[0].id === typed.id && L[0].name === 'Ahmad (typed)' && L[0].isDefault, `after edit: ${JSON.stringify(L[0])}`);
  check(L.filter((x) => x.kind === 'signature' && x.isDefault).length === 1 && !L.find((x) => x.name === 'My signature').isDefault, 'only one default signature');
  check(L.find((x) => x.name === 'AT').isDefault, 'initials default kept');
  check(L.map((x) => x.order).join() === '0,1,2,3,4', `orders ${L.map((x) => x.order)}`);

  step = 'lock';
  await page.click(`${item(scanned.id)} .sigman-lock`);
  await page.fill(`${top} .sigman-pw1`, 'open sesame');
  await page.fill(`${top} .sigman-pw2`, 'open sesame');
  await btn('Lock');
  await page.waitForSelector(`${item(scanned.id)} .sigman-locked`);
  const stored = await page.evaluate(async (id) => { const r = await window.api.libraryGet('signature', id); return { png: r.bytes[0] === 0x89 && r.bytes[1] === 0x50, lock: !!r.meta.lock }; }, scanned.id);
  check(!stored.png && stored.lock, `stored encrypted: ${JSON.stringify(stored)}`);
  await page.click('.sigman-wrap .dialog-buttons button:text-is("Close")');
  const got = page.evaluate(async (id) => { const { signatureLibrary: L } = await import('/renderer/ui/signatures.js'); const b = await L.getPng(id); return b && [b.length, b[0], b[1]]; }, scanned.id);
  await page.waitForSelector('.sigman-pw-wrap input[type=password]');
  await page.fill('.sigman-pw-wrap input[type=password]', 'wrong');
  await page.click('.sigman-pw-wrap .dialog-buttons button:text-is("Unlock")');
  await page.waitForFunction(() => /Incorrect password/.test(document.querySelector('.sigman-pw-wrap .sig-status')?.textContent ?? ''));
  check(await page.isVisible('.sigman-pw-wrap'), 'wrong password closed the dialog');
  await page.fill('.sigman-pw-wrap input[type=password]', 'open sesame');
  await page.click('.sigman-pw-wrap .dialog-buttons button:text-is("Unlock")');
  const r = await got;
  check(r && r[0] > 8 && r[1] === 0x89 && r[2] === 0x50, `unlocked bytes ${JSON.stringify(r)}`);
  check((await pngInfo(scanned.id))?.w === si.w, 'unlocked item not remembered for the session');

  step = 'delete';
  await openTools();
  await page.click('.menu-item[data-id="signature-manage"]');
  await page.waitForSelector(`${item(pasted.id)}`);
  await page.click(`${item(pasted.id)} .sigman-delete`);
  await btn('Delete');
  await page.waitForFunction(() => document.querySelectorAll('.sigman-item').length === 4);
  L = await list();
  check(!L.some((x) => x.id === pasted.id) && L.map((x) => x.order).join() === '0,1,2,3', `after delete ${JSON.stringify(L)}`);

  step = 'screenshots';
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => window.ashStudio.setTheme(t, false), theme);
    await page.waitForTimeout(100);
    await page.locator('.sigman-wrap').screenshot({ path: join(OUT, `sigmanager-${theme}.png`) });
    const low = await page.evaluate(() => {
      const rgb = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
      const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bg = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length === 3 || c[3] > 0.5) return c; } return [255, 255, 255]; };
      const out = [];
      for (const el of document.querySelectorAll('.sigman-wrap .sig-note, .sigman-wrap .sigman-name, .sigman-wrap .sigman-kind, .sigman-wrap .btn, .sigman-wrap .sigman-default, .sigman-wrap .sigman-locked, .sigman-wrap .dialog-title, .sigman-wrap .sigman-add > span')) {
        if (el.disabled) continue;
        const a = lum(rgb(getComputedStyle(el).color)), b = lum(bg(el));
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (ratio < 4.5) out.push(`${el.className} ${ratio.toFixed(2)}`);
      }
      return out;
    });
    check(!low.length, `${theme}: low contrast ${low.join('; ')}`);
  }
  await page.evaluate(() => window.ashStudio.setTheme('light', false));

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('SIGMANAGER OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
