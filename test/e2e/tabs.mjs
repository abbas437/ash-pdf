#!/usr/bin/env node
// Tab strip e2e: inactive tabs have their own surface, drag / keyboard reorder keeps the active document,
// toolbar group centred, icons centred in their buttons, Export to image page-range hint. Prints "E2E OK".
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
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const problems = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 900 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  for (const name of ['one.pdf', 'two.pdf', 'three.pdf']) {
    const doc = await PDFDocument.create();
    for (let n = 0; n < 3; n++) doc.addPage([612, 792]);
    const chooser = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
    await page.waitForFunction((n) => window.ashStudio.state.tabs.length === n && window.ashStudio.state.tabs.every((t) => t.view), ['one.pdf', 'two.pdf', 'three.pdf'].indexOf(name) + 1);
  }
  await settle();
  const names = () => page.$$eval('.doc-tab .tab-name', (els) => els.map((e) => e.textContent));
  const active = () => page.evaluate(() => window.ashStudio.state.tabs.find((t) => t.id === window.ashStudio.state.activeId).name);
  check((await names()).join() === 'one.pdf,two.pdf,three.pdf', `names ${await names()}`);

  step = 'inactive tab surface';
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => window.ashStudio.setTheme?.(t) ?? (document.documentElement.dataset.theme = t), theme);
    await settle();
    const bg = await page.evaluate(() => {
      const c = (s) => getComputedStyle(document.querySelector(s)).backgroundColor;
      const inactive = [...document.querySelectorAll('.doc-tab[aria-selected="false"]')];
      return { menubar: c('.titlebar'), inactive: inactive.map((e) => getComputedStyle(e).backgroundColor), active: c('.doc-tab[aria-selected="true"]'), radius: getComputedStyle(inactive[0]).borderTopLeftRadius, border: getComputedStyle(inactive[0]).borderLeftWidth };
    });
    check(bg.inactive.length === 2 && bg.inactive.every((b) => b !== bg.menubar && b !== 'rgba(0, 0, 0, 0)'), `${theme}: inactive ${bg.inactive} vs titlebar ${bg.menubar}`);
    check(bg.active !== bg.inactive[0] && parseFloat(bg.radius) > 0 && bg.border === '1px', `${theme}: ${JSON.stringify(bg)}`);
  }
  await page.evaluate(() => { document.documentElement.removeAttribute('data-theme'); window.ashStudio.setTheme?.('light'); });

  step = 'drag reorder';
  await page.evaluate(() => window.ashStudio.activate?.(window.ashStudio.state.tabs[1].id));
  await page.click('.doc-tab >> nth=1');
  check((await active()) === 'two.pdf', 'tab 2 active');
  const box = async (i) => (await page.locator('.doc-tab').nth(i).boundingBox());
  const b3 = await box(2), b1 = await box(0);
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2);
  await page.mouse.down();
  await page.mouse.move(b3.x + b3.width / 2 - 40, b3.y + b3.height / 2, { steps: 4 });
  await page.mouse.move(b1.x + 6, b1.y + b1.height / 2, { steps: 8 });
  check(await page.locator('.doc-tab.drop-left').count() === 1, 'drop indicator shown');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await settle();
  check((await names()).join() === 'one.pdf,two.pdf,three.pdf', `Esc cancels: ${await names()}`);
  check(await page.locator('.doc-tab.drop-left, .doc-tab.dragging').count() === 0, 'indicator cleared after Esc');
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2);
  await page.mouse.down();
  await page.mouse.move(b1.x + 6, b1.y + b1.height / 2, { steps: 12 });
  await page.mouse.up();
  await settle();
  check((await names()).join() === 'three.pdf,one.pdf,two.pdf', `after drag: ${await names()}`);
  check((await active()) === 'two.pdf', `active after drag: ${await active()}`);

  step = 'keyboard reorder';
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+Shift+PageUp');
  await settle();
  check((await names()).join() === 'three.pdf,two.pdf,one.pdf', `PgUp: ${await names()}`);
  check((await active()) === 'two.pdf', 'active unchanged after PgUp');
  await page.keyboard.press('Control+Shift+PageDown');
  await page.keyboard.press('Control+Shift+PageDown');
  await settle();
  check((await names()).join() === 'three.pdf,one.pdf,two.pdf', `PgDn x2 (clamped): ${await names()}`);
  const order = await page.evaluate(() => window.ashStudio.state.tabs.map((t) => t.name).join());
  check(order === 'three.pdf,one.pdf,two.pdf', `state order ${order}`);

  step = 'toolbar centred';
  const gap = await page.evaluate(() => {
    const bar = document.querySelector('.toolbar'), r = bar.getBoundingClientRect();
    const kids = [...bar.children].filter((c) => c.offsetWidth);
    const left = Math.min(...kids.map((c) => c.getBoundingClientRect().left)), right = Math.max(...kids.map((c) => c.getBoundingClientRect().right));
    return { l: left - r.left, r: r.right - right };
  });
  check(Math.abs(gap.l - gap.r) <= 2 && gap.l > 20, `toolbar gaps ${JSON.stringify(gap)}`);

  step = 'icons centred in buttons';
  const off = await page.evaluate(() => [...document.querySelectorAll('.toolbar .tb-btn')].filter((b) => b.offsetWidth && b.querySelector('svg') && !b.classList.contains('has-text') && !b.querySelector('.tb-dd-label') && !b.classList.contains('sign-btn')).map((b) => {
    const a = b.getBoundingClientRect(), s = b.querySelector('svg').getBoundingClientRect();
    return { id: b.id || b.title, dx: (s.left + s.width / 2) - (a.left + a.width / 2), dy: (s.top + s.height / 2) - (a.top + a.height / 2) };
  }).filter((o) => Math.abs(o.dx) > 0.5 || Math.abs(o.dy) > 0.5));
  check(off.length === 0, `icons off-centre: ${JSON.stringify(off)}`);

  step = 'export hint';
  await page.evaluate(() => window.ashStudio.state.tabs.length);
  await page.click('.menu-btn:has-text("File")');
  await page.click('.menu-item:has-text("Export to image")');
  await page.waitForSelector('.xp-img-dialog');
  const hint = await page.textContent('.xp-img-dialog .xp-img-hint');
  check(hint === "Examples: 1-3, 5, 8-10 · leave empty for all pages · 'current' for this page", `hint: ${hint}`);
  check(await page.evaluate(() => { const p = document.querySelector('#xp-img-page').closest('.vx-field'); return p.nextElementSibling.classList.contains('xp-img-hint'); }), 'hint sits under Pages');
  if (problems.length) throw new Error(problems.join('; '));
  console.log('E2E OK');
} catch (err) {
  console.error(`E2E FAIL at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally { await browser.close(); server.close(); }
