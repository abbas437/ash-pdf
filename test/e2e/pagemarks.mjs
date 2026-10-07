#!/usr/bin/env node
// End-to-end test of the Document menu marks (renderer/ui/pagemarks.js) in Chromium via playwright-core,
// served over HTTP with the browser shim (same pattern as pagetools.mjs). Prints "PAGEMARKS OK".
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
  const three = await makePdf(3);
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const texts = () => ev(`const d = await v.pdfjs.getDocument({ data: tab.bytes.slice() }).promise; const out = [];
    for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join(' '));
    await d.loadingTask.destroy(); return out;`);
  const undoLen = () => ev('return tab.bytesUndo?.length ?? 0;');
  const waitUndo = (n) => page.waitForFunction((k) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return (t.bytesUndo?.length ?? 0) === k && t.pdfDoc; }, n, { timeout: 10_000 });
  const menu = async (id) => {
    await page.click('.menu-btn:text-is("Document")');
    const item = page.locator(`.menu [data-id="${id}"]`);
    await page.waitForFunction((x) => !document.querySelector(`.menu [data-id="${x}"]`).disabled, id, { timeout: 5000 });
    await item.click();
  };
  const previewed = () => page.waitForFunction(() => Number(document.querySelector('.pm-layout')?.dataset.previewed) > 0, null, { timeout: 10_000 });
  const apply = async () => {
    await page.click('.pm-dialog .dialog-buttons .btn.primary');
    await page.waitForSelector('.pm-dialog', { state: 'detached', timeout: 10_000 }).catch(async (e) => { throw new Error(`dialog stayed open: ${await page.textContent('.pm-error')}`); });
  };
  const count = (s, sub) => s.split(sub).length - 1;

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'three.pdf', mimeType: 'application/pdf', buffer: three });
  await page.waitForFunction(() => window.ashStudio.state.tabs[0]?.numPages === 3);
  eq(await page.evaluate(() => [...document.querySelectorAll('.menu-btn')].map((b) => b.textContent).slice(-2)), ['Document', 'Help'], 'Document menu sits left of Help');

  step = 'page numbers via dialog';
  await menu('marks-page-numbers');
  await page.waitForSelector('.pm-dialog');
  check(!(await page.$('#pm-replace')), 'no Replace offered on an unmarked document');
  await page.selectOption('#pm-pn-format', 'Page <<page>> of <<pages>>');
  await previewed();
  check(await page.evaluate(() => document.querySelector('.pm-canvas').width > 50), 'preview canvas rendered');
  await apply();
  await waitUndo(1);
  let t = await texts();
  check(t[1].includes('Page 2 of 3'), `page 2 text: ${t[1]}`);

  step = 'undo / redo';
  await ev('await pt.undo(tab);'); await waitUndo(0);
  check(!(await texts())[1].includes('Page 2 of 3'), 'undo removes the page numbers');
  await ev('await pt.redo(tab);'); await waitUndo(1);
  check((await texts())[1].includes('Page 2 of 3'), 'redo restores the page numbers');

  step = 'replace keeps one header set';
  await page.waitForFunction(() => !document.querySelector('.menu [data-id="marks-remove-headerFooter"]')?.disabled || true);
  await menu('marks-page-numbers');
  await page.waitForSelector('#pm-replace');
  check(await page.isChecked('#pm-replace'), 'Replace is checked by default');
  await previewed();
  await apply(); await waitUndo(2);
  t = await texts();
  eq(count(t[1], 'Page 2 of 3'), 1, 'page 2 carries exactly one page-number set after Replace');
  eq(await ev('const c = await import("../src/core/pagemarks.js"); return (await c.listMarks(tab.bytes)).map((m) => m.kind);'), ['headerFooter'], 'marks after replace');

  step = 'unsupported text message';
  await menu('marks-watermark');
  await page.waitForSelector('#pm-wm-text');
  await page.fill('#pm-wm-text', 'سري');
  await page.waitForFunction(() => /standard PDF fonts/.test(document.querySelector('.pm-error')?.textContent ?? ''), null, { timeout: 10_000 });

  step = 'watermark';
  await page.fill('#pm-wm-text', 'DRAFT COPY');
  await page.waitForFunction(() => document.querySelector('.pm-error').hidden, null, { timeout: 10_000 });
  for (const theme of ['light', 'dark']) {
    await ev(`await app.setTheme('${theme}', false);`);
    await page.waitForTimeout(150);
    await page.locator('.pm-dialog').screenshot({ path: join(OUT, `pagemarks-dialog-${theme}.png`) });
    // Legibility: contrast of label and title text against the dialog surface (WCAG ratio).
    const ratios = await page.evaluate(() => {
      const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const bg = rgb(getComputedStyle(document.querySelector('.pm-dialog')).backgroundColor);
      return ['.pm-dialog .dialog-title', '.pm-dialog .pm-field > span', '.pm-dialog .input'].map((sel) => ratio(rgb(getComputedStyle(document.querySelector(sel)).color), bg));
    });
    check(ratios.every((r) => r >= 4.5), `${theme} theme contrast too low: ${ratios.map((r) => r.toFixed(2))}`);
  }
  await ev("await app.setTheme('light', false);");
  await apply(); await waitUndo(3);
  t = await texts();
  check(t.every((s) => s.includes('DRAFT COPY')), `watermark text missing: ${JSON.stringify(t)}`);

  step = 'remove watermark';
  await menu('marks-remove-watermark');
  await waitUndo(4);
  t = await texts();
  check(t.every((s) => !s.includes('DRAFT COPY')) && t[1].includes('Page 2 of 3'), `after removing the watermark: ${JSON.stringify(t)}`);

  step = 'read-only refused';
  check(await ev('tab.readOnly = true; const ok = await app.pageMarks.pageNumbersDialog(tab); tab.readOnly = false; return ok === false && !document.querySelector(".pm-dialog");'), 'read-only tab refused');

  if (problems.length) throw new Error(`page problems:\n${problems.join('\n')}`);
  console.log('PAGEMARKS OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
