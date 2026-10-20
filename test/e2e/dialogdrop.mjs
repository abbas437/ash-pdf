#!/usr/bin/env node
// End-to-end test of the page-tool dialog sources (renderer/ui/pagetools.js): PDF files dropped on the
// Merge / Insert pages / Replace pages dialogs, and other open documents as sources. Chromium via
// playwright-core with the browser shim (same pattern as pagetools.mjs). Prints "DIALOGDROP OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf(n, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= n; k++) doc.addPage([612, 792]).drawText(`${label} ${k}`, { x: 72, y: 700, size: 28, font });
  return [...await doc.save()];
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
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const [main, extra, other] = await Promise.all([makePdf(4, 'Main'), makePdf(2, 'Extra'), makePdf(3, 'Other')]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const texts = () => ev(`const d = await v.pdfjs.getDocument({ data: tab.bytes.slice() }).promise; const out = [];
    for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join('').trim());
    await d.loadingTask.destroy(); return out;`);
  const tabCount = () => ev('return app.state.tabs.length;');
  const pages = (k) => page.waitForFunction((n) => { const a = window.ashStudio; return a.state.tabs.find((t) => t.id === a.state.activeId)?.numPages === n; }, k, { timeout: 10_000 });
  // Drag files from "Explorer" onto `sel`: dragenter, dragover, drop with a DataTransfer of File objects.
  const drop = (sel, files) => page.evaluate(({ sel, files }) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    const el = document.querySelector(sel);
    const dlg = el.closest('.dialog');
    const fire = (type) => { const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); el.dispatchEvent(e); return e.defaultPrevented; };
    const r = { enter: fire('dragenter'), over: fire('dragover'), highlighted: dlg.classList.contains('pt-drop-over') };
    r.dropped = fire('drop');
    r.after = dlg.classList.contains('pt-drop-over');
    return r;
  }, { sel, files });
  const pdf = (name, bytes) => ({ name, type: 'application/pdf', bytes });
  const listNames = () => page.$$eval('.pt-merge .pt-filelist li:not(.pt-empty) .pt-file-name', (els) => els.map((e) => e.textContent));

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  // Three open documents; "main.pdf" is the target and active one.
  await ev(`for (const [name, b] of arg) await app.openBytes({ name, bytes: new Uint8Array(b) });
    await new Promise((r) => setTimeout(r, 0));`, [['extra.pdf', extra], ['other.pdf', other], ['main.pdf', main]]);
  await page.waitForFunction(() => window.ashStudio.state.tabs.every((t) => t.numPages > 0), null, { timeout: 10_000 });
  await ev('app.activate(app.state.tabs.find((t) => t.name === "main.pdf").id);');
  await pages(4);
  eq(await tabCount(), 3, 'tabs at start');
  // Unsaved annotation on other.pdf: an open-document source is the document as Save would write it.
  await ev('const o = app.state.tabs.find((t) => t.name === "other.pdf"); app.annotations.add(o, { type: "rect", page: 0, x: 40, y: 40, w: 100, h: 60, stroke: "#d0021b", strokeWidth: 2, fill: null });');

  step = 'merge: drop files';
  await ev('pt.mergeDialog(tab);');
  await page.waitForSelector('.pt-merge #pt-merge-add');
  let r = await drop('.pt-merge .pt-filelist', [pdf('drop-a.pdf', extra), { name: 'notes.txt', type: 'text/plain', bytes: [104, 105] }]);
  eq(r, { enter: true, over: true, highlighted: true, dropped: true, after: false }, 'merge drop events (accepted, highlighted, cleared)');
  await page.waitForFunction(() => document.querySelectorAll('.pt-merge .pt-filelist li:not(.pt-empty)').length === 1, null, { timeout: 10_000 });
  await page.waitForSelector('.pt-merge .pt-error:not([hidden])');
  check((await page.textContent('.pt-merge .pt-error')).includes('"notes.txt" is not a PDF file'), 'no error for a dropped non-PDF');
  // Several at once, dropped on the dialog title (anywhere on the dialog).
  r = await drop('.pt-merge .dialog-title', [pdf('drop-b.pdf', other), pdf('drop-c.pdf', extra)]);
  check(r.dropped, 'drop on the dialog title not accepted');
  await page.waitForFunction(() => document.querySelectorAll('.pt-merge .pt-filelist li:not(.pt-empty)').length === 3, null, { timeout: 10_000 });
  eq(await listNames(), ['drop-a.pdf', 'drop-b.pdf', 'drop-c.pdf'], 'merge list after drops');
  check(await page.locator('.pt-merge .pt-error').isHidden(), 'error not cleared by a good drop');
  eq(await tabCount(), 3, 'a drop on the merge dialog opened a tab');
  check(!(await page.evaluate(() => document.body.classList.contains('drop-target'))), 'window drop highlight left on');

  step = 'merge: open document';
  const opts = await page.$$eval('#pt-merge-open option', (os) => os.map((o) => o.textContent));
  check(opts.some((t) => t.startsWith('other.pdf')) && opts.some((t) => t.startsWith('extra.pdf')), `open documents not listed: ${opts}`);
  check(!opts.some((t) => t.startsWith('main.pdf')), 'the target document is offered as a source');
  // Keyboard: choose with the arrow keys, Tab to the button, Enter.
  await page.focus('#pt-merge-open');
  await page.selectOption('#pt-merge-open', { label: opts.find((t) => t.startsWith('other.pdf')) });
  await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.activeElement?.id === 'pt-merge-add-open'), 'Add open document is not next in tab order');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.pt-merge .pt-filelist li:not(.pt-empty)').length === 4, null, { timeout: 10_000 });
  eq(await listNames(), ['drop-a.pdf', 'drop-b.pdf', 'drop-c.pdf', 'other.pdf'], 'merge list after adding an open document');
  await page.click('.pt-merge button.primary');
  await pages(4 + 2 + 3 + 2 + 3);
  const merged = await texts();
  eq(merged.slice(4), ['Extra 1', 'Extra 2', 'Other 1', 'Other 2', 'Other 3', 'Extra 1', 'Extra 2', 'Other 1', 'Other 2', 'Other 3'], 'merged pages');
  const annots = await ev('const { readAnnotations } = await import("../src/core/index.js"); return (await readAnnotations(tab.bytes)).objects.map((o) => o.page);');
  eq(annots, [11], 'unsaved annotation of the open document merged with its page');
  eq(await tabCount(), 3, 'tabs after merge');

  step = 'insert: drop, then open document';
  await ev('pt.insertFromDialog(tab);');
  await page.waitForSelector('#pt-ins-pick');
  r = await drop('#pt-ins-pages', [pdf('drop-ins.pdf', other)]);
  eq(r, { enter: true, over: true, highlighted: true, dropped: true, after: false }, 'insert drop events');
  await page.waitForFunction(() => document.querySelector('#pt-ins-file').textContent === 'drop-ins.pdf (3 pages)', null, { timeout: 10_000 });
  eq(await tabCount(), 3, 'a drop on the insert dialog opened a tab');
  await page.selectOption('#pt-ins-open', { label: (await page.$$eval('#pt-ins-open option', (os) => os.map((o) => o.textContent))).find((t) => t.startsWith('extra.pdf')) });
  await page.waitForFunction(() => document.querySelector('#pt-ins-file').textContent === 'extra.pdf (open document, 2 pages)', null, { timeout: 10_000 });
  await page.fill('#pt-ins-pages', '2');
  await page.fill('#pt-ins-after', '0');
  await page.click('.dialog button.primary');
  await pages(15);
  eq((await texts()).slice(0, 2), ['Extra 2', 'Main 1'], 'insert from an open document');

  step = 'insert: a file after an open document';
  await ev('pt.insertFromDialog(tab);');
  await page.waitForSelector('#pt-ins-pick');
  await page.selectOption('#pt-ins-open', { index: 1 });
  await page.waitForFunction(() => document.querySelector('#pt-ins-file').textContent.includes('open document'), null, { timeout: 10_000 });
  await drop('.dialog-body', [pdf('drop-ins2.pdf', other)]);
  await page.waitForFunction(() => document.querySelector('#pt-ins-file').textContent === 'drop-ins2.pdf (3 pages)', null, { timeout: 10_000 });
  eq(await page.inputValue('#pt-ins-open'), '', 'open-document choice not cleared by a dropped file');
  await page.fill('#pt-ins-pages', '3');
  await page.fill('#pt-ins-after', '0');
  await page.click('.dialog button.primary');
  await pages(16);
  eq((await texts())[0], 'Other 3', 'insert from a dropped file');

  step = 'replace: drop, then open document';
  await ev('pt.replaceDialog(tab);');
  await page.waitForSelector('#pt-rp-pick');
  r = await drop('.dialog', [pdf('drop-rp.pdf', extra)]);
  check(r.dropped && !r.after, 'replace drop not accepted');
  await page.waitForFunction(() => document.querySelector('#pt-rp-file').textContent === 'drop-rp.pdf (2 pages)', null, { timeout: 10_000 });
  eq(await tabCount(), 3, 'a drop on the replace dialog opened a tab');
  await page.selectOption('#pt-rp-open', { label: (await page.$$eval('#pt-rp-open option', (os) => os.map((o) => o.textContent))).find((t) => t.startsWith('other.pdf')) });
  await page.waitForFunction(() => document.querySelector('#pt-rp-file').textContent === 'other.pdf (open document, 3 pages)', null, { timeout: 10_000 });
  await page.fill('#pt-rp-pages', '2-3');
  await page.fill('#pt-rp-at', '1');
  await page.click('.dialog button.primary');
  let got = null;
  for (let k = 0; k < 50 && JSON.stringify(got) !== JSON.stringify(['Other 2', 'Other 3', 'Main 1']); k++) {
    await page.waitForTimeout(100);
    got = (await texts()).slice(0, 3);
  }
  eq(got, ['Other 2', 'Other 3', 'Main 1'], 'replace from an open document');

  step = 'interleave: drop, then open document';
  const n0 = await ev('return tab.numPages;');
  await ev('pt.interleaveDialog(tab);');
  await page.waitForSelector('#pt-il-pick');
  r = await drop('.dialog', [pdf('drop-il.pdf', extra)]);
  check(r.dropped && !r.after, 'interleave drop not accepted');
  await page.waitForFunction(() => document.querySelector('#pt-il-file').textContent === 'drop-il.pdf (2 pages)', null, { timeout: 10_000 });
  check((await page.textContent('.dialog')).includes('Page counts differ'), 'no page-count note for a dropped file');
  eq(await tabCount(), 3, 'a drop on the interleave dialog opened a tab');
  await page.selectOption('#pt-il-open', { label: (await page.$$eval('#pt-il-open option', (os) => os.map((o) => o.textContent))).find((t) => t.startsWith('other.pdf')) });
  await page.waitForFunction(() => document.querySelector('#pt-il-file').textContent === 'other.pdf (open document, 3 pages)', null, { timeout: 10_000 });
  await page.click('.dialog button.primary');
  await pages(n0 + 3);
  eq((await texts()).slice(0, 4), ['Other 2', 'Other 1', 'Other 3', 'Other 2'], 'interleave with an open document');
  eq(await tabCount(), 3, 'tabs at the end');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('DIALOGDROP FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('DIALOGDROP OK');
