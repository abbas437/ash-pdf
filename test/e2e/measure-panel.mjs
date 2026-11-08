#!/usr/bin/env node
// End-to-end test of the Measurements sidebar tab (renderer/ui/measurements.js): rows grouped by
// page, totals, empty state, click to go to the page and select, refresh on delete and on document
// switch, Export CSV. Prints "MEASURE PANEL OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}
const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}:\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const until = async (fn, msg, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error(msg); await page.waitForTimeout(50); }
  };
  const open = async (name, buffer, n) => {
    const chooser = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction((k) => window.ashStudio.state.tabs.length === k && window.ashStudio.state.tabs.at(-1).pdfDoc, n, { timeout: 10_000 });
  };
  const P = '[data-sb-panel="measurements"]';
  // [[heading, [[kind, value, scale, label]...]]...] and [[total label, total]...]
  const panel = () => page.$eval(P, (p) => {
    const groups = [];
    for (const el of p.querySelectorAll('.cm-page, .ms-item')) {
      if (el.matches('.cm-page')) groups.push([el.firstChild.textContent, []]);
      else groups.at(-1)[1].push([el.querySelector('.ms-kind').textContent, el.querySelector('.ms-value').textContent, el.querySelector('.ms-scale')?.textContent ?? '', el.querySelector('.ms-label')?.textContent ?? '']);
    }
    return { groups, totals: [...p.querySelectorAll('.ms-total')].map((t) => [...t.children].map((c) => c.textContent)), empty: p.querySelector('.sb-empty')?.textContent ?? null };
  });

  // window.api is frozen by the browser shim: wrap saveFile as the shim installs it, to capture the bytes.
  await page.addInitScript(() => {
    let api;
    Object.defineProperty(window, 'api', { configurable: true, get: () => api, set: (real) => {
      api = { ...real, saveFile: async (o) => { window.__saved = { defaultPath: o.defaultPath, filters: o.filters, bytes: [...o.bytes] }; return { path: '/tmp/measurements.csv' }; } };
    } });
  });

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await open('takeoff.pdf', await makePdf(3), 1);

  step = 'empty state';
  await ev("app.state.sidebarOpen = true; app.showSidebarTab('measurements');");
  await page.waitForSelector(`${P} .sb-empty`);
  eq((await panel()).empty, 'No measurements yet. Use Distance, Perimeter or Area in the toolbar.', 'empty state');
  check(await page.isDisabled(`${P} .ms-export`), 'Export CSV is disabled without measurements');

  step = 'create';
  const ids = await ev(`const { scaleFromDrawingScale } = await import('/src/core/measure.js');
    const s = scaleFromDrawingScale(100, 'm'), pt = (m) => m / s.ratio;
    const ms = (kind) => ({ kind, scale: s });
    return [
      an.add(tab, { type: 'line', page: 2, x1: 100, y1: 100, x2: 100 + pt(7.5), y2: 100, stroke: '#d32f2f', strokeWidth: 1, measure: ms('distance') }).id,
      an.add(tab, { type: 'polygon', page: 2, points: [[100, 300], [100 + pt(2), 300], [100 + pt(2), 300 + pt(3)], [100, 300 + pt(3)]], stroke: '#d32f2f', strokeWidth: 1, measure: ms('area'), note: 'Pump room, "B"' }).id,
      an.add(tab, { type: 'line', page: 0, x1: 100, y1: 200, x2: 100 + pt(5), y2: 200, stroke: '#d32f2f', strokeWidth: 1, measure: ms('distance'), note: 'Duct run' }).id,
      an.add(tab, { type: 'rect', page: 0, x: 72, y: 100, w: 120, h: 60, stroke: '#e00000', strokeWidth: 2, note: 'not a measurement' }).id,
    ];`);
  const [d75, area, d5] = ids;
  await until(async () => (await page.locator(`${P} .ms-item`).count()) === 3, 'three measurement rows');
  const p1 = await panel();
  eq(p1.groups, [
    ['Page 1', [['Distance', '5.000 m', 'Scale 1:100', 'Duct run']]],
    ['Page 3', [['Distance', '7.500 m', 'Scale 1:100', ''], ['Area', '6.00 m²', 'Scale 1:100', 'Pump room, "B"']]],
  ], 'rows grouped by page');
  eq(p1.totals, [['Distance total', '12.500 m'], ['Area total', '6.00 m²']], 'totals');
  eq(await page.$$eval(`${P} .ms-item`, (els) => els.map((e) => e.dataset.id)), [d5, d75, area], 'row ids in order');

  step = 'click goes to the page and selects';
  eq(await ev('return tab.currentPage;'), 0, 'starts on page 1');
  await page.click(`${P} .ms-item[data-id="${area}"]`);
  await until(async () => (await ev('return tab.currentPage;')) === 2, `page should be 3, is ${await ev('return tab.currentPage + 1;')}`);
  eq(await ev('return an.getSelection(tab);'), [area], 'area selected');
  await until(async () => (await page.getAttribute(`${P} .ms-item[data-id="${area}"]`, 'aria-current')) === 'true', 'selected row is marked');

  step = 'delete refreshes';
  await ev('an.remove(tab, [arg]);', d75);
  await until(async () => (await page.locator(`${P} .ms-item`).count()) === 2, 'two rows after delete');
  const p2 = await panel();
  eq(p2.groups.map(([g, items]) => [g, items.map((x) => x[1])]), [['Page 1', ['5.000 m']], ['Page 3', ['6.00 m²']]], 'rows after delete');
  eq(p2.totals, [['Distance total', '5.000 m'], ['Area total', '6.00 m²']], 'totals after delete');

  step = 'document switch refreshes';
  const first = await ev('return tab.id;');
  await open('other.pdf', await makePdf(1), 2);
  await until(async () => (await panel()).empty !== null, 'other document shows the empty state');
  await ev('app.activate(arg);', first);
  await until(async () => (await page.locator(`${P} .ms-item`).count()) === 2, 'back to the first document: two rows');

  step = 'export CSV';
  await ev('window.__saved = null;');
  await page.click(`${P} .ms-export`);
  await until(async () => (await ev('return !!window.__saved;')), 'saveFile called');
  const saved = await ev('return window.__saved;');
  eq([saved.defaultPath, saved.filters], ['takeoff-measurements.csv', [{ name: 'CSV', extensions: ['csv'] }]], 'save options');
  const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(saved.bytes));
  const vals = await ev('const { measurementRows } = await import("/renderer/ui/measurements-lib.js"); return measurementRows(tab.objects).map((r) => String(r.value));');
  eq(csv, `﻿Page,Kind,Value,Unit,Scale,Label\r\n1,Distance,${vals[0]},m,1:100,Duct run\r\n3,Area,${vals[1]},m²,1:100,"Pump room, ""B"""\r\n`, 'CSV text');
  check(Math.abs(Number(vals[0]) - 5) < 1e-9 && Math.abs(Number(vals[1]) - 6) < 1e-9, `CSV values ${vals}`);

  if (problems.length) throw new Error(problems.join('\n'));
  console.log('MEASURE PANEL OK');
} catch (err) {
  console.error(`FAILED at ${step}: ${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
