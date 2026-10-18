#!/usr/bin/env node
// Tab strip context menu e2e: right-click a tab -> Close / Close other tabs / Close tabs to the left / to the right /
// Close all tabs. Items that would close nothing are disabled; an unsaved tab asks first and Cancel stops the rest.
// Prints "TABMENU OK".
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  const pdf = async () => { const d = await PDFDocument.create(); d.addPage([300, 300]); return [...await d.save()]; };
  const open = async (names) => {
    const before = await page.evaluate(() => window.ashStudio.state.tabs.length);
    for (const name of names) await page.evaluate(([n, b]) => window.ashStudio.openBytes({ name: n, bytes: new Uint8Array(b) }), [name, await pdf()]);
    await page.waitForFunction((n) => window.ashStudio.state.tabs.length === n, before + names.length);
  };
  const names = () => page.$$eval('.doc-tab .tab-name', (els) => els.map((e) => e.textContent).join(','));
  const menu = async (tabName) => {
    await page.locator('.doc-tab', { hasText: tabName }).click({ button: 'right' });
    await page.waitForSelector('.tab-ctx-menu');
    return page.$$eval('.tab-ctx-menu .menu-item', (els) => Object.fromEntries(els.map((e) => [e.dataset.id, !e.disabled])));
  };
  const choose = async (id) => { await page.click(`.tab-ctx-menu .menu-item[data-id="${id}"]`); await page.waitForTimeout(150); };

  step = 'open four documents';
  await open(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']);
  check((await names()) === 'a.pdf,b.pdf,c.pdf,d.pdf', `names ${await names()}`);

  step = 'enabled items depend on the position';
  let m = await menu('a.pdf');
  check(m.close && m['close-others'] && !m['close-left'] && m['close-right'] && m['close-all'], `first tab: ${JSON.stringify(m)}`);
  await page.keyboard.press('Escape');
  check(!(await page.$('.tab-ctx-menu')), 'Escape closes the menu');
  m = await menu('d.pdf');
  check(m['close-left'] && !m['close-right'], `last tab: ${JSON.stringify(m)}`);
  await page.keyboard.press('Escape');

  step = 'close tabs to the right';
  await menu('b.pdf'); await choose('close-right');
  check((await names()) === 'a.pdf,b.pdf', `after right: ${await names()}`);

  step = 'close tabs to the left';
  await open(['e.pdf']);
  await menu('b.pdf'); await choose('close-left');
  check((await names()) === 'b.pdf,e.pdf', `after left: ${await names()}`);

  step = 'close other tabs';
  await open(['f.pdf', 'g.pdf']);
  await menu('f.pdf'); await choose('close-others');
  check((await names()) === 'f.pdf', `after others: ${await names()}`);
  check(await page.evaluate(() => window.ashStudio.state.tabs.find((t) => t.id === window.ashStudio.state.activeId)?.name === 'f.pdf'), 'f.pdf active');

  step = 'close this tab';
  await open(['h.pdf']);
  await menu('h.pdf'); await choose('close');
  check((await names()) === 'f.pdf', `after close: ${await names()}`);

  step = 'close all: an unsaved tab asks; Cancel stops the rest';
  await open(['i.pdf', 'j.pdf']);
  await page.evaluate(() => { const t = window.ashStudio.state.tabs.find((x) => x.name === 'i.pdf'); window.ashStudio.markDirty(t); });
  await menu('j.pdf'); await choose('close-all');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  check((await page.textContent('[role="dialog"]')).includes('i.pdf'), 'asks about i.pdf');
  await page.click('[role="dialog"] button:has-text("Cancel")');
  await page.waitForTimeout(200);
  check((await names()) === 'i.pdf,j.pdf', `cancel stopped after f.pdf closed: ${await names()}`);

  step = 'close all: Don\'t save closes everything';
  await menu('i.pdf'); await choose('close-all');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.click('[role="dialog"] button:has-text("Don\'t save")');
  await page.waitForFunction(() => window.ashStudio.state.tabs.length === 0, null, { timeout: 5000 });

  check(problems.length === 0, `errors: ${problems.join(' | ')}`);
  console.log('TABMENU OK');
} catch (err) {
  console.error(`tabmenu e2e FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
