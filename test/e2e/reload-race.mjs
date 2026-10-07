#!/usr/bin/env node
// End-to-end test of overlapping viewer reloads (renderer/ui/viewer.js reload) in Chromium via
// playwright-core, served over HTTP with the browser shim (same pattern as pagetools.mjs).
// Delete a page, then Undo + Redo while the Undo's reload is held back so it finishes LAST: the
// view must end up on the Redo's document (= the latest tab.bytes) and the stale document must
// be destroyed. Prints "RELOAD-RACE OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf(n) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= n; k++) doc.addPage([612, 792]).drawText(`Page ${k}`, { x: 72, y: 700, size: 28, font });
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const six = await makePdf(6);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const settled = (n) => page.waitForFunction((k) => { const t = window.ashStudio.state.tabs[0];
    return t?.numPages === k && document.querySelectorAll('.viewer-scroll:not([hidden]) .page').length === k; }, n, { timeout: 10_000 });

  step = 'open';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'six.pdf', mimeType: 'application/pdf', buffer: six });
  await settled(6);

  step = 'delete a page';
  await ev('await pt.deletePages(tab, [2], { confirm: false });');
  await settled(5);

  step = 'undo held back, redo';
  // Hold every 6-page document after pdf.js has parsed it (getMetadata is the first call made on a
  // freshly loaded document), so the Undo's reload (6 pages) completes after the Redo's (5 pages).
  await ev(`const proto = Object.getPrototypeOf(tab.pdfDoc);
    const orig = proto.getMetadata;
    window.__held = null;
    let release; const gate = new Promise((r) => { release = r; }); window.__release = release;
    proto.getMetadata = async function (...a) {
      if (this.numPages === 6 && !window.__held) { window.__held = this; await gate; }
      return orig.apply(this, a);
    };
    // Record whether the held document is ever installed on the tab, even transiently.
    let cur = tab.pdfDoc; window.__everHeld = false;
    Object.defineProperty(tab, 'pdfDoc', { configurable: true, enumerable: true, get: () => cur,
      set: (d) => { cur = d; if (d && d === window.__held) window.__everHeld = true; } });`);
  await ev('await pt.undo(tab);');
  await page.waitForFunction(() => !!window.__held, null, { timeout: 10_000 });
  await ev('await pt.redo(tab);');
  await settled(5);
  await page.evaluate(() => window.__release());
  // The held (stale) reload is either discarded and its document destroyed (fixed) or installed.
  await page.waitForFunction(() => window.__held.loadingTask.destroyed || window.ashStudio.state.tabs[0].pdfDoc === window.__held, null, { timeout: 10_000 });
  await page.waitForTimeout(300);

  step = 'final state follows the latest bytes';
  const st = await ev(`const { getInfo } = await import('../src/core/pdfOps.js');
    return { bytesPages: (await getInfo(tab.bytes)).pageCount, numPages: tab.numPages, pages: tab.pages.length,
      pageEls: document.querySelectorAll('.viewer-scroll:not([hidden]) .page').length,
      staleInstalled: window.__everHeld, staleDestroyed: !!window.__held.loadingTask.destroyed };`);
  eq(st, { bytesPages: 5, numPages: 5, pages: 5, pageEls: 5, staleInstalled: false, staleDestroyed: true }, 'state after undo (finishing last) + redo');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('RELOAD-RACE FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('RELOAD-RACE OK');
