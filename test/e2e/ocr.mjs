#!/usr/bin/env node
// E2E: Tools > Recognize text (OCR)… (renderer/ui/ocr.js) in Chromium with the browser shim and the vendored
// tesseract.js. Page 1 of the fixture is only a PNG of the words "ASH OCR test 2026 drawing number HV-101";
// page 2 is the same image plus real text. OCR of page 1 adds an invisible text layer whose "HV-101" lies where it
// was drawn; Undo removes it; OCR of all pages with "Skip pages that already contain text" leaves page 2 alone.
// Run `node scripts/vendor.js` first. Prints "OCR E2E OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.gz': 'application/gzip', '.svg': 'image/svg+xml', '.png': 'image/png' };

// The image: 2400 x 600 px, drawn at (36, 500) pt and 540 pt wide (0.225 pt per px).
const LINE = 'ASH OCR test 2026 drawing number HV-101', IMG = { x: 36, y: 500, w: 540, px: 2400, py: 600 };
const K = IMG.w / IMG.px, LEFT = 40, BASE = 330;
async function makePdf() {
  const c = createCanvas(IMG.px, IMG.py), ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, IMG.px, IMG.py);
  ctx.fillStyle = '#000000'; ctx.font = '84px sans-serif'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(LINE, LEFT, BASE);
  const hvPx = LEFT + ctx.measureText(LINE.slice(0, LINE.indexOf('HV-101'))).width;
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(new Uint8Array(c.toBuffer('image/png')));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 0; n < 2; n++) {
    const p = doc.addPage([612, 792]);
    p.drawImage(png, { x: IMG.x, y: IMG.y, width: IMG.w, height: IMG.py * K });
    if (n === 1) p.drawText('Existing text layer', { x: 72, y: 300, size: 14, font });
  }
  return { bytes: Buffer.from(await doc.save()), hv: [IMG.x + hvPx * K, IMG.y + (IMG.py - BASE) * K] };
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const problems = [];
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`console: ${m.text()}`); });
  // ocr.js probes the engine files and cancels each body once the status is known: those show as ERR_ABORTED.
  page.on('requestfailed', (r) => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  const S = 'const app = window.ashStudio, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  // Text items of every page of the tab's current bytes: [{page, str, x, y}].
  const textItems = () => ev(`
    const task = app.viewer.pdfjs.getDocument({ data: tab.bytes.slice(), isEvalSupported: false }), d = await task.promise;
    const out = [];
    for (let i = 1; i <= d.numPages; i++) for (const it of (await (await d.getPage(i)).getTextContent()).items) if (it.str.trim()) out.push({ page: i - 1, str: it.str, x: it.transform[4], y: it.transform[5] });
    await task.destroy();
    return out;`);
  const undos = () => ev('return tab.bytesUndo?.length ?? 0;');
  const runOcr = async (mode, skip) => {
    await page.locator('.menu-btn', { hasText: 'Tools' }).click();
    await page.locator('.menu-item[data-id="ocr"]').click();
    const dlg = page.locator('.ocr-dialog');
    await dlg.waitFor();
    await page.check(`#ocr-${mode}`);
    await (skip ? page.check('#ocr-skip') : page.uncheck('#ocr-skip'));
    const before = await undos();
    await dlg.locator('button[data-value="ok"]').click();
    await page.locator('.ocr-progress').waitFor({ timeout: 10000 });
    await page.locator('.ocr-progress').waitFor({ state: 'detached', timeout: 180000 });
    await page.waitForFunction((n) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return (t.bytesUndo?.length ?? 0) > n; }, before, { timeout: 10000 });
  };

  step = 'open the scanned fixture';
  const { bytes, hv } = await makePdf();
  await page.evaluate((b) => window.ashStudio.openBytes({ name: 'scan.pdf', bytes: new Uint8Array(b) }), [...bytes]);
  await page.waitForFunction(() => document.querySelector('.page[data-page-index="0"] canvas'));
  const original = await textItems();
  check(original.every((t) => t.page === 1) && original.length === 1, `fixture text: ${JSON.stringify(original)}`);

  step = 'Tools > Recognize text on page 1';
  await runOcr('current', true);
  let items = await textItems();
  const p1 = items.filter((t) => t.page === 0);
  const joined = p1.map((t) => t.str).join(' ');
  check(joined.includes('HV-101'), `page 1 text has no "HV-101": "${joined}"`);
  check(/drawing/i.test(joined), `page 1 text has no "drawing": "${joined}"`);
  const it = p1.find((t) => t.str.includes('HV-101'));
  check(Math.hypot(it.x - hv[0], it.y - hv[1]) <= 10, `"HV-101" at (${it.x.toFixed(1)}, ${it.y.toFixed(1)}), drawn at (${hv[0].toFixed(1)}, ${hv[1].toFixed(1)})`);
  check(await ev('return tab.dirty;'), 'tab not dirty after OCR');

  step = 'Undo removes the text layer';
  await ev('await app.pageTools.undo(tab);');
  items = await textItems();
  check(!items.some((t) => t.page === 0), `page 1 still has text after Undo: ${JSON.stringify(items)}`);

  step = 'all pages, skipping pages that already contain text';
  await runOcr('all', true);
  items = await textItems();
  check(items.filter((t) => t.page === 0).map((t) => t.str).join(' ').includes('HV-101'), 'page 1 not recognized in the all-pages run');
  const p2 = items.filter((t) => t.page === 1).map((t) => t.str);
  check(p2.length === 1 && p2[0] === 'Existing text layer', `page 2 was not skipped: ${JSON.stringify(p2)}`);

  step = 'scanned-document banner';
  const fullPage = async (withText) => { // one page the size of the image, which covers it entirely
    const c = createCanvas(IMG.px, IMG.py), ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, IMG.px, IMG.py);
    ctx.fillStyle = '#000000'; ctx.font = '84px sans-serif'; ctx.fillText(LINE, LEFT, BASE);
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(new Uint8Array(c.toBuffer('image/png')));
    const p = doc.addPage([IMG.w, IMG.py * K]);
    p.drawImage(png, { x: 0, y: 0, width: IMG.w, height: IMG.py * K });
    if (withText) p.drawText('Existing text layer', { x: 72, y: 20, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
    return [...(await doc.save())];
  };
  const bar = page.locator('.scan-bar');
  await page.evaluate((b) => window.ashStudio.openBytes({ name: 'text.pdf', bytes: new Uint8Array(b) }), await fullPage(true));
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 2);
  await page.waitForTimeout(1500);
  check(await bar.isHidden(), 'banner shown for a PDF with text');
  await page.evaluate((b) => window.ashStudio.openBytes({ name: 'scan2.pdf', bytes: new Uint8Array(b) }), await fullPage(false));
  await bar.waitFor({ state: 'visible', timeout: 10000 });
  check((await bar.innerText()).includes('This looks like a scanned document. Recognize text to make it searchable and copyable.'), 'banner text');
  const before2 = await undos();
  await bar.locator('.scan-bar-go').click();
  const dlg2 = page.locator('.ocr-dialog');
  await dlg2.waitFor();
  check(await page.isChecked('#ocr-all'), '"All pages" not preselected');
  await dlg2.locator('button[data-value="ok"]').click();
  await page.locator('.ocr-progress').waitFor({ timeout: 10000 });
  await page.locator('.ocr-progress').waitFor({ state: 'detached', timeout: 180000 });
  await page.waitForFunction((n) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return (t.bytesUndo?.length ?? 0) > n; }, before2, { timeout: 10000 });
  check((await textItems()).map((t) => t.str).join(' ').includes('HV-101'), 'banner OCR: no "HV-101"');
  check(await bar.isHidden(), 'banner still shown after Recognize text');

  step = 'Create PDF from images with "Make searchable"';
  const tabsBefore = await ev('return app.state.tabs.length;');
  await page.locator('.menu-btn', { hasText: 'File' }).click();
  await page.locator('.menu-item[data-id="images-to-pdf"]').click();
  const chooser = page.waitForEvent('filechooser');
  await page.click('#pt-img-add');
  await (await chooser).setFiles([{ name: 'scan.png', mimeType: 'image/png', buffer: Buffer.from(await (async () => { const c = createCanvas(IMG.px, IMG.py), ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, IMG.px, IMG.py); ctx.fillStyle = '#000'; ctx.font = '84px sans-serif'; ctx.fillText(LINE, LEFT, BASE); return c.toBuffer('image/png'); })()) }]);
  await page.waitForFunction(() => document.querySelectorAll('.pt-filelist li:not(.pt-empty)').length === 1);
  check(await page.isChecked('#pt-img-ocr'), '"Make searchable" not on by default');
  await page.click('.dialog button[data-value="ok"]');
  await page.locator('.ocr-progress').waitFor({ timeout: 20000 });
  await page.locator('.ocr-progress').waitFor({ state: 'detached', timeout: 180000 });
  check(await ev('return app.state.tabs.length;') === tabsBefore + 1, 'no new tab for the images PDF');
  await page.waitForFunction(() => { const a = window.ashStudio; return a.state.tabs.at(-1).name === 'scan.pdf' && (a.state.tabs.at(-1).bytesUndo?.length ?? 0) > 0; }, null, { timeout: 10000 });
  check((await textItems()).map((t) => t.str).join(' ').includes('HV-101'), 'images PDF: no "HV-101"');

  check(!problems.length, `console problems:\n${problems.join('\n')}`);
  console.log('OCR E2E OK');
} catch (err) {
  console.error(`OCR E2E FAILED at "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
