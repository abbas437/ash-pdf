#!/usr/bin/env node
// Toolbar UX e2e: tool groups, second click returns to Select, Pages and Split dropdowns (mouse and
// keyboard, also inside More), one-row toolbar with More overflow, no "next build" placeholders, short single-line File menu items,
// group colours (both themes, pressed and hovered, toggle persists), no overflow at 1366 px without labels, arrow keys
// skip hidden buttons, opening Sign leaves More alone. Prints "E2E OK" on success.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { contrastRatio } from '../../renderer/ui/color-lib.js';

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
  await page.setViewportSize({ width: 1600, height: 800 }); // wide enough that nothing overflows into More
  await settle(); await settle();
  const groups = await page.$$eval('.tb-tools > .tb-tg', (gs) => gs.filter((g) => g.children.length).map((g) => g.getAttribute('aria-label')));
  check(JSON.stringify(groups) === JSON.stringify(['Navigate', 'Pages', 'View', 'Edit', 'Comment', 'Stamp and sign']), `groups: ${groups}`);
  const inGroup = await page.$$eval('.tb-tg', (gs) => Object.fromEntries(gs.map((g) => [g.dataset.group, [...g.children].map((c) => c.dataset.tbItem)])));
  check(inGroup.navigate.join() === 'select,hand' && inGroup.edit[0] === 'text' && inGroup.comment.includes('highlight') && inGroup.sign.join() === 'stamp,sign' && inGroup.pages.join() === 'pages' && inGroup.view.join() === 'split', `group members: ${JSON.stringify(inGroup)}`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await settle(); await settle();

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

  step = 'options row after drawing a shape';
  const optRow = () => page.evaluate(() => { const o = document.querySelector('.options-bar'); return { hidden: o.hidden || o.offsetHeight === 0, sel: window.ashStudio.annotations.getSelection(window.ashStudio.state.tabs[0]).length }; });
  const scrollTop = () => page.evaluate(() => document.querySelector('.viewer-scroll:not([hidden])').scrollTop);
  const st0 = await scrollTop();
  await page.click('.tb-btn[data-tool="shapes"]');
  check((await tool()) === 'shapes', 'Shapes selected');
  const pb = await (await page.$('.viewer-scroll:not([hidden]) .page')).boundingBox();
  const cx = pb.x + pb.width / 2, cy = pb.y + 200;
  await page.mouse.move(cx - 60, cy - 40); await page.mouse.down(); await page.mouse.move(cx + 60, cy + 40, { steps: 5 }); await page.mouse.up();
  await page.click('.tb-btn[data-tool="shapes"]');
  check((await tool()) === 'select', 'second click on Shapes returns to Select');
  let orow = await optRow();
  check(orow.sel === 0 && orow.hidden, `after second click: selection ${orow.sel}, options hidden ${orow.hidden}`);
  await page.mouse.click(cx, cy - 40); // the rectangle's top edge
  orow = await optRow();
  check(orow.sel === 1 && !orow.hidden, `selected rectangle: selection ${orow.sel}, options hidden ${orow.hidden}`);
  await page.mouse.click(cx + 150, cy + 150);
  orow = await optRow();
  check(orow.sel === 0 && orow.hidden, `empty click: selection ${orow.sel}, options hidden ${orow.hidden}`);
  check((await scrollTop()) === st0, 'scrollTop changed while the options row appeared/disappeared');

  // Opens dropdown #id (via More when it has overflowed) and picks item data-id=item.
  const inMore = (id) => page.evaluate((s) => !!document.querySelector(s).closest('.tb-more-panel'), `#${id}`);
  const pick = async (id, item) => {
    if (await inMore(id)) await page.click('.tb-more-btn');
    await page.click(`#${id}`);
    await page.click(`#${id} + .tb-dd-menu .menu-item[data-id="${item}"]`);
  };
  const tabInfo = () => page.evaluate(() => { const t = window.ashStudio.state.tabs[0]; return { n: t.numPages, rot: t.pages?.[0]?.rotate }; });
  const pressed = () => page.getAttribute('#btn-split', 'aria-pressed');
  const panes = () => page.evaluate(() => [...document.querySelectorAll('.viewer-scroll[data-pane]')].filter((el) => !el.hidden).length);

  step = 'Pages > Rotate right';
  check((await tabInfo()).rot === 0, `page 1 rotation before: ${(await tabInfo()).rot}`);
  await pick('btn-pages', 'rotate-right');
  await page.waitForFunction(() => window.ashStudio.state.tabs[0].pages?.[0]?.rotate === 90, null, { timeout: 10_000 }).catch(() => {});
  check((await tabInfo()).rot === 90, `page 1 rotation after Rotate right: ${(await tabInfo()).rot}`);

  step = 'Pages > Insert blank page';
  await pick('btn-pages', 'insert-blank');
  await page.waitForFunction(() => window.ashStudio.state.tabs[0].numPages === 3, null, { timeout: 10_000 }).catch(() => {});
  check((await tabInfo()).n === 3, `pages after Insert blank page: ${(await tabInfo()).n}`);

  step = 'Split > Split vertically';
  check((await pressed()) === 'false', `Split pressed before splitting: ${await pressed()}`);
  await pick('btn-split', 'split-v');
  await page.waitForFunction(() => document.querySelector('.viewer-host.split.split-v'), null, { timeout: 5_000 }).catch(() => {});
  check((await panes()) === 2, `panes after Split vertically: ${await panes()}`);
  check((await pressed()) === 'true', `Split not pressed while split: ${await pressed()}`);

  step = 'Split > Unsplit';
  await pick('btn-split', 'unsplit');
  check(!(await page.$('.viewer-host.split')) && (await panes()) === 0, `still split after Unsplit (${await panes()} panes)`);
  check((await pressed()) === 'false', `Split still pressed after Unsplit: ${await pressed()}`);

  step = 'dropdown keyboard';
  const focused = () => page.evaluate(() => document.activeElement?.dataset.id ?? document.activeElement?.id ?? '');
  const menuOpen = (id) => page.evaluate((s) => !document.querySelector(s).hidden, `#${id} + .tb-dd-menu`);
  const keys = async (id) => {
    await page.focus(`#${id}`);
    for (const k of ['Enter', ' ', 'ArrowDown']) {
      await page.keyboard.press(k);
      check(await menuOpen(id), `${id}: ${k} did not open the menu`);
      const first = await focused();
      check(first && first !== id, `${id}: ${k} left focus on ${first}`);
      await page.keyboard.press('ArrowDown');
      const second = await focused();
      check(second && second !== first, `${id}: ArrowDown did not move (${first} -> ${second})`);
      await page.keyboard.press('ArrowUp');
      check((await focused()) === first, `${id}: ArrowUp did not move back`);
      await page.keyboard.press('Escape');
      check(!(await menuOpen(id)) && (await focused()) === id, `${id}: Esc did not close to the button`);
    }
  };
  await keys('btn-pages');
  await keys('btn-split');

  // With the Edit text and Edit image tools the full set needs a 1366 px window (the common laptop width);
  // narrower windows move the last tools into More (checked below at 900 px).
  step = 'labels off: nothing in More at 1366';
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.waitForTimeout(200);
  const moreCount = () => page.evaluate(() => ({ n: document.querySelectorAll('.tb-more-panel .tb-btn').length, shown: !document.querySelector('.tb-more').hidden }));
  check((await moreCount()).n === 0 && !(await moreCount()).shown, `1366 without labels: More holds ${JSON.stringify(await moreCount())}`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(200);

  // Computed colours of a tool's icon, its button and the toolbar.
  const colours = (sel) => page.evaluate((s) => {
    const b = document.querySelector(s), cs = (el) => getComputedStyle(el);
    const bg = cs(b).backgroundColor;
    return { icon: cs(b.querySelector('svg.icon')).color, btn: bg === 'rgba(0, 0, 0, 0)' ? cs(document.querySelector('.toolbar')).backgroundColor : bg, bar: cs(document.querySelector('.toolbar')).backgroundColor, text: cs(document.querySelector('.toolbar')).color };
  }, sel);
  const setTheme = (t) => page.evaluate((x) => { document.documentElement.dataset.theme = x; }, t);
  for (const theme of ['light', 'dark']) {
    step = `group colours (${theme})`;
    await setTheme(theme);
    const c = await colours('.tb-btn[data-tool="highlight"]'), e = await colours('.tb-btn[data-tool="text"]');
    check(c.icon !== e.icon, `${theme}: Comment and Edit icons share ${c.icon}`);
    check(c.icon !== c.text, `${theme}: Comment icon is the monochrome ${c.text}`);
    for (const x of [c, e]) check(contrastRatio(x.icon, x.bar) >= 3, `${theme}: icon ${x.icon} on ${x.bar} below 3:1`);
    step = `pressed and hovered (${theme})`;
    await page.hover('.tb-btn[data-tool="select"]');
    const p = await colours('.tb-btn[data-tool="select"]');
    check(contrastRatio(p.icon, p.btn) >= 3, `${theme}: hovered pressed Select icon ${p.icon} on ${p.btn} below 3:1`);
    await page.mouse.move(640, 600);
  }
  await setTheme('light');

  step = 'arrow keys skip hidden buttons';
  await page.setViewportSize({ width: 900, height: 800 });
  await settle(); await settle();
  check((await moreCount()).n > 0, '900: nothing in More');
  // From Select (past the zoom box, which keeps the arrow keys) to the end of the row and round.
  await page.focus('.tb-btn[data-tool="select"]');
  const total = await page.$$eval('.tb-tools button', (bs) => bs.filter((b) => b.getClientRects().length).length);
  for (let n = 0; n < total; n++) {
    await page.keyboard.press('ArrowRight');
    const f = await page.evaluate(() => { const a = document.activeElement; return { shown: a.getClientRects().length > 0, label: a.getAttribute('aria-label') ?? a.textContent }; });
    check(f.shown, `ArrowRight focused hidden "${f.label}"`);
  }

  step = 'Sign menu leaves More alone';
  check(await inMore('btn-sign'), '900: Sign not in More');
  await page.evaluate(() => { window.__moreMut = 0; new MutationObserver((r) => { window.__moreMut += r.length; }).observe(document.querySelector('.tb-more-panel'), { childList: true }); });
  await page.click('.tb-more-btn');
  await page.click('#btn-sign');
  await page.waitForFunction(() => !document.querySelector('.sign-menu').hidden);
  await settle(); await settle();
  check((await page.evaluate(() => window.__moreMut)) === 0, `opening More and Sign changed the More panel (${await page.evaluate(() => window.__moreMut)} mutations)`);
  check(await page.locator('.sign-menu').isVisible(), 'Sign menu not visible in More');
  await page.keyboard.press('Escape');
  await page.mouse.click(640, 600);
  await page.setViewportSize({ width: 1280, height: 800 });
  await settle(); await settle();

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

  step = 'dropdown keyboard inside More';
  check(await inMore('btn-split'), 'at 900 px Split is not in More');
  await keys('btn-split');
  check(await page.locator('.tb-more-panel').isVisible(), 'Esc in the Split menu also closed More');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); // Split vertically from the keyboard, inside More
  await page.waitForFunction(() => document.querySelector('.viewer-host.split.split-v'), null, { timeout: 5_000 }).catch(() => {});
  check((await panes()) === 2 && (await pressed()) === 'true', `keyboard Split vertically in More: ${await panes()} panes, pressed ${await pressed()}`);
  await pick('btn-split', 'unsplit');
  check((await panes()) === 0, 'Unsplit from More');
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
  step = 'colours off persists';
  check((await page.evaluate(() => JSON.parse(localStorage.getItem('ash-pdf-studio:ui.toolColors') ?? 'null'))) === null, 'ui.toolColors stored before toggling');
  await page.keyboard.press('Escape');
  await page.click('.menu-btn:text-is("View")');
  await page.click('.menu-item[data-id="toolcolors"]');
  const mono = async () => { const x = await colours('.tb-btn[data-tool="highlight"]'), y = await colours('.tb-btn[data-tool="text"]'); return x.icon === x.text && y.icon === y.text; };
  check(await mono(), 'View > Coloured tool icons off: icons not monochrome');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await settle();
  check(await page.$('.tb-btn[data-tool="highlight"]'), 'no Highlight tool after reload');
  check(await mono(), 'Coloured tool icons off not persisted after reload');
  check(problems.length === 0, problems.join('\n'));
  console.log('E2E OK');
} catch (err) {
  console.error(`E2E FAILED at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
