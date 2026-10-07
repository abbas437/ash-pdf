#!/usr/bin/env node
// End-to-end test of the Document > Background… dialog (renderer/ui/pagemarks.js) in Chromium via playwright-core,
// served over HTTP with the browser shim (same pattern as pagetools.mjs). Prints "LEFTOVERS OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf(n, label = 'Page') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= n; k++) doc.addPage([612, 792]).drawText(`${label} ${k}`, { x: 72, y: 700, size: 28, font });
  return Buffer.from(await doc.save());
}

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
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);


const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  // Top-left corner pixel of page `i` of tab.bytes, rendered with pdf.js.
  const corner = (i) => ev(`const d = await v.pdfjs.getDocument({ data: tab.bytes.slice() }).promise;
    try { const p = await d.getPage(arg + 1), vp = p.getViewport({ scale: 1 }), c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height); await p.render({ canvas: c, viewport: vp }).promise;
      return [...c.getContext('2d').getImageData(3, 3, 1, 1).data.slice(0, 3)]; } finally { await d.loadingTask.destroy(); }`, i);
  const near = (a, b, msg) => check(a.every((x, k) => Math.abs(x - b[k]) <= 3), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
  const waitUndo = (n) => page.waitForFunction((k) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return (t.bytesUndo?.length ?? 0) === k && t.pdfDoc; }, n, { timeout: 10_000 });
  const menu = async (id) => {
    await page.click('.menu-btn:text-is("Document")');
    await page.waitForFunction((x) => !document.querySelector(`.menu [data-id="${x}"]`).disabled, id, { timeout: 5000 });
    await page.locator(`.menu [data-id="${id}"]`).click();
  };
  const previewed = () => page.waitForFunction(() => Number(document.querySelector('.pm-layout')?.dataset.previewed) > 0, null, { timeout: 10_000 });
  const apply = async () => {
    await page.click('.pm-dialog .dialog-buttons .btn.primary');
    await page.waitForSelector('.pm-dialog', { state: 'detached', timeout: 10_000 }).catch(async () => { throw new Error(`dialog stayed open: ${await page.textContent('.pm-error')}`); });
  };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'three.pdf', mimeType: 'application/pdf', buffer: await makePdf(3) });
  await page.waitForFunction(() => window.ashStudio.state.tabs[0]?.numPages === 3);
  near(await corner(0), [255, 255, 255], 'blank page corner');

  step = 'background colour at 50 % on odd pages';
  await menu('marks-background');
  await page.waitForSelector('#pm-bg-color');
  check(!(await page.$('#pm-replace')), 'no Replace offered on a document without a background');
  await page.$eval('#pm-bg-color', (el) => { el.value = '#0000ff'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.fill('#pm-bg-opacity', '50');
  await page.selectOption('.pm-dialog select[id^="pm-subset-"]', 'odd');
  await previewed();
  for (const theme of ['light', 'dark']) {
    await ev(`await app.setTheme('${theme}', false);`);
    await page.waitForTimeout(150);
    await page.locator('.pm-dialog').screenshot({ path: join(OUT, `leftovers-background-${theme}.png`) });
  }
  await ev("await app.setTheme('light', false);");
  await apply(); await waitUndo(1);
  near(await corner(0), [128, 128, 255], 'page 1 corner is the 50 % blue blend');
  near(await corner(1), [255, 255, 255], 'even page 2 untouched');
  near(await corner(2), [128, 128, 255], 'page 3 corner is the 50 % blue blend');
  check((await ev('const c = await import("../src/core/pagemarks.js"); return (await c.listMarks(tab.bytes)).map((m) => m.kind);')).includes('background'), 'background mark listed');

  step = 'replace';
  await menu('marks-background');
  await page.waitForSelector('#pm-replace');
  check(await page.isChecked('#pm-replace'), 'Replace is checked by default');
  await page.$eval('#pm-bg-color', (el) => { el.value = '#ff0000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.fill('#pm-bg-opacity', '100');
  await page.selectOption('.pm-dialog select[id^="pm-subset-"]', 'all');
  await previewed();
  await apply(); await waitUndo(2);
  near(await corner(0), [255, 0, 0], 'replaced: page 1 is solid red, no blue left underneath');
  near(await corner(1), [255, 0, 0], 'replaced: page 2 is solid red');

  step = 'undo';
  await ev('await pt.undo(tab);'); await waitUndo(1);
  near(await corner(0), [128, 128, 255], 'undo restores the first background');
  await ev('await pt.undo(tab);'); await waitUndo(0);
  near(await corner(0), [255, 255, 255], 'undo removes the background');

  if (problems.length) throw new Error(`page problems:\n${problems.join('\n')}`);
  console.log('LEFTOVERS OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
