#!/usr/bin/env node
// End-to-end test of the one Undo/Redo history (renderer/ui/pagehistory-lib.js timeline): the toolbar
// buttons, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z and Edit › Undo/Redo act on the newest entry of either the
// annotation history or the page/bytes history (Edit text, page operations), in time order, and name
// it ("Undo Edit text"). A page change keeps the earlier annotation history. Prints "UNDO OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText('Invoice number 4711 is overdue', { x: 50, y: 700, size: 14, font: helv });
  p.drawText('Second line stays', { x: 50, y: 660, size: 14, font: helv });
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
  await (await chooser).setFiles({ name: 'undo.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 2 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await settle();
  const btnState = () => page.evaluate(() => ['btn-undo', 'btn-redo'].map((id) => { const b = document.getElementById(id); return [b.disabled, b.title]; }));
  const rotation = (n) => ev('const d = await v.pdfjs.getDocument({ data: tab.bytes.slice() }).promise; const r = (await d.getPage(arg)).rotate; await d.loadingTask.destroy(); return r;', n);
  const editMenu = async () => {
    await page.click('.menubar .menu-btn:text-is("Edit")');
    const r = await page.evaluate(() => ['undo', 'redo'].map((id) => { const b = document.querySelector(`.menu-item[data-id="${id}"]`); return [b.disabled, b.querySelector('span').textContent]; }));
    await page.keyboard.press('Escape');
    return r;
  };
  check(JSON.stringify((await btnState()).map((b) => b[0])) === '[true,true]', 'Undo/Redo enabled with no history');

  step = 'edit text';
  await key('d');
  check(await openLine(0, 150, 704) === 'Invoice number 4711 is overdue', 'editor value is not the line text');
  await page.fill('input.te-editor', 'Invoice number 4712 is paid');
  await page.keyboard.press('Enter');
  await waitUndo(1);
  await key('v'); // leave the Edit text tool (the owner's report: the buttons went grey here)
  await frames();
  let b = await btnState();
  check(!b[0][0] && b[0][1] === 'Undo Edit text (Ctrl+Z)', `toolbar Undo after Edit text: ${JSON.stringify(b)}`);
  check(b[1][0], 'Redo enabled before any undo');
  let m = await editMenu();
  check(JSON.stringify(m) === JSON.stringify([[false, 'Undo Edit text'], [true, 'Redo']]), `Edit menu after Edit text: ${JSON.stringify(m)}`);

  step = 'toolbar undo/redo';
  await page.click('#btn-undo');
  await waitUndo(0);
  let t = await textOf(1);
  check(t.includes('Invoice number 4711 is overdue') && !t.includes('4712'), `toolbar Undo did not bring the old text back: ${t}`);
  b = await btnState();
  check(b[0][0] && !b[1][0] && b[1][1] === 'Redo Edit text (Ctrl+Y)', `buttons after Undo: ${JSON.stringify(b)}`);
  await page.click('#btn-redo');
  await waitUndo(1);
  t = await textOf(1);
  check(t.includes('Invoice number 4712 is paid') && !t.includes('4711'), `toolbar Redo did not bring the new text: ${t}`);

  step = 'rectangle + rotate';
  const rectId = await ev('return app.annotations.add(tab, { type: "rect", page: 1, x: 100, y: 100, w: 80, h: 40, stroke: "#ff0000" }).id;');
  check((await btnState())[0][1] === 'Undo Add annotation (Ctrl+Z)', 'Undo does not name the annotation');
  await ev('await app.pageTools.rotate(tab, [1], 90);');
  await waitUndo(2);
  check(await rotation(2) === 180, 'page 2 not rotated');
  check(await ev('return tab.undo.length;') === 1, 'the page change dropped the annotation history');
  m = await editMenu();
  check(JSON.stringify(m) === JSON.stringify([[false, 'Undo Rotate pages'], [true, 'Redo']]), `Edit menu after rotate: ${JSON.stringify(m)}`);
  const hasRect = () => ev('return tab.objects.some((o) => o.id === arg);', rectId);

  step = 'ctrl+z in time order';
  await key('Control+z');
  await waitUndo(1);
  check(await rotation(2) === 90, 'first Ctrl+Z did not undo the rotation');
  check(await hasRect(), 'first Ctrl+Z removed the rectangle');
  await key('Control+z');
  await frames();
  check(!(await hasRect()), 'second Ctrl+Z did not remove the rectangle');
  check(await undoLen() === 1 && (await textOf(1)).includes('4712'), 'second Ctrl+Z undid the text edit');
  b = await btnState();
  check(b[0][1] === 'Undo Edit text (Ctrl+Z)' && b[1][1] === 'Redo Add annotation (Ctrl+Y)', `buttons after two undos: ${JSON.stringify(b)}`);

  step = 'redo in time order';
  await key('Control+y');
  await frames();
  check(await hasRect() && await undoLen() === 1, 'Ctrl+Y did not redo the rectangle first');
  await key('Control+Shift+z');
  await waitUndo(2);
  check(await rotation(2) === 180, 'Ctrl+Shift+Z did not redo the rotation');

  step = 'quick double ctrl+z';
  await key('Control+z');
  await page.keyboard.press('Control+z'); // while the page undo is still running
  await waitUndo(1);
  await page.waitForFunction((id) => { const a = window.ashStudio, x = a.state.tabs[0]; return !x.objects.some((o) => o.id === id); }, rectId, { timeout: 10_000 });
  check(await rotation(2) === 90 && (await textOf(1)).includes('4712'), 'quick Ctrl+Z twice: wrong entries undone');

  step = 'new action clears redo';
  await ev('app.annotations.add(tab, { type: "rect", page: 0, x: 10, y: 10, w: 20, h: 20, stroke: "#000000" });');
  await frames();
  check(await ev('return tab.redo.length === 0 && (tab.bytesRedo?.length ?? 0) === 0;'), 'a new annotation kept the redo entries');
  check((await btnState())[1][0], 'Redo enabled after a new action');

  step = 'after save';
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  await settle();
  b = await btnState();
  check(!b[0][0] && b[0][1] === 'Undo Add annotation (Ctrl+Z)', `Undo after save: ${JSON.stringify(b)}`);
  await page.click('#btn-undo');
  await frames();
  check(await ev('return tab.objects.length;') === 0, 'Undo after save did not remove the new rectangle');
  await page.click('#btn-undo');
  await waitUndo(0);
  check((await textOf(1)).includes('4711'), 'Undo after save did not undo the text edit');

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('UNDO OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
