#!/usr/bin/env node
// Toolbar UX e2e: tool groups, second click returns to Select, one-row toolbar with More overflow,
// no "next build" placeholders, short single-line File menu items. Prints "E2E OK" on success.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const doc = await PDFDocument.create();
  for (let n = 0; n < 2; n++) doc.addPage([612, 792]);
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'tb.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await page.waitForFunction(() => window.ashStudio.state.tabs.some((t) => t.view));
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const tool = () => page.evaluate(() => window.ashStudio.state.tool);

  step = 'groups';
  const groups = await page.$$eval('.tb-tools > .tb-tg', (gs) => gs.filter((g) => g.children.length).map((g) => g.getAttribute('aria-label')));
  check(JSON.stringify(groups) === JSON.stringify(['Navigate', 'Edit', 'Comment', 'Stamp and sign']), `groups: ${groups}`);
  const inGroup = await page.$$eval('.tb-tg', (gs) => Object.fromEntries(gs.map((g) => [g.dataset.group, [...g.children].map((c) => c.dataset.tbItem)])));
  check(inGroup.navigate.join() === 'select,hand' && inGroup.edit[0] === 'text' && inGroup.comment.includes('highlight') && inGroup.sign.join() === 'stamp,sign', `group members: ${JSON.stringify(inGroup)}`);

  step = 'second click returns to Select';
  await page.click('.tb-btn[data-tool="highlight"]');
  check((await tool()) === 'highlight', 'first click selects Highlight');
  await page.click('.tb-btn[data-tool="highlight"]');
  check((await tool()) === 'select', `second click on Highlight: tool ${await tool()}`);
  check((await page.getAttribute('.tb-btn[data-tool="select"]', 'aria-pressed')) === 'true', 'Select button not pressed');
  await page.click('.tb-btn[data-tool="select"]');
  check((await tool()) === 'select', 'clicking active Select keeps Select');
  await page.click('.viewer-scroll:not([hidden])', { position: { x: 5, y: 5 } });
  await page.keyboard.press('p');
  check((await tool()) === 'draw', 'P selects Draw');
  await page.keyboard.press('p');
  check((await tool()) === 'select', `P twice: tool ${await tool()}`);

  step = 'one row with labels';
  const row = () => page.evaluate(() => {
    const bs = [...document.querySelectorAll('.toolbar button.tb-btn')].filter((b) => b.offsetParent && !b.closest('.tb-more-panel'));
    return { tops: bs.map((b) => Math.round(b.getBoundingClientRect().top)), more: !document.querySelector('.tb-more').hidden, inMore: document.querySelectorAll('.tb-more-panel > *').length };
  });
  await page.evaluate(() => document.body.classList.add('tool-labels'));
  await settle(); await settle();
  let r = await row();
  check(r.tops.every((t) => Math.abs(t - r.tops[0]) <= 4), `1280: not one row ${r.tops}`);
  await page.setViewportSize({ width: 900, height: 800 });
  await settle(); await settle();
  r = await row();
  check(r.tops.every((t) => Math.abs(t - r.tops[0]) <= 4), `900: not one row ${r.tops}`);
  check(r.more && r.inMore > 0, `900: More button missing or empty ${JSON.stringify(r)}`);
  await page.click('.tb-more-btn');
  check(await page.locator('.tb-more-panel').isVisible(), 'More panel did not open');
  await page.setViewportSize({ width: 1280, height: 800 });
  await settle(); await settle();

  step = 'no placeholders';
  const stale = await page.$$eval('.toolbar button', (bs) => bs.filter((b) => /next build/i.test(b.title + b.getAttribute('aria-label'))).length);
  check(stale === 0, `${stale} "next build" buttons`);

  step = 'file menu';
  await page.click('.menu-btn:text-is("File")');
  const menu = await page.$$eval('.menu:not([hidden]) .menu-item', (els) => els.map((e) => ({ t: e.querySelector('span').textContent, h: e.getBoundingClientRect().height })));
  for (const want of ['Export to Word…', 'Export to Excel…', 'Export to image…', 'Create PDF from Office…']) check(menu.some((m) => m.t === want), `File menu lacks "${want}"`);
  const h0 = menu[0].h;
  check(menu.every((m) => Math.abs(m.h - h0) <= 1), `menu items wrap: ${JSON.stringify(menu.filter((m) => Math.abs(m.h - h0) > 1))}`);
  check(problems.length === 0, problems.join('\n'));
  console.log('E2E OK');
} catch (err) {
  console.error(`E2E FAILED at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
