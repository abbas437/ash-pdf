#!/usr/bin/env node
// End-to-end test of Document > Word count and View > Snapshot (renderer/ui/viewextras.js) in
// Chromium via playwright-core, served over HTTP with the browser shim. Prints "SNAPWC OK".
// Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

// Two 612 x 792 pages with known text. Page 1 also has a yellow square covering page space
// (top-left origin) x 300..500, y 400..600.
const TEXT = ['The quick brown fox jumps', 'Hello world again'];
async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [n, text] of TEXT.entries()) {
    const page = doc.addPage([612, 792]);
    page.drawText(text, { x: 72, y: 720, size: 18, font });
    if (n === 0) page.drawRectangle({ x: 300, y: 792 - 600, width: 200, height: 200, color: rgb(1, 0.8, 0) });
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

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const colour = ([r, g, b]) => (r > 230 && g > 180 && g < 230 && b < 60 ? 'yellow' : g > 200 && r < 80 && b < 80 ? 'green' : r > 230 && g > 230 && b > 230 ? 'white' : `other(${r},${g},${b})`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const menu = async (name, id) => { await page.click(`.menu-btn:text-is("${name}")`); await page.click(`.menu-item[data-id="${id}"]`); };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'snap.pdf', mimeType: 'application/pdf', buffer: await makePdf() });
  await page.waitForFunction(() => window.ashStudio.state.tabs[0]?.numPages === 2);

  step = 'menus: Snapshot in View, Word count in Document, both before Help';
  eq(await page.$$eval('.menu-btn', (b) => b.map((x) => x.textContent).slice(-1)), ['Help'], 'Help is last');
  check(await page.$('.menu[aria-label="View"] .menu-item[data-id="snapshot"]'), 'View > Snapshot… missing');
  check(await page.$('.menu[aria-label="Document"] .menu-item[data-id="word-count"]'), 'Document > Word count… missing');

  step = 'word count: document and current page';
  await menu('Document', 'word-count');
  await page.waitForSelector('.vx-wc-dialog');
  const cells = await page.$$eval('.vx-wc-table tbody tr', (rows) => Object.fromEntries(rows.map((r) => [r.dataset.stat, [...r.querySelectorAll('td')].map((td) => td.textContent)])));
  // page 1: 5 words, 25 chars, 21 without spaces; page 2: 3 words, 17 chars, 15 without spaces
  eq(cells, { words: ['8', '5'], chars: ['42', '25'], charsNoSpaces: ['36', '21'] }, 'word count table');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.vx-wc-dialog', { state: 'detached' });

  // Actual size, page 1 at the top; an unsaved green overlay square inside the snapshot area.
  await page.evaluate(() => { const app = window.ashStudio, t = app.state.tabs[0]; app.viewer.setZoom(t, 1); app.viewer.scrollToPage(t, 0);
    t.objects = [...(t.objects ?? []), { id: 'snap-test', page: 0, type: 'rect', x: 330, y: 455, w: 20, h: 20, fill: '#00ff00', stroke: null }]; });
  await page.waitForTimeout(300);
  const client = (x, y) => page.evaluate(([px, py]) => { const app = window.ashStudio; return app.viewer.pageToClient(app.state.tabs[0], 0, px, py); }, [x, y]);
  const drag = async ([x0, y0], [x1, y1]) => {
    const a = await client(x0, y0), b = await client(x1, y1);
    await page.mouse.move(a.clientX, a.clientY); await page.mouse.down();
    await page.mouse.move((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    await page.mouse.move(b.clientX, b.clientY); await page.mouse.up();
  };

  step = 'snapshot: Esc cancels the selection';
  await menu('View', 'snapshot');
  await page.waitForSelector('.vx-snap-hint');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.vx-snap-hint', { state: 'detached' });
  check(!(await page.$('.vx-snap-dialog')), 'no dialog after Esc');
  check(!(await page.$('.vx-snapping')), 'crosshair mode left after Esc');

  step = 'snapshot: drag 100 x 50 pt';
  await menu('View', 'snapshot');
  await page.waitForSelector('.vx-snap-hint');
  await drag([320, 450], [420, 500]);
  await page.waitForSelector('.vx-snap-dialog img.vx-snap-img');
  eq(await page.evaluate(() => window.ashStudio.state.tabs[0].objects.length), 1, 'snapshot does not change the overlay objects');

  step = 'snapshot: Save as PNG';
  const dl = page.waitForEvent('download');
  await page.click('.vx-snap-dialog [data-value="save"]');
  const download = await dl;
  eq(download.suggestedFilename(), 'snap-p1-snapshot.png', 'file name');
  const png = await readFile(await download.path());
  const decoded = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height); const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
    const px = (x, y) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
    return { size: [bmp.width, bmp.height], centre: px(100, 50), overlay: px(20, 20), right: px(190, 90) };
  }, png.toString('base64'));
  eq(decoded.size, [200, 100], 'saved PNG size (2x of 100 x 50 pt)');
  eq(await page.$eval('.vx-snap-img', (i) => [i.naturalWidth, i.naturalHeight]), [200, 100], 'preview size');
  eq(colour(decoded.centre), 'yellow', 'centre pixel is the page colour');
  eq(colour(decoded.overlay), 'green', 'overlay rectangle burnt into the snapshot');
  eq(colour(decoded.right), 'yellow', 'outside the overlay stays page colour');
  step = 'snapshot: Copy puts an <img> and text on the clipboard';
  await page.evaluate(() => { window.__copied = null; window.addEventListener('copy', (e) => { window.__copied = { html: e.clipboardData.getData('text/html'), text: e.clipboardData.getData('text/plain') }; }); });
  await page.click('.vx-snap-dialog [data-value="copy"]');
  const copied = await page.evaluate(() => window.__copied);
  check(copied && copied.html.startsWith('<img src="data:image/png;base64,'), `copied html: ${copied?.html?.slice(0, 40)}`);
  eq(copied.text, 'Snapshot of page 1, 200 × 100 px', 'copied text');
  check(await page.$('.vx-snap-dialog'), 'dialog stays open after Copy');

  await page.click('.vx-snap-dialog [data-value="close"]');
  await page.waitForSelector('.vx-snap-dialog', { state: 'detached' });

  step = 'dark theme styles the dialog with the theme variables';
  await page.evaluate(() => window.ashStudio.setTheme('dark', false));
  await menu('Document', 'word-count');
  await page.waitForSelector('.vx-wc-dialog');
  const bg = await page.$eval('.vx-wc-dialog', (d) => getComputedStyle(d).backgroundColor);
  eq(bg, 'rgb(31, 42, 37)', 'dark dialog surface');
  await page.keyboard.press('Escape');

  if (problems.length) throw new Error(`page problems:\n${problems.join('\n')}`);
  console.log('SNAPWC OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
