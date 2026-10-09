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
  check(await page.evaluate(() => document.activeElement?.closest?.('.toolbar') && !document.activeElement.closest('[data-tb-hidden]')), 'focus lost after Hide');
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

  step = 'compact face with a longer label re-fits the row (labels on)';
  await page.evaluate(() => document.body.classList.add('tool-labels'));
  await page.keyboard.press('Escape');
  const overflowing = () => page.evaluate(() => {
    const bar = document.querySelector('.toolbar');
    const right = bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight || 0) + 0.5;
    const out = [...bar.querySelectorAll('.tb-tools [data-tb-item], .tb-more, .tb-more-btn')]
      .filter((e) => !e.closest('.tb-more-panel') && !e.closest('[data-tb-hidden],[data-tb-folded]') && e.getClientRects().length > 0 && e.getBoundingClientRect().right > right);
    return out.map((e) => e.dataset.tbItem ?? e.className);
  });
  const moreShown = () => page.evaluate(() => !document.querySelector('.tb-more').hidden);
  // A non-link tool is already active, so the body's links-off class does not change on the next switch
  // (that class change would re-fit the row by itself and hide the missing re-fit on a face change).
  await page.keyboard.press('h');
  check((await tool()) === 'highlight', `shortcut H: tool ${await tool()}`);
  check(await page.$eval('.tb-cg[data-grp="comment"] [data-tool="highlight"]', (b) => !b.hasAttribute('data-tb-folded')), 'Area is not the face');
  let lo = 500, hi = 1600; // narrowest width at which the row fits without More
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    await page.setViewportSize({ width: mid, height: 800 }); await settle(); await settle();
    if (await moreShown()) lo = mid; else hi = mid;
  }
  await page.setViewportSize({ width: hi, height: 800 }); await settle(); await settle();
  check(!(await moreShown()) && (await overflowing()).length === 0, `row does not fit at ${hi}px`);
  // Every tool switch also changes the body's classes, and the toolbar watches those: that re-fits the row by
  // itself and would hide a missing re-fit on a face change. Freeze them for this one switch.
  await page.evaluate(() => { for (const m of ['add', 'remove', 'toggle', 'replace']) document.body.classList[m] = () => false; });
  await page.keyboard.press('u'); // Underline: a longer label than Area
  await settle(); await settle();
  check((await tool()) === 'underline', `shortcut U: tool ${await tool()}`);
  const spill = await overflowing();
  await page.evaluate(() => { for (const m of ['add', 'remove', 'toggle', 'replace']) delete document.body.classList[m]; });
  check(spill.length === 0, `after the face grew, items past the bar edge: ${spill}`);
  check(await moreShown(), 'More not shown after the face grew');
  await page.click('.tb-btn[data-tool="select"]');
  await page.evaluate(() => document.body.classList.remove('tool-labels'));
  await page.setViewportSize({ width: 1600, height: 800 }); await settle(); await settle();

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

  step = 'no leading, trailing or doubled separators';
  const seps = () => page.evaluate(() => {
    const kids = [...document.querySelector('.tb-tools').children].filter((e) => !e.classList.contains('tb-more') && e.getClientRects().length > 0);
    return kids.map((e) => (e.classList.contains('tb-sep') ? 'S' : 'G')).join('');
  });
  const okSeps = (t) => t.length && !t.startsWith('S') && !t.endsWith('S') && !t.includes('SS');
  await menuClick('View', 'tbcustomize');
  await page.click('[data-key="gup:pages"]'); // Pages first
  await page.click('[data-key="gdown:navigate"]'); // Pages, View, Navigate ...
  for (const id of ['pages', 'split', 'stamp', 'sign']) await page.click(`.tbc [data-key="show:${id}"]`);
  await page.click('.dialog-buttons [data-value="ok"]');
  await settle(); await settle();
  const order = await page.$$eval('.tb-tools > .tb-tg', (g) => g.map((e) => e.dataset.group).join());
  check(order.startsWith('pages,view,navigate'), `group order: ${order}`);
  const pattern = await seps();
  check(okSeps(pattern), `separators with empty groups first and last: ${pattern}`);
  check(pattern.split('G').length - 1 === 3, `visible groups in ${pattern}`);

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
