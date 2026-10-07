#!/usr/bin/env node
// Split view and sidebar resize/toggle (ui/splitview.js, ui/sidebar.js) in Chromium with the
// browser shim. Prints "SPLITVIEW OK" on success. Same harness as run.mjs.
// Run `node scripts/vendor.js` first. Chromium path: $CHROMIUM_PATH or the sandbox default.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const ROTATED = 1; // 0-based index of the page carrying /Rotate 90

async function makeMainPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 12; n++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${n} of 12`, { x: 72, y: 700, size: 28, font });
    p.drawText('Supply air layout and general notes', { x: 72, y: 660, size: 14, font });
    if (n === 3 || n === 9) p.drawText('Check the ductwork clearances', { x: 72, y: 620, size: 16, font });
    if (n - 1 === ROTATED) p.setRotation(degrees(90));
  }
  return Buffer.from(await doc.save());
}
async function makeSmallPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 2; n++) doc.addPage([420, 595]).drawText(`Second document ${n}`, { x: 40, y: 540, size: 18, font });
  return Buffer.from(await doc.save());
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const problems = [];
const fail = (msg) => { throw new Error(msg); };
const check = (cond, msg) => { if (!cond) fail(msg); };
const near = (a, b, tol, msg) => check(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} ±${tol}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const [mainPdf, smallPdf] = await Promise.all([makeMainPdf(), makeSmallPdf()]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => {
    if (m.type() === 'error' || /\[bus\]|failed to render|Content Security Policy/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));

  const boot = async () => {
    await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  };
  const openFile = async (name, buffer) => {
    const chooser = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction((n) => window.ashStudio.state.tabs.some((t) => t.name === n && t.view), name);
  };
  const menu = async (m, id) => { await page.click(`.menu-btn:text-is("${m}")`); await page.click(`.menu [data-id="${id}"]`); };
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const tabsInfo = () => page.evaluate(() => window.ashStudio.state.tabs.map((t) => ({ id: t.id, name: t.name, top: t.view.scrollEl.scrollTop,
    hidden: t.view.scrollEl.hidden, pane: t.view.scrollEl.dataset.pane ?? '', rect: t.view.scrollEl.getBoundingClientRect().toJSON(),
    rendered: t.view.pageEls.filter((p) => p.classList.contains('rendered')).length })));

  step = 'open two documents';
  await boot();
  await openFile('main.pdf', mainPdf);
  await openFile('small.pdf', smallPdf);

  step = 'split vertically';
  await menu('View', 'split-v');
  await page.waitForFunction(() => document.querySelector('.viewer-host.split.split-v'));
  // Pane B shows the other open tab; choose main.pdf for pane A through the picker.
  const ids = await page.evaluate(() => window.ashStudio.state.tabs.map((t) => t.id));
  await page.selectOption('.split-head[data-pane="a"] select', ids[0]);
  await page.selectOption('.split-head[data-pane="b"] select', ids[1]);
  await page.waitForFunction(() => window.ashStudio.state.tabs.every((t) => t.view.pageEls.some((p) => p.classList.contains('rendered'))), null, { timeout: 10_000 });
  let info = await tabsInfo();
  check(info.every((t) => !t.hidden && t.rendered > 0), `both panes render pages: ${JSON.stringify(info.map((t) => [t.hidden, t.rendered]))}`);
  check(info[0].pane === 'a' && info[1].pane === 'b', `pane assignment: ${info.map((t) => t.pane)}`);
  check(info[0].rect.right <= info[1].rect.left + 1 && info[0].rect.width > 200 && info[1].rect.width > 200, 'panes are side by side');
  check(await page.evaluate(() => document.querySelectorAll('.viewer-scroll.pane-focused').length === 1 && !!document.querySelector('.split-head.focused')), 'focused pane is marked');

  step = 'scroll pane A independently';
  const beforeB = info[1].top;
  await page.evaluate((id) => { window.ashStudio.state.tabs.find((t) => t.id === id).view.scrollEl.scrollTop = 3000; }, ids[0]);
  await settle();
  info = await tabsInfo();
  check(info[0].top > 2000, `pane A scrolled: ${info[0].top}`);
  check(info[1].top === beforeB, `pane B did not move: ${beforeB} -> ${info[1].top}`);
  await page.waitForFunction((id) => window.ashStudio.state.tabs.find((t) => t.id === id).currentPage > 0, ids[0]);

  step = 'focus pane B';
  await page.click('.viewer-scroll[data-pane="b"]', { position: { x: 20, y: 200 } });
  await page.waitForFunction((id) => window.ashStudio.state.activeId === id, ids[1]);
  info = await tabsInfo();
  check(info[0].top > 2000 && !info[0].hidden, 'pane A keeps its position when pane B takes focus');
  check(await page.evaluate(() => document.querySelector('.split-head[data-pane="b"]').classList.contains('focused')), 'pane B header marked focused');

  step = 'drag the divider';
  const w0 = info[0].rect.width;
  const d = await page.locator('.split-divider').boundingBox();
  await page.mouse.move(d.x + d.width / 2, d.y + 200);
  await page.mouse.down();
  await page.mouse.move(d.x - 150, d.y + 200, { steps: 5 });
  await page.mouse.up();
  await settle();
  info = await tabsInfo();
  check(info[0].rect.width < w0 - 100 && info[1].rect.width > w0 + 100, `divider drag resizes panes: ${w0} -> ${info[0].rect.width}/${info[1].rect.width}`);
  await page.dblclick('.split-divider');
  await settle();
  info = await tabsInfo();
  near(info[0].rect.width, info[1].rect.width, 2, 'double-click resets 50/50');

  step = 'split horizontally';
  await menu('View', 'split-h');
  await settle();
  info = await tabsInfo();
  check(info[0].rect.bottom <= info[1].rect.top + 1 && info[0].rect.height > 100, 'panes stacked');

  step = 'unsplit';
  await menu('View', 'unsplit');
  await settle();
  info = await tabsInfo();
  check(!(await page.evaluate(() => document.querySelector('.viewer-host.split, .split-divider, .split-head'))), 'split chrome removed');
  check(info.filter((t) => !t.hidden).length === 1, 'one pane left');
  const host = await page.evaluate(() => document.querySelector('.viewer-host').getBoundingClientRect().width);
  near(info.find((t) => !t.hidden).rect.width, host, 1, 'remaining pane fills the viewer');

  step = 'sidebar toggle';
  await page.keyboard.press('Control+b');
  check(await page.evaluate(() => document.body.classList.contains('sidebar-closed') && getComputedStyle(document.querySelector('.sidebar')).display === 'none'), 'Ctrl+B hides the sidebar');
  await page.keyboard.press('F4');
  check(await page.evaluate(() => !document.body.classList.contains('sidebar-closed')), 'F4 shows the sidebar');
  await page.click('#btn-sidebar');
  check(await page.evaluate(() => document.body.classList.contains('sidebar-closed')), 'toolbar button hides the sidebar');
  await menu('View', 'sidebar');
  check(await page.evaluate(() => !document.body.classList.contains('sidebar-closed')), 'View > Show sidebar shows it');

  step = 'sidebar resize';
  const sb = await page.locator('.sb-resize').boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + 300);
  await page.mouse.down();
  await page.mouse.move(sb.x + 140, sb.y + 300, { steps: 5 });
  await page.mouse.up();
  const sw = await page.evaluate(() => document.querySelector('.sidebar').offsetWidth);
  check(sw > 300 && sw < 360, `sidebar widened: ${sw}`);
  await page.mouse.move(sb.x + 140, sb.y + 300);
  await page.mouse.down();
  await page.mouse.move(1200, sb.y + 300, { steps: 3 });
  await page.mouse.up();
  near(await page.evaluate(() => document.querySelector('.sidebar').offsetWidth), 640, 1, 'clamped to 50 % of the window');
  await page.mouse.move(640, sb.y + 300);
  await page.mouse.down();
  await page.mouse.move(20, sb.y + 300, { steps: 3 });
  await page.mouse.up();
  near(await page.evaluate(() => document.querySelector('.sidebar').offsetWidth), 160, 1, 'clamped to the 160 px minimum');
  await page.mouse.move(160, sb.y + 300);
  await page.mouse.down();
  await page.mouse.move(sb.x + 140, sb.y + 300, { steps: 3 });
  await page.mouse.up();
  const kept = await page.evaluate(() => document.querySelector('.sidebar').offsetWidth);
  await boot();
  near(await page.evaluate(() => document.querySelector('.sidebar').offsetWidth), kept, 1, 'sidebar width persists after reload');

  if (problems.length) throw new Error(`page problems:\n${problems.join('\n')}`);
  console.log('SPLITVIEW OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
