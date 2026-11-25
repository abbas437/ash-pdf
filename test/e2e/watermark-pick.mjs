#!/usr/bin/env node
// End-to-end test of Remove watermark… > Pick it on the page… (renderer/ui/wm-pick.js) in Chromium via
// playwright-core, served over HTTP with the browser shim (same pattern as watermark-remove.mjs; run
// `node scripts/vendor.js` first). The fixture is a 3-page PDF with an unmarked "SAMPLE WM" drawn as two
// text objects in the same place on every page, a second copy elsewhere on page 2 and different body text
// on each page. Prints "WATERMARK PICK OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

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

// Fixture: "SAMPLE" and "WM" as two text objects at (X, Y) on every page; page 2 also at (X, Y_OFF).
const SIZE = 48, X = 150, Y = 600, Y_OFF = 480;
const BODY = ['Body text one', 'Body text two', 'Body text three'];
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const W_SAMPLE = font.widthOfTextAtSize('SAMPLE', SIZE), X_WM = X + font.widthOfTextAtSize('SAMPLE ', SIZE);
const drawWm = (pg, y) => { pg.drawText('SAMPLE', { x: X, y, size: SIZE, font }); pg.drawText('WM', { x: X_WM, y, size: SIZE, font }); };
for (let i = 0; i < 3; i++) {
  const pg = doc.addPage([612, 792]);
  pg.drawText(BODY[i], { x: 72, y: 100, size: 14, font });
  drawWm(pg, Y);
  if (i === 1) drawWm(pg, Y_OFF);
}
const fixture = Buffer.from(await doc.save());
// Click targets (PDF points): the middle of each part, and empty space.
const SAMPLE_AT = [X + W_SAMPLE / 2, Y + SIZE * 0.35], WM_AT = [X_WM + 20, Y + SIZE * 0.35], EMPTY_AT = [500, 400];
const SAMPLE_OFF_AT = [X + W_SAMPLE / 2, Y_OFF + SIZE * 0.35];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  // Text items per page: [{ str, y }] (y: baseline in PDF points).
  const items = () => ev(`const d = await v.pdfjs.getDocument({ data: tab.bytes.slice() }).promise; const out = [];
    for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.filter((x) => x.str.trim()).map((x) => ({ str: x.str, y: Math.round(x.transform[5]) })));
    await d.loadingTask.destroy(); return out;`);
  const sampleAt = (pages, i, y) => pages[i].some((x) => x.str.includes('SAMPLE') && Math.abs(x.y - y) < 2);
  const bodyKept = (pages) => BODY.every((b, i) => pages[i].some((x) => x.str.includes(b)));
  const bytes = () => ev('return Array.from(tab.bytes);');
  const waitUndo = (n) => page.waitForFunction((k) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return (t.bytesUndo?.length ?? 0) === k && t.pdfDoc; }, n, { timeout: 10_000 });
  const menu = async (id) => {
    await page.click('.menu-btn:text-is("Document")');
    await page.waitForFunction((x) => !document.querySelector(`.menu [data-id="${x}"]`).disabled, id, { timeout: 5000 });
    await page.locator(`.menu [data-id="${id}"]`).click();
  };
  const open = async (name, buffer, pages) => {
    const chooser = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction(([nm, n]) => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.name === nm && t.numPages === n && t.pdfDoc; }, [name, pages], { timeout: 10_000 });
  };
  // Show page i at the top and return the window point of the PDF point [x, y] on it.
  const showPage = async (i) => { await ev('v.scrollToPage(tab, arg);', i); await page.waitForFunction((k) => { const a = window.ashStudio; return a.state.tabs.find((x) => x.id === a.state.activeId).currentPage === k; }, i, { timeout: 5000 }); };
  const at = (i, [x, y]) => ev(`const r = v.getPageEl(tab, arg.i).getBoundingClientRect(), [vx, vy] = v.getViewport(tab, arg.i).convertToViewportPoint(arg.x, arg.y);
    return [r.left + vx, r.top + vy];`, { i, x, y });
  const click = async (i, pt, shift = false) => {
    const [cx, cy] = await at(i, pt);
    check(cy > 0 && cy < 860, `click target on page ${i + 1} is in the window (y ${cy})`);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(cx, cy);
    if (shift) await page.keyboard.up('Shift');
  };
  const outlines = () => page.$$eval('.wm-pick-outline', (els) => els.length);
  const startPick = async () => {
    await menu('marks-remove-watermark');
    await page.waitForSelector('.wm-none-dialog');
    await page.click('.wm-none-dialog [data-value="pick"]');
    await page.waitForSelector('.wm-pick-hint');
  };

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await open('sample.pdf', fixture, 3);
  let t = await items();
  check([0, 1, 2].every((i) => sampleAt(t, i, Y)) && sampleAt(t, 1, Y_OFF) && bodyKept(t), `fixture: ${JSON.stringify(t)}`);

  step = 'pick both parts on page 1';
  await showPage(0);
  await startPick();
  eq(await page.textContent('.wm-pick-hint'), 'Click the watermark (Shift+click to add parts). Enter when done, Esc to cancel.', 'hint');
  await click(0, SAMPLE_AT);
  await page.waitForFunction(() => document.querySelectorAll('.wm-pick-outline').length === 1, null, { timeout: 5000 });
  await click(0, WM_AT, true);
  await page.waitForFunction(() => document.querySelectorAll('.wm-pick-outline').length === 2, null, { timeout: 5000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.wm-pick-dialog');
  check(!(await page.$('.wm-pick-hint')) && !(await outlines()), 'picking ended: hint and outlines gone');
  eq(await page.textContent('.wm-pick-dialog .wm-pick-found'), 'Found on 3 of 3 pages (6 objects)', 'summary');
  check((await page.textContent('.wm-pick-dialog')).includes('Only remove watermarks you are entitled to remove'), 'entitlement line shown');
  check(!(await page.$('.wm-pick-dialog .wm-signed')), 'no signature warning on an unsigned document');

  step = 'remove';
  await page.click('.wm-pick-dialog [data-value="ok"]');
  await page.waitForSelector('.wm-pick-dialog', { state: 'detached', timeout: 10_000 });
  await waitUndo(1);
  await page.waitForSelector('.toast:text-is("Removed from 3 pages")', { timeout: 5000 });
  t = await items();
  for (const i of [0, 1, 2]) check(!sampleAt(t, i, Y), `SAMPLE removed from page ${i + 1}: ${JSON.stringify(t[i])}`);
  check(!t.flat().some((x) => x.str.includes('WM') && Math.abs(x.y - Y) < 2), `WM removed: ${JSON.stringify(t)}`);
  check(sampleAt(t, 1, Y_OFF) && t[1].some((x) => x.str.includes('WM') && Math.abs(x.y - Y_OFF) < 2), `off-position copy on page 2 kept: ${JSON.stringify(t[1])}`);
  check(bodyKept(t), `body text kept: ${JSON.stringify(t)}`);
  check(await ev('return tab.requiresFullSave === true;'), 'page content rewritten: the next save is a full save');

  step = 'undo';
  await ev('await pt.undo(tab);'); await waitUndo(0);
  t = await items();
  check([0, 1, 2].every((i) => sampleAt(t, i, Y)) && sampleAt(t, 1, Y_OFF) && bodyKept(t), `undo brings SAMPLE WM back: ${JSON.stringify(t)}`);
  const before = await bytes();

  step = 'the off-position copy is only on its page';
  await showPage(1);
  await startPick();
  await click(1, SAMPLE_OFF_AT);
  await page.waitForFunction(() => document.querySelectorAll('.wm-pick-outline').length === 1, null, { timeout: 5000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.wm-pick-dialog');
  eq(await page.textContent('.wm-pick-dialog .wm-pick-found'), 'Found only on this page (1 object)', 'off-position copy found only on page 2');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.wm-pick-dialog', { state: 'detached', timeout: 5000 });
  check(JSON.stringify(await bytes()) === JSON.stringify(before), 'Esc in the confirm dialog: document unchanged');

  step = 'empty space clears; Esc while picking changes nothing';
  await showPage(0);
  await startPick();
  await click(0, SAMPLE_AT);
  await page.waitForFunction(() => document.querySelectorAll('.wm-pick-outline').length === 1, null, { timeout: 5000 });
  await click(0, EMPTY_AT);
  await page.waitForFunction(() => !document.querySelector('.wm-pick-outline'), null, { timeout: 5000 });
  await click(0, SAMPLE_AT);
  await page.waitForFunction(() => document.querySelectorAll('.wm-pick-outline').length === 1, null, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.wm-pick-hint', { state: 'detached', timeout: 5000 });
  check(!(await outlines()) && !(await page.$('.wm-pick-dialog')), 'Esc: no outline, no dialog');
  await page.waitForTimeout(300);
  eq(await ev('return tab.bytesUndo?.length ?? 0;'), 0, 'Esc: no undo step');
  check(JSON.stringify(await bytes()) === JSON.stringify(before), 'Esc while picking: document unchanged');

  if (problems.length) throw new Error(`page problems:\n${problems.join('\n')}`);
  console.log('WATERMARK PICK OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
