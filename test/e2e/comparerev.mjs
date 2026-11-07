#!/usr/bin/env node
// Tools > Compare revisions (ui/comparerev.js) in Chromium with the browser shim: Rev.00 (3 pages) vs
// Rev.01 (4 pages: page 2 changed, page 3 shifted 10 pt, page 4 new). Prints "COMPAREREV OK".
// COMPARE_NO_ALIGN=1 unchecks "Align shifted pages" (the page 3 check must then fail).
// COMPAREREV_SHOTS=<dir> writes screenshots of the Differences panel in the light and dark themes there.
// Run `node scripts/vendor.js` first. Chromium path: $CHROMIUM_PATH or the sandbox default.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;


async function rev(n, { dn, extraLine = false, shift = 0 }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = doc.addPage([595.28, 841.89]);
    const dy = i === 3 ? -shift : 0;
    for (let k = 0; k < 6; k++) p.drawLine({ start: { x: 60, y: 700 - k * 80 + dy }, end: { x: 520, y: 700 - k * 80 + dy }, thickness: 1.5 });
    p.drawText(`PUMP P-10${i} ${i === 2 ? dn : 'DN100'}`, { x: 70, y: 760 + dy, size: 18, font });
    if (i === 2 && extraLine) p.drawLine({ start: { x: 100, y: 200 }, end: { x: 400, y: 300 }, thickness: 2 });
  }
  return Buffer.from(await doc.save());
}
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const problems = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const r0 = await rev(3, { dn: 'DN100' });
  const r1 = await (async () => { const b = await rev(3, { dn: 'DN150', extraLine: true, shift: 10 }); const d = await PDFDocument.load(b); const f = await d.embedFont(StandardFonts.Helvetica); d.addPage([595.28, 841.89]).drawText('NEW SHEET', { x: 70, y: 760, size: 18, font: f }); return Buffer.from(await d.save()); })();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const openFile = async (name, buffer) => {
    const chooser = page.waitForEvent('filechooser');
    await page.click('#btn-open');
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction((n) => window.ashStudio.state.tabs.some((t) => t.name === n && t.view), name);
  };
  step = 'open Rev.01 then Rev.00';
  await openFile('PS-001 Rev.01.pdf', r1);
  await openFile('PS-001 Rev.00.pdf', r0);
  step = 'Tools > Compare revisions… guesses Rev.00 as the older';
  await page.click('.menu-btn:text-is("Tools")');
  await page.click('.menu [data-id="compare-revisions"]');
  await page.waitForSelector('.compare-dialog');
  const names = await page.evaluate(() => ['#cmp-older', '#cmp-newer'].map((s) => document.querySelector(s).selectedOptions[0].textContent));
  check(names[0] === 'PS-001 Rev.00.pdf' && names[1] === 'PS-001 Rev.01.pdf', `guess: ${names}`);
  if (process.env.COMPARE_NO_ALIGN) await page.uncheck('#cmp-align');
  await page.click('.compare-dialog button.primary');
  step = 'compare tab with 4 pages';
  await page.waitForFunction(() => window.ashStudio.state.tabs.some((t) => t.compare && t.view), null, { timeout: 30_000 });
  const res = await page.evaluate(() => {
    const t = window.ashStudio.state.tabs.find((x) => x.compare);
    return { name: t.name, n: t.numPages, active: window.ashStudio.state.activeId === t.id, pages: t.compare.pages.map((p) => ({ s: p.status, r: p.regions.length, add: p.text.added.map((w) => w.text), rem: p.text.removed.map((w) => w.text) })) };
  });
  check(res.n === 4 && res.active && res.name === 'Compare – PS-001 Rev.00 vs PS-001 Rev.01.pdf', `tab: ${JSON.stringify(res)}`);
  check(res.pages[1].r > 0 && res.pages[1].add.includes('DN150') && res.pages[1].rem.includes('DN100'), `page 2: ${JSON.stringify(res.pages[1])}`);
  check(res.pages[2].r === 0, `page 3 aligned, no areas: ${JSON.stringify(res.pages[2])}`);
  check(res.pages[3].s === 'added', `page 4 added: ${JSON.stringify(res.pages[3])}`);
  step = 'annotations in the compare PDF';
  const ann = await page.evaluate(async () => {
    const t = window.ashStudio.state.tabs.find((x) => x.compare);
    const out = [];
    for (let i = 0; i < t.numPages; i++) out.push((t.objects ?? []).filter((o) => o.page === i && o.author === 'Compare').map((o) => String(o.note ?? '')));
    const txt = (await t.pages[3].getTextContent()).items.map((x) => x.str).join(' ');
    return { out, txt };
  });
  // the drawn-in line: an area of added ink with no text in it, noted exactly as compareReport words it
  check(ann.out[1].some((c) => /^Change [0-9]+: added$/.test(c)), `page 2 squares: ${JSON.stringify(ann.out[1])}`);
  check(ann.out[2].length === 0, `page 3 none: ${JSON.stringify(ann.out[2])}`);
  check(/Page only in the newer revision/.test(ann.txt), `page 4 note: ${ann.txt}`);
  step = 'Differences panel lists + DN150 and − DN100; click scrolls to page 2';
  await page.waitForSelector('.cmp-list');
  const items = await page.$$eval('.cmp-item', (els) => els.map((e) => e.textContent));
  check(items.includes('+ DN150') && items.includes('− DN100') && items.some((s) => s.startsWith('Page 2 — ')), `items: ${items}`);
  await page.evaluate(() => { const t = window.ashStudio.state.tabs.find((x) => x.compare); window.ashStudio.viewer.scrollToPage(t, 3); });
  await page.click('.cmp-item:text-is("+ DN150")');
  await page.waitForFunction(() => window.ashStudio.state.tabs.find((x) => x.compare).currentPage === 1, null, { timeout: 5000 });
  await page.waitForSelector('svg.cmp-flash');
  step = 'Side by side opens a split with sync on';
  await page.click('.cmp-sbs');
  await page.waitForFunction(() => document.querySelector('.viewer-host.split'));
  const sync = await page.evaluate(async () => (await import('./ui/splitview.js')).splitView.state);
  check(sync?.sync === true, `split: ${JSON.stringify(sync)}`);
  await page.evaluate(async () => (await import('./ui/splitview.js')).splitView.unsplit());
  await page.evaluate(() => window.ashStudio.activate(window.ashStudio.state.tabs.find((x) => x.compare).id));
  step = 'Copy list puts diffText on the system clipboard (api.copyText)';
  const want = await page.evaluate(async () => (await import('./ui/comparerev-lib.js')).diffText(window.ashStudio.state.tabs.find((x) => x.compare).compare.pages));
  await page.click('.cmp-copy');
  await page.waitForFunction((w) => window.__ashShim.clipboardText() === w, want, { timeout: 5000 });
  check(/^Page 2 — [0-9]+ areas?, text: \+1 \/ −1\n/.test(want) && want.includes('\n  + DN150') && want.includes('Page 4 — only in the newer revision'), `copied: ${want}`);
  step = 'Export CSV downloads the list with a BOM and the header row';
  const dl = page.waitForEvent('download');
  await page.click('.cmp-csv');
  const download = await dl;
  const chunks = [];
  for await (const c of await download.createReadStream()) chunks.push(c);
  const csv = Buffer.concat(chunks).toString('utf8');
  check(csv.startsWith('\uFEFFNewer page,Older page,Kind,Item,Text\r\n') && csv.includes("\r\n2,2,text added,'+ DN150,DN150\r\n") && csv.includes('\r\n2,2,text removed,− DN100,DN100\r\n') && csv.includes('\r\n4,,page,Page only in the newer revision,\r\n'), `csv: ${JSON.stringify(csv)}`);
  if (process.env.COMPAREREV_SHOTS) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
      await page.screenshot({ path: join(process.env.COMPAREREV_SHOTS, `comparerev-panel-${theme}.png`), clip: { x: 0, y: 0, width: 640, height: 800 } });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = window.ashStudio.state.theme; });
  }
  step = 'a reopened compare PDF: the Differences panel lists its areas from the compare marks';
  const saved = await page.evaluate(() => [...window.ashStudio.state.tabs.find((x) => x.compare).bytes]);
  const marks = ann.out.flat().length;
  await openFile('Compare saved.pdf', Buffer.from(saved));
  await page.waitForFunction(() => window.ashStudio.state.tabs.find((t) => t.name === 'Compare saved.pdf')?.id === window.ashStudio.state.activeId);
  await page.waitForSelector('.cmp-note:text-matches("Saved compare document")');
  const reopened = await page.$$eval('.cmp-item', (els) => els.map((e) => e.textContent));
  const heads = reopened.filter((s) => / — [0-9]+ marks?$/.test(s));
  check(heads[0]?.startsWith('Page 2 — ') && reopened.length - heads.length === marks && reopened.filter((s) => /^Change [0-9]+: added$/.test(s)).length >= 1, `reopened: ${JSON.stringify(reopened)} (${marks} marks)`);
  await page.click('.cmp-copy');
  check(reopened.includes('Change 1: added and removed') && reopened.includes('Change 2: added') && reopened.includes('+ DN150') && reopened.includes('− DN100'), `reopened kinds / text: ${JSON.stringify(reopened)}`);
  await page.waitForFunction(() => /^Page 2 — 2 areas, text: \+1 \/ −1\n  Change 1: added and removed\n  Change 2: added\n  \+ DN150\n  − DN100$/.test(window.__ashShim.clipboardText()), null, { timeout: 5000 });
  step = 'a reopened compare PDF: area kinds and text changes come from the marks';
  const synth = await page.evaluate(async () => {
    const { buildCompareReport } = await import('/src/core/index.js');
    const c = document.createElement('canvas'); c.width = 60; c.height = 80;
    const png = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
    const bytes = await buildCompareReport([{ width: 300, height: 400, image: { bytes: png, type: 'png' }, status: 'compared',
      regions: [{ x: 20, y: 40, w: 40, h: 20, added: 30, removed: 0 }, { x: 20, y: 100, w: 40, h: 20, added: 0, removed: 30 }, { x: 20, y: 160, w: 40, h: 20, added: 10, removed: 10 }],
      textChanges: { added: [{ text: 'LOOSE NEW', box: { x: 150, y: 300, w: 60, h: 10 } }], removed: [{ text: 'LOOSE OLD', box: { x: 150, y: 330, w: 60, h: 10 } }] } }],
    { older: { name: 'a.pdf' }, newer: { name: 'b.pdf' }, date: new Date() });
    return [...bytes];
  });
  await openFile('Compare synthetic.pdf', Buffer.from(synth));
  await page.waitForFunction(() => window.ashStudio.state.tabs.find((t) => t.name === 'Compare synthetic.pdf')?.id === window.ashStudio.state.activeId);
  await page.waitForFunction(() => [...document.querySelectorAll('.cmp-item')].some((e) => e.textContent === '+ LOOSE NEW'));
  const synthItems = await page.$$eval('.cmp-item', (els) => els.map((e) => e.textContent));
  check(synthItems.filter((s) => /^Change [0-9]+: /.test(s)).join('|') === 'Change 1: added|Change 2: removed|Change 3: added and removed'
    && synthItems.includes('+ LOOSE NEW') && synthItems.includes('− LOOSE OLD') && synthItems.some((s) => / — 5 marks$/.test(s)), `synthetic reopened: ${JSON.stringify(synthItems)}`);
  await page.click('.cmp-copy');
  await page.waitForFunction(() => { const t = window.__ashShim.clipboardText(); return /Change 1: added\n/.test(t) && /Change 2: removed\n/.test(t) && /Change 3: added and removed/.test(t) && t.includes('+ LOOSE NEW') && t.includes('− LOOSE OLD') && /Page 1 — 3 areas, text: \+1 \/ −1/.test(t); });
  await page.evaluate(() => window.ashStudio.activate(window.ashStudio.state.tabs.find((x) => x.compare).id));
  step = 'pages "2-3": the panel, CSV, bookmarks and Side by side use the source page numbers';
  await page.evaluate(async () => {
    const { parseRanges } = await import('/src/core/pdfOps.js');
    const [a, b] = ['PS-001 Rev.00.pdf', 'PS-001 Rev.01.pdf'].map((n) => window.ashStudio.state.tabs.find((t) => t.name === n));
    for (const t of [a, b]) window.ashStudio.viewer.scrollToPage(t, 0);
    await window.ashStudio.compareRevisions.compareRevisions(a, b, { indices: parseRanges('2-3', 4) });
  });
  const ranged = await page.evaluate(async () => {
    const t = window.ashStudio.state.tabs.at(-1), lib = await import('./ui/comparerev-lib.js');
    const outline = await t.pdfDoc.getOutline();
    return { n: t.numPages, active: window.ashStudio.state.activeId === t.id, csv: lib.diffCsv(t.compare.pages), pages: t.compare.pages.map((p) => [p.newerPage, p.olderPage]),
      marks: (outline ?? []).map((o) => o.title), legend: (await t.pages[0].getTextContent()).items.map((x) => x.str).join(' ') };
  });
  check(ranged.n === 2 && ranged.active && JSON.stringify(ranged.pages) === '[[2,2],[3,3]]', `range tab: ${JSON.stringify(ranged)}`);
  check(ranged.csv.includes("\r\n2,2,text added,'+ DN150,DN150\r\n") && !/\r\n1,/.test(ranged.csv), `range csv: ${JSON.stringify(ranged.csv)}`);
  check(ranged.marks[0]?.startsWith('Page 2 – ') && /Page 2 of PS-001 Rev\.01\.pdf/.test(ranged.legend), `range bookmarks / legend: ${JSON.stringify(ranged)}`);
  await page.waitForFunction(() => [...document.querySelectorAll('.cmp-item')].some((e) => e.textContent.startsWith('Page 2 — ')));
  const rangedItems = await page.$$eval('.cmp-page-head', (els) => els.map((e) => e.textContent));
  check(rangedItems.every((s) => /^Page [23] — /.test(s)) && rangedItems.length >= 1, `range panel: ${JSON.stringify(rangedItems)}`);
  await page.click('.cmp-sbs');
  await page.waitForFunction(() => document.querySelector('.viewer-host.split'));
  await page.waitForFunction(() => ['PS-001 Rev.00.pdf', 'PS-001 Rev.01.pdf'].every((n) => window.ashStudio.state.tabs.find((t) => t.name === n).currentPage === 1), null, { timeout: 5000 })
    .catch(async () => { throw new Error(`Side by side pages: ${await page.evaluate(() => JSON.stringify(window.ashStudio.state.tabs.map((t) => [t.name, t.currentPage])))}`); });
  await page.evaluate(async () => (await import('./ui/splitview.js')).splitView.unsplit());
  step = 'a page that fails is skipped: the run completes, the panel and report say "not compared"';
  await page.evaluate(() => { window.__compareFailPage = 2; });
  await page.evaluate(() => {
    const [a, b] = ['PS-001 Rev.00.pdf', 'PS-001 Rev.01.pdf'].map((n) => window.ashStudio.state.tabs.find((t) => t.name === n));
    return window.ashStudio.compareRevisions.compareRevisions(a, b, {});
  });
  await page.evaluate(() => { window.__compareFailPage = undefined; });
  const failed = await page.evaluate(async () => {
    const t = window.ashStudio.state.tabs.at(-1), lib = await import('./ui/comparerev-lib.js');
    const outline = await t.pdfDoc.getOutline();
    return { n: t.numPages, active: window.ashStudio.state.activeId === t.id, status: t.compare.pages.map((p) => p.status), csv: lib.diffCsv(t.compare.pages), text: lib.diffText(t.compare.pages),
      marks: (outline ?? []).map((o) => o.title), note: (await t.pages[1].getTextContent()).items.map((x) => x.str).join(' '), dlg: !!document.querySelector('.dialog.error') };
  });
  check(failed.n === 4 && failed.active && failed.status.join() === 'compared,error,compared,added' && !failed.dlg, `failed run: ${JSON.stringify(failed)}`);
  check(/Page 2 could not be compared: /.test(failed.note) && failed.marks.includes('Page 2 – not compared'), `failed report: ${JSON.stringify(failed)}`);
  check(/Page 2 – not compared \(/.test(failed.text) && /,page,Page 2 – not compared \(/.test(failed.csv), `failed list: ${failed.text}`);
  await page.waitForFunction(() => [...document.querySelectorAll('.cmp-page-head')].some((e) => /^Page 2 – not compared \(.+\)$/.test(e.textContent)), null, { timeout: 5000 });
  step = 'Cancel midway on a larger set leaves no new tab';
  const before = await page.evaluate(() => window.ashStudio.state.tabs.length);
  await page.evaluate(() => {
    const [a, b] = ['PS-001 Rev.00.pdf', 'PS-001 Rev.01.pdf'].map((n) => window.ashStudio.state.tabs.find((t) => t.name === n));
    window.__cmp = window.ashStudio.compareRevisions.compareRevisions(a, b, { indices: [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2], dpi: 200 });
  });
  await page.waitForFunction(() => /page [2-9] of 12/.test(document.querySelector('#compare-progress')?.textContent ?? ''), null, { timeout: 20_000 });
  await page.click('.compare-progress .dialog-buttons button'); // the title also has a help (?) button
  const back = await page.evaluate(() => window.__cmp);
  const after = await page.evaluate(() => window.ashStudio.state.tabs.length);
  check(back === null && after === before, `cancel: ${back}, tabs ${before} -> ${after}`);
  check(problems.length === 0, problems.join('\n'));
  console.log('COMPAREREV OK');
} catch (err) {
  console.error(`FAILED at "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
