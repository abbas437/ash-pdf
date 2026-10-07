#!/usr/bin/env node
// End-to-end test of renderer/ui/comments.js (Comments sidebar tab): grouping by page, click to
// select, reply + review status saved as /IRT replies and review state, reopen, status filter, CSV
// export, undo, delete, light + dark legibility. Prints "COMMENTS OK". Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { pdfjsDoc, makePdf } from '../helpers.js';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

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
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = Buffer.from(await makePdf(2));
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const obj = (id) => ev('const o = an.getObject(tab, arg); return o ? JSON.parse(JSON.stringify(o)) : null;', id);
  const until = async (fn, what, ms = 8000) => {
    const end = Date.now() + ms;
    let got;
    while (Date.now() < end) { got = await fn(); if (got === true) return; await page.waitForTimeout(50); }
    throw new Error(`${what} (last: ${JSON.stringify(got)})`);
  };
  // Panel as data: [[page heading, [[author, text, badge, replies]...]]...]
  const panel = () => page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-sb-panel="comments"] .cm-list > *')) {
      if (el.matches('.cm-page')) out.push([el.firstChild.textContent, []]);
      else if (el.matches('.cm-item')) out.at(-1)[1].push([el.querySelector('.cm-author').textContent, el.querySelector(':scope > .cm-text').textContent, el.querySelector('.cm-badge')?.textContent ?? '', [...el.querySelectorAll('.cm-reply')].map((r) => `${r.querySelector('.cm-author').textContent}: ${r.querySelector('.cm-text').textContent}`)]);
    }
    return out;
  });
  const open = async (name, buffer, n) => {
    const chooser = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction((k) => window.ashStudio.state.tabs.length === k && window.ashStudio.state.tabs.at(-1).pdfDoc, n, { timeout: 10_000 });
  };
  const item = (id) => `.cm-item[data-id="${id}"]`;

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await open('comments.pdf', pdf, 1);
  await ev("await an.setAuthor('Reviewer A');");

  step = 'create';
  const ids = await ev(`return [
    an.add(tab, { type: 'rect', page: 0, x: 72, y: 100, w: 120, h: 60, stroke: '#e00000', strokeWidth: 2, note: 'Clash with duct' }).id,
    an.add(tab, { type: 'note', page: 1, x: 300, y: 200, w: 20, h: 20, icon: 'Comment', color: '#ffd400', note: 'Check size' }).id,
    an.add(tab, { type: 'ellipse', page: 1, x: 100, y: 400, w: 80, h: 50, stroke: '#0000e0', strokeWidth: 2, note: '=SUM(1,2)' }).id];`);
  const [rectId, noteId, ellId] = ids;
  await ev("app.state.sidebarOpen = true; app.showSidebarTab('comments');");
  await page.waitForSelector('[data-sb-panel="comments"] .cm-item');
  eq(await panel(), [['Page 1', [['Reviewer A', 'Clash with duct', '', []]]], ['Page 2', [['Reviewer A', 'Check size', '', []], ['Reviewer A', '=SUM(1,2)', '', []]]]], 'panel grouped by page');

  step = 'click selects';
  await page.click(`${item(noteId)} .cm-text`);
  await until(async () => JSON.stringify(await ev('return an.getSelection(tab);')) === JSON.stringify([noteId]), 'note not selected');
  await page.waitForSelector(`${item(noteId)}.selected`);

  step = 'status + reply';
  await page.selectOption(`${item(rectId)} .cm-status`, 'accepted');
  await until(async () => (await obj(rectId)).status === 'accepted', 'status not set');
  await page.click(`${item(rectId)} [data-act="reply"]`);
  await page.waitForSelector('.cm-reply-text');
  await page.fill('.cm-reply-text', 'Rerouted above the tray');
  await page.click('.dialog-buttons button.primary');
  await until(async () => (await obj(rectId)).replies?.length === 1, 'reply not added');
  const r0 = (await obj(rectId)).replies[0];
  check(r0.author === 'Reviewer A' && r0.text === 'Rerouted above the tray' && !Number.isNaN(Date.parse(r0.date)), `reply: ${JSON.stringify(r0)}`);
  await until(async () => JSON.stringify((await panel())[0][1][0]) === JSON.stringify(['Reviewer A', 'Clash with duct', 'Accepted', ['Reviewer A: Rerouted above the tray']]), 'panel after reply');

  step = 'undo';
  await ev('an.undo(tab);');
  const afterUndo = await obj(rectId);
  check(!afterUndo.replies?.length && afterUndo.status === 'accepted', `one undo should remove only the reply: ${JSON.stringify(afterUndo)}`);
  await until(async () => (await panel())[0][1][0][3].length === 0, 'panel did not follow undo');
  await ev('an.redo(tab);');
  check((await obj(rectId)).replies?.length === 1, 'redo did not restore the reply');

  step = 'save';
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  const saved = Buffer.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  const doc = await pdfjsDoc(new Uint8Array(saved));
  const annots = await (await doc.getPage(1)).getAnnotations();
  doc.close();
  const sq = annots.find((a) => a.subtype === 'Square');
  check(sq?.contentsObj?.str === 'Clash with duct', 'rect /Contents');
  const replies = annots.filter((a) => a.inReplyTo === sq.id);
  const rep = replies.find((a) => a.contentsObj?.str === 'Rerouted above the tray');
  check(rep && rep.titleObj?.str === 'Reviewer A', `reply annotation: ${JSON.stringify(replies.map((a) => [a.contentsObj?.str, a.state, a.stateModel]))}`);
  check(replies.some((a) => a.state === 'Accepted' && a.stateModel === 'Review'), `review state: ${JSON.stringify(replies.map((a) => [a.state, a.stateModel]))}`);

  step = 'reopen';
  await open('comments-saved.pdf', saved, 2);
  await page.waitForSelector('[data-sb-panel="comments"] .cm-item');
  await until(async () => JSON.stringify(await panel()) === JSON.stringify([['Page 1', [['Reviewer A', 'Clash with duct', 'Accepted', ['Reviewer A: Rerouted above the tray']]]], ['Page 2', [['Reviewer A', 'Check size', '', []], ['Reviewer A', '=SUM(1,2)', '', []]]]]), 'reopened panel');
  const reo = await ev('return tab.objects.map((o) => JSON.parse(JSON.stringify(o)));');
  check(reo.length === 3 && reo.every((o) => o.modified || o.created), 'reopened objects carry dates');

  step = 'filter';
  await page.selectOption('[data-filter="status"]', 'accepted');
  await until(async () => (await page.locator('[data-sb-panel="comments"] .cm-item').count()) === 1, 'status filter should show 1');
  await page.selectOption('[data-filter="status"]', '');
  await until(async () => (await page.locator('[data-sb-panel="comments"] .cm-item').count()) === 3, 'filter cleared should show 3');

  step = 'csv';
  const date = (text) => { const o = reo.find((x) => x.note === text); return o.modified || o.created; };
  const dl = page.waitForEvent('download');
  await page.click('.cm-export');
  const d = await dl;
  eq(d.suggestedFilename(), 'comments-saved-comments.csv', 'csv name');
  const csv = await readFile(await d.path(), 'utf8');
  eq(csv.split('\r\n'), ['﻿page,type,author,date,status,comment,replies',
    `1,Rectangle,Reviewer A,${date('Clash with duct')},Accepted,Clash with duct,Reviewer A: Rerouted above the tray`,
    `2,Sticky note,Reviewer A,${date('Check size')},None,Check size,`,
    `2,Ellipse,Reviewer A,${date('=SUM(1,2)')},None,"'=SUM(1,2)",`, ''], 'csv rows');

  step = 'legibility';
  await page.mouse.move(700, 900);
  await page.click(`.cm-item[data-id="${reo.find((o) => o.type === 'rect').id}"] .cm-text`);
  for (const theme of ['light', 'dark']) {
    await ev(`await app.setTheme('${theme}', false);`);
    await page.mouse.move(700, 900);
    await page.waitForTimeout(150);
    await page.locator('[data-sb-panel="comments"]').screenshot({ path: join(OUT, `comments-${theme}.png`) });
    const ratios = await page.evaluate(() => {
      const rgba = (s) => s.match(/[\d.]+/g).map(Number);
      const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c.length < 4 || c[3] > 0) return c.slice(0, 3); } return [255, 255, 255]; };
      const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const p = document.querySelector('[data-sb-panel="comments"]');
      const sels = ['.cm-page', '.cm-item .cm-author', '.cm-item .cm-date', '.cm-item .cm-type', '.cm-item > .cm-text', '.cm-badge', '.cm-reply .cm-text', '.cm-act', '.cm-act.danger', '.cm-status', '.cm-filter', '.cm-reply-count'];
      return Object.fromEntries(sels.map((s) => { const el = p.querySelector(s); return [s, el ? ratio(rgba(getComputedStyle(el).color).slice(0, 3), bgOf(el)) : 0]; }));
    });
    const low = Object.entries(ratios).filter(([, r]) => r < 4.5);
    check(!low.length, `${theme} theme contrast too low: ${low.map(([s, r]) => `${s} ${r.toFixed(2)}`).join(', ')}`);
  }
  await ev("await app.setTheme('light', false);");

  step = 'delete';
  const ell = reo.find((o) => o.type === 'ellipse').id;
  await page.click(`${item(ell)} [data-act="delete"]`);
  await page.click('.dialog-buttons button.danger');
  await until(async () => !(await obj(ell)) && (await page.locator('[data-sb-panel="comments"] .cm-item').count()) === 2, 'delete');

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('COMMENTS OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
