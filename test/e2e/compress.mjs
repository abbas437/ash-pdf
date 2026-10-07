#!/usr/bin/env node
// E2E: File > Reduce file size… (renderer/ui/compress.js) in Chromium with the browser shim.
// A letter page holding a 2000x2000 noisy JPEG is reduced with the Balanced preset: the dialog reports
// a smaller size, "Save as…" downloads the reduced copy, which loads in pdf-lib with a downsampled image.
// A digitally signed PDF is refused. Run `node scripts/vendor.js` first. Prints "COMPRESS E2E OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { makeSignedPdf } from '../helpers.js';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePhotoPdf() {
  const w = 2000, c = createCanvas(w, w), ctx = c.getContext('2d'), id = ctx.createImageData(w, w);
  let seed = 7;
  for (let i = 0; i < w * w * 4; i += 4) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const n = (seed >>> 24) / 4, x = (i / 4) % w;
    id.data[i] = 60 + x / 12 + n; id.data[i + 1] = 90 + n; id.data[i + 2] = 160 - n; id.data[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(new Uint8Array(c.toBuffer('image/jpeg', 95)));
  doc.addPage([612, 792]).drawImage(img, { x: 0, y: 90, width: 612, height: 612 });
  return Buffer.from(await doc.save());
}
const parseSize = (s) => {
  const m = /([\d.]+)\s*(B|KB|MB)/.exec(s ?? '');
  return m ? Number(m[1]) * { B: 1, KB: 1024, MB: 1024 * 1024 }[m[2]] : NaN;
};

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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  const menu = async (id) => {
    await page.locator('.menu-btn', { hasText: 'File' }).click();
    await page.locator(`.menu-item[data-id="${id}"]`).click();
  };

  step = 'open photo PDF';
  const original = await makePhotoPdf();
  await page.evaluate((b) => window.ashStudio.openBytes({ name: 'photo.pdf', bytes: new Uint8Array(b) }), [...original]);
  await page.waitForFunction(() => document.querySelector('.page[data-page-index="0"] canvas'));

  step = 'Reduce file size: Balanced estimate';
  await menu('reduce-size');
  const dlg = page.locator('.rz-dialog');
  await dlg.waitFor();
  check(await page.isChecked('#rz-balanced'), 'Balanced is not the default preset');
  await page.waitForFunction(() => /\(/.test(document.querySelector('#rz-after')?.textContent), null, { timeout: 30000 });
  const before = parseSize(await page.textContent('#rz-before'));
  const after = parseSize(await page.textContent('#rz-after'));
  check(Math.abs(before - original.length) / original.length < 0.01, `before ${before} vs file ${original.length}`);
  check(after < before, `dialog reports after ${after} >= before ${before}`);
  check(/1 image recompressed/.test(await dlg.textContent()), 'recompressed count missing');

  step = 'Save as… downloads the reduced copy';
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), dlg.locator('button[data-value="save"]').click()]);
  check(dl.suggestedFilename() === 'photo-reduced.pdf', `name ${dl.suggestedFilename()}`);
  const saved = await readFile(await dl.path());
  check(saved.length < original.length, `saved ${saved.length} >= original ${original.length}`);
  const out = await PDFDocument.load(saved);
  check(out.getPageCount() === 1, 'saved file page count');
  const img = out.context.enumerateIndirectObjects().map(([, o]) => o)
    .find((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  const width = img.dict.get(PDFName.of('Width')).asNumber();
  check(width <= 1700 && img.dict.get(PDFName.of('Filter')) === PDFName.of('DCTDecode'), `image width ${width}`);
  check(await page.evaluate(() => !window.ashStudio.state.tabs.find((t) => t.name === 'photo.pdf').dirty), 'tab marked dirty');

  step = 'signed PDF is refused';
  await page.evaluate(async (b) => window.ashStudio.openBytes({ name: 'signed.pdf', bytes: new Uint8Array(b) }), [...await makeSignedPdf()]);
  await page.waitForFunction(() => document.querySelector('.doc-tab[aria-selected="true"]')?.textContent.includes('signed.pdf'));
  await menu('reduce-size');
  await page.locator('.rz-signed-dialog').waitFor({ timeout: 10000 });
  check(await page.locator('.rz-dialog').count() === 0, 'reduce dialog opened for a signed PDF');
  await page.locator('.rz-signed-dialog button[data-value="ok"]').click();

  check(!problems.length, `console problems:\n${problems.join('\n')}`);
  console.log('COMPRESS E2E OK');
} catch (err) {
  console.error(`COMPRESS E2E FAILED at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
