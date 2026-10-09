#!/usr/bin/env node
// Toolbar customisation e2e: right-click Hide, Customize dialog (move, reorder, compact), persistence across
// reload, Reset, View > Toolbar Compact/Expanded. Prints "TBCUSTOM OK" on success.
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

  await page.setViewportSize({ width: 1600, height: 800 });
  await settle(); await settle();
  const vis = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((e) => !e.closest('[data-tb-hidden],[data-tb-folded]') && !e.closest('.tb-more[hidden]') && !(e.closest('.tb-more-panel')?.hidden) && e.getClientRects().length > 0), sel);
  const inPanel = () => page.evaluate(() => !!document.querySelector('.tb-more-panel [data-tool="squiggly"]:not([data-tb-hidden])'));
  const members = (g) => page.$$eval(`.tb-tg[data-group="${g}"] [data-tb-item]:not(.tb-cg)`, (els) => els.map((e) => e.dataset.tbItem));
  const menuClick = async (menu, id) => { await page.click(`.menu-btn:text-is("${menu}")`); await page.click(`.menu-item[data-id="${id}"]`); await settle(); };
  const reloadPage = async () => {
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
    await settle(); await settle();
  };
  check(await vis('.tb-btn[data-tool="squiggly"]'), 'Squiggly not visible by default');

  step = 'hide Squiggly via right-click';
  await page.click('.tb-btn[data-tool="squiggly"]', { button: 'right' });
  await page.click('.tb-ctx-menu [data-id="hide"]');
  await settle();
  check(!(await vis('.tb-btn[data-tool="squiggly"]')), 'Squiggly still visible in the row');
  check(await page.$('.tb-btn[data-tool="squiggly"][data-tb-hidden]'), 'Squiggly lacks data-tb-hidden');
  if (await page.evaluate(() => !document.querySelector('.tb-more').hidden)) await page.click('.tb-more-btn');
  check(!(await inPanel()), 'Squiggly listed in the More panel');
  check(!(await vis('.tb-btn[data-tool="squiggly"]')), 'Squiggly visible with More open');
  await page.keyboard.press('Escape');
  await menuClick('Tools', 'squiggly');
  check((await tool()) === 'squiggly', `Tools > Squiggly: tool ${await tool()}`);
  await page.click('.tb-btn[data-tool="select"]');

  step = 'customize: move Stamp';
  await menuClick('View', 'tbcustomize');
  await page.selectOption('[data-key="grp:stamp"]', 'edit');
  let edit;
  check(await page.$eval('.tbc-groupbox[data-group="edit"] .tbc-row:last-child', (r) => r.dataset.id) === 'stamp', 'dialog: Stamp not last in Edit');
  await page.click('[data-key="up:stamp"]');
  await page.click('.tbc [data-key="compact:comment"]');
  await page.click('.tbc-dlg .dialog-buttons [data-value="ok"], .dialog-buttons [data-value="ok"]');
  await settle(); await settle();
  edit = await members('edit');
  check(edit.indexOf('stamp') === edit.length - 2 && edit.at(-1) === 'forms', `Stamp order in Edit: ${edit}`);
  check((await members('sign')).join() === 'sign', `Sign group: ${await members('sign')}`);

  step = 'compact Comment group';
  check((await page.$$('.tb-cg[data-grp="comment"]')).length === 1, 'no single Comment compact group');
  check((await page.$$('#tb-cg-comment')).length === 1, 'no Comment caret');
  const faceCount = await page.$$eval('.tb-cg[data-grp="comment"] [data-tool]:not([data-tb-folded]):not([data-tb-hidden])', (e) => e.length);
  check(faceCount === 1, `Comment shows ${faceCount} faces`);
  await page.click('#tb-cg-comment');
  const listed = await page.$$eval('.tb-dd-menu:not([hidden]) .menu-item', (els) => els.map((e) => e.dataset.id));
  check(listed.includes('draw') && listed.includes('highlight') && !listed.includes('squiggly'), `caret items: ${listed}`);
  await page.click('.tb-dd-menu:not([hidden]) .menu-item[data-id="draw"]');
  await settle();
  check((await tool()) === 'draw', `caret Draw: tool ${await tool()}`);
  const face = await page.$$eval('.tb-cg[data-grp="comment"] [data-tool]:not([data-tb-folded])', (e) => e.map((x) => x.dataset.tool));
  check(face.join() === 'draw', `face after Draw: ${face}`);
  await page.click('.tb-btn[data-tool="select"]');

  step = 'persists after reload';
  await reloadPage();
  check(!(await vis('.tb-btn[data-tool="squiggly"]')) && await page.$('.tb-btn[data-tool="squiggly"][data-tb-hidden]'), 'Squiggly visible after reload');
  edit = await members('edit');
  check(edit.indexOf('stamp') === edit.length - 2, `Stamp not persisted: ${edit}`);
  check((await page.$$('#tb-cg-comment')).length === 1, 'Comment not compact after reload');

  step = 'reset to default';
  await menuClick('View', 'tbcustomize');
  await page.click('.dialog-buttons [data-value="reset"]');
  await page.click('.dialog-buttons [data-value="ok"]');
  await settle(); await settle();
  check(await vis('.tb-btn[data-tool="squiggly"]'), 'Squiggly not back after Reset');
  check((await page.$$('#tb-cg-comment')).length === 0, 'Comment still compact after Reset');
  check((await members('sign')).join() === 'stamp,sign', `Sign group after Reset: ${await members('sign')}`);

  step = 'View > Toolbar compact / expanded';
  await menuClick('View', 'tbcompact');
  const nCompact = (await page.$$('.tb-cg')).length;
  check(nCompact >= 2, `Compact made ${nCompact} compact groups`);
  check((await page.getAttribute('.menu-item[data-id="tbcompact"]', 'aria-checked')) === 'true', 'Compact not checked');
  await menuClick('View', 'tbexpanded');
  check((await page.$$('.tb-cg')).length === 0, 'Expanded left compact groups');
  check(await vis('.tb-btn[data-tool="squiggly"]'), 'Squiggly not visible when Expanded');

  step = 'page errors';
  check(problems.length === 0, problems.join('\n'));
  console.log('TBCUSTOM OK');
} catch (err) {
  console.error(`TBCUSTOM FAILED at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
