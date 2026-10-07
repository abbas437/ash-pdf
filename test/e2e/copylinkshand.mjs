#!/usr/bin/env node
// End-to-end test of copying page text (renderer/ui/copytext.js) in Chromium via playwright-core:
// selects text in the pdf.js text layer with the mouse, presses Ctrl+C and checks that
// api.copyText received the text (the browser shim records it); with no text selection,
// Ctrl+C still copies selected annotation objects. Prints "COPYLINKSHAND OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= 2; k++) doc.addPage([612, 792]).drawText(`Hello copy ${k}`, { x: 72, y: 700, size: 24, font });
  return Buffer.from(await doc.save());
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
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  step = 'open';
  const pdf = await makePdf();
  await page.evaluate((b) => window.ashStudio.openBytes({ name: 'copy.pdf', bytes: new Uint8Array(b) }), [...pdf]);
  await page.waitForFunction(() => document.querySelector('.page[data-page-index="0"] .textLayer span'));
  const copied = () => page.evaluate(() => [...window.__ashShim.copied]);

  step = 'select page text with the mouse, Ctrl+C';
  const span = page.locator('.page[data-page-index="0"] .textLayer span').first();
  const box = await span.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection().toString());
  check(/Hello copy/.test(selected), `mouse selection: got ${JSON.stringify(selected)}`);
  await page.keyboard.press('Control+c');
  await page.waitForFunction(() => window.__ashShim.copied.length === 1, null, { timeout: 3000 }).catch(() => {});
  check(JSON.stringify(await copied()) === JSON.stringify([selected]), `Ctrl+C copied ${JSON.stringify(await copied())}, expected ${JSON.stringify([selected])}`);

  step = 'Ctrl+A in the viewer selects the page text';
  await page.locator('.viewer-scroll:not([hidden])').focus();
  await page.keyboard.press('Control+a');
  check((await page.evaluate(() => window.getSelection().toString())).includes('Hello copy 1'), 'Ctrl+A did not select page 1 text');

  step = 'no text selection: Ctrl+C copies the selected annotation object, not text';
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const n = await page.evaluate(async () => {
    const app = window.ashStudio, tab = app.state.tabs[0], an = app.annotations;
    const o = an.add(tab, { type: 'rect', page: 0, x: 300, y: 300, w: 50, h: 40 });
    an.select(tab, [o.id ?? o]);
    return an.getSelection(tab).length;
  });
  check(n === 1, `annotation selection: ${n}`);
  await page.locator('.viewer-scroll:not([hidden])').focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  const count = await page.evaluate(() => window.ashStudio.state.tabs[0].objects.length);
  check(count === 2, `object copy/paste: ${count} objects`);
  check((await copied()).length === 1, 'Ctrl+C with no text selection must not call copyText');

  if (problems.length) throw new Error(problems.join('\n'));
  console.log('COPYLINKSHAND OK');
} catch (err) {
  console.error(`FAILED at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
