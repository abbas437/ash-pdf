#!/usr/bin/env node
// End-to-end test of the Edit text tool (renderer/ui/textedit.js) in Chromium via playwright-core: the
// tool (D) edits ORIGINAL text line by line with PDFium. Click a line, type, Enter -> the tab bytes
// (read with pdf.js) have the new text and not the old, the next line is untouched; page Undo/Redo
// swap it back and forth; Esc cancels without a history entry; a subset-embedded Carlito line gets a
// substitute font (toast) without U+0000; a /Rotate 90 page edits the clicked line. Prints "TEXTEDIT OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const carlito = await doc.embedFont(readFileSync(join(root, 'renderer/vendor/fonts/edit/Carlito-Regular.ttf')), { subset: true });
  const p = doc.addPage([612, 792]);
  p.drawText('Invoice number 4711 is overdue', { x: 50, y: 700, size: 14, font: helv });
  p.drawText('Second line stays', { x: 50, y: 660, size: 14, font: helv });
  p.drawText('Total 1234', { x: 50, y: 620, size: 16, font: carlito });
  const q = doc.addPage([612, 792]);
  q.setRotation(degrees(90));
  q.drawText('Rotated alpha line', { x: 50, y: 700, size: 14, font: helv });
  q.drawText('Rotated beta line', { x: 50, y: 600, size: 14, font: helv });
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = await makePdf();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const key = async (k) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(k); };
  // Client point of PDF point (X, Y) on page i (through the page's /Rotate).
  const clientOf = (i, X, Y) => ev(`const { pdfToPage } = await import('/renderer/ui/imgedit-lib.js');
    const pg = await tab.pdfDoc.getPage(arg[0] + 1); const [x, y] = pdfToPage({ view: pg.view, rotate: pg.rotate }, arg[1], arg[2]);
    const c = v.pageToClient(tab, arg[0], x, y); return [c.clientX, c.clientY];`, [i, X, Y]);
  const textOf = (n) => ev(`
    const d = await v.pdfjs.getDocument({ data: tab.bytes.slice() }).promise;
    const t = (await (await d.getPage(arg)).getTextContent()).items.map((x) => x.str).join(' ');
    await d.loadingTask.destroy(); return t;`, n);
  const undoLen = () => ev('return tab.bytesUndo?.length ?? 0;');
  const settle = () => page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.pdfDoc && !t.loading; }, null, { timeout: 10_000 }).then(frames);
  const waitUndo = (n) => page.waitForFunction((k) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return (t?.bytesUndo?.length ?? 0) === k; }, n, { timeout: 15_000 }).then(settle);
  const openLine = async (i, X, Y) => {
    await page.mouse.click(...await clientOf(i, X, Y));
    await page.waitForSelector('input.te-editor', { timeout: 10_000 });
    return page.inputValue('input.te-editor');
  };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 2 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await settle();

  step = 'tool';
  await key('d');
  check(await ev('return app.state.tool;') === 'textedit', 'D did not select the Edit text tool');
  check(await page.$('.tb-tools [data-group="edit"] [data-tool="textedit"]'), 'Edit text button not in the Edit group');
  const [hx, hy] = await clientOf(0, 120, 704);
  await page.mouse.move(hx, hy);
  await page.mouse.move(hx + 3, hy);
  await page.waitForSelector('rect.te-hover', { timeout: 10_000 });

  step = 'edit line 1';
  check(await openLine(0, 150, 704) === 'Invoice number 4711 is overdue', 'editor value is not the line text');
  const fs = await ev("return [parseFloat(document.querySelector('input.te-editor').style.fontSize), v.scale(tab)];");
  check(Math.abs(fs[0] - 14 * fs[1]) < 0.01, `editor font size ${fs[0]} != 14 x ${fs[1]}`);
  await page.fill('input.te-editor', 'Invoice number 4712 is paid');
  await page.keyboard.press('Enter');
  await waitUndo(1);
  let t = await textOf(1);
  check(t.includes('Invoice number 4712 is paid') && !t.includes('4711') && !t.includes('overdue'), `edit not in the bytes: ${t}`);
  check(t.includes('Second line stays'), `line 2 changed: ${t}`);

  step = 'undo/redo';
  await ev('await app.pageTools.undo(tab);');
  await settle();
  t = await textOf(1);
  check(t.includes('Invoice number 4711 is overdue') && !t.includes('4712'), `Undo did not bring the old text back: ${t}`);
  await ev('await app.pageTools.redo(tab);');
  await settle();
  t = await textOf(1);
  check(t.includes('Invoice number 4712 is paid') && !t.includes('4711'), `Redo did not bring the new text back: ${t}`);

  step = 'esc';
  const before = await undoLen();
  check(await openLine(0, 100, 664) === 'Second line stays', 'line 2 editor value');
  await page.fill('input.te-editor', 'Something else');
  await page.keyboard.press('Escape');
  await frames();
  check(!(await page.$('input.te-editor')), 'Esc left the editor open');
  check(await undoLen() === before && (await textOf(1)).includes('Second line stays'), 'Esc changed the document');

  step = 'subset';
  check(await openLine(0, 70, 625) === 'Total 1234', 'subset line editor value');
  await page.fill('input.te-editor', 'Zebra 9876');
  await page.keyboard.press('Enter');
  await waitUndo(before + 1);
  const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent).join(' | '));
  check(/not fully embedded — used Carlito/.test(toasts), `no substitution toast: ${toasts}`);
  t = await textOf(1);
  check(t.includes('Zebra 9876') && !t.includes('\u0000') && !t.includes('Total 1234'), `subset edit text: ${JSON.stringify(t)}`);

  step = 'rotated page';
  await ev('v.scrollToPage(tab, 1);');
  await settle();
  check(await openLine(1, 100, 604) === 'Rotated beta line', 'rotated page: wrong line under the click');
  await page.fill('input.te-editor', 'Rotated BETA edited');
  await page.keyboard.press('Enter');
  await waitUndo(before + 2);
  t = await textOf(2);
  check(t.includes('Rotated BETA edited') && t.includes('Rotated alpha line') && !t.includes('beta line'), `rotated edit: ${t}`);

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('TEXTEDIT OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
