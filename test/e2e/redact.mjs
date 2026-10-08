#!/usr/bin/env node
// End-to-end test of Apply redactions (renderer/ui/redact.js) in Chromium via playwright-core: marks a
// word with the Redact tool (X), applies it from the tool's options bar (black fill, metadata scrub)
// and checks the tab's new bytes with pdf.js (the word is gone, its neighbours stay, no mark is left);
// page Undo brings the word and the mark back, Redo removes them again; Save and reopen keep the word
// out and the metadata cleared. Prints "REDACT OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { decodedStrings } from '../helpers.js';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText('Public line', { x: 50, y: 600, size: 12, font });
  p.drawText('CONFIDENTIAL', { x: 200, y: 600, size: 12, font });
  p.drawText('Closing remark', { x: 400, y: 600, size: 12, font });
  doc.getForm().createTextField('ssn').addToPage(p, { x: 300, y: 597, width: 60, height: 16 }); // typed into below, under the mark
  doc.setTitle('Merger plan'); doc.setAuthor('Jane Insider'); doc.setSubject('Deal'); doc.setKeywords(['acme']);
  return Buffer.from(await doc.save());
}

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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = await makePdf();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const key = async (k) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(k); };
  const objs = () => ev('return tab.objects.map((o) => ({ ...o }));');
  const toClient = (i, x, y) => ev('const c = v.pageToClient(tab, arg[0], arg[1], arg[2]); return [c.clientX, c.clientY];', [i, x, y]);
  const drag = async (a, b) => {
    await page.mouse.move(...a);
    await page.mouse.down();
    await page.mouse.move(b[0], b[1], { steps: 5 });
    await page.mouse.up();
  };
  const textOf = (bytes) => ev(`
    const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg) }).promise;
    const t = (await (await d.getPage(1)).getTextContent()).items.map((x) => x.str).join(' ');
    await d.loadingTask.destroy(); return t;`, Array.from(bytes));
  const infoOf = (bytes) => ev(`
    const d = await v.pdfjs.getDocument({ data: new Uint8Array(arg) }).promise;
    const m = await d.getMetadata();
    await d.loadingTask.destroy(); return { info: m.info, xmp: !!m.metadata };`, Array.from(bytes));
  const tabBytes = async () => Uint8Array.from(await ev('return Array.from(tab.bytes);'));
  const marks = async () => (await objs()).filter((o) => o.type === 'redactMark').length;
  const settle = () => page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.pdfDoc && !t.loading; }, null, { timeout: 10_000 }).then(frames);

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'secret.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 1 && a.viewer.getOverlaySvg(t, 0); }, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');
  await frames();
  const orig = await textOf(await tabBytes());
  check(orig.includes('CONFIDENTIAL') && orig.includes('Public line'), `fixture text: ${orig}`);

  step = 'worker full save';
  // pdfium.redact must save in full: an incremental save keeps the original bytes (and the word) as a prefix.
  const direct = Uint8Array.from(await ev(`const { pdfium } = await import('/renderer/pdfium/client.js');
    const id = await pdfium.open(new Uint8Array(arg));
    try { return Array.from(await pdfium.redact(id, [{ pageIndex: 0, rects: [[196, 596, 292, 614]] }], { fill: [0, 0, 0] })); } finally { await pdfium.close(id); }`, Array.from(pdf)));
  check(Buffer.compare(Buffer.from(direct.subarray(0, pdf.length)), pdf) !== 0, 'pdfium.redact appended to the original bytes (incremental save)');
  check(!(await decodedStrings(direct)).includes('CONFIDENTIAL'), 'the redacted word is still in the pdfium.redact output (decoded search)');

  step = 'mark';
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.forms?.byName?.has('ssn'); }, null, { timeout: 10_000 });
  await ev("tab.forms.values.ssn = 'SSN-778899'; tab.forms.dirty = true;"); // a typed, unsaved value
  await key('x');
  // "CONFIDENTIAL" sits at visible x 200..~285, baseline y 192; the field at 300..360 x 179..195.
  await drag(await toClient(0, 196, 176), await toClient(0, 365, 197));
  check(await marks() === 1, 'the Redact tool did not draw a mark');

  step = 'apply';
  await page.click('.options-bar .rd-apply');
  await page.waitForSelector('.dialog');
  const dlg = await page.textContent('.dialog');
  check(/1 mark on 1 page/.test(dlg), `dialog count: ${dlg}`);
  check(/permanently removes the marked content/.test(dlg) && !/Signatures in this document/.test(dlg), `dialog warnings: ${dlg}`);
  await page.check('.dialog .rd-meta');
  await page.click('.dialog button[data-value="ok"]');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId); return t?.bytesUndo?.length === 1; }, null, { timeout: 15_000 });
  await settle();
  let t = await textOf(await tabBytes());
  check(!t.includes('CONFIDENTIAL'), `the redacted word is still in the text: ${t}`);
  check(t.includes('Public line') && t.includes('Closing remark'), `neighbours lost: ${t}`);
  check(await marks() === 0, 'redactMark objects left after apply');
  check(await ev('return tab.dirty;'), 'apply did not mark the tab dirty');
  await page.screenshot({ path: join(OUT, 'redact-applied.png') });

  step = 'undo';
  await ev('await app.pageTools.undo(tab);');
  await settle();
  t = await textOf(await tabBytes());
  check(t.includes('CONFIDENTIAL'), `undo did not bring the word back: ${t}`);
  check(await marks() === 1, 'undo did not bring the mark back');

  step = 'redo';
  await ev('await app.pageTools.redo(tab);');
  await settle();
  t = await textOf(await tabBytes());
  check(!t.includes('CONFIDENTIAL') && t.includes('Public line'), `redo text: ${t}`);
  check(await marks() === 0, 'redo did not remove the mark again');

  step = 'save';
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  const saved = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  t = await textOf(saved);
  check(!t.includes('CONFIDENTIAL') && t.includes('Closing remark'), `saved text: ${t}`);
  const meta = await infoOf(saved);
  check(!meta.info.Title && !meta.info.Author && !meta.info.Subject && !meta.info.Keywords && !meta.xmp, `metadata not cleared: ${JSON.stringify(meta)}`);
  const dec = await decodedStrings(saved);
  check(dec.includes('Public line') && !dec.includes('Jane Insider'), 'the author is still in the saved bytes (decoded search)');
  check(!dec.includes('SSN-778899'), 'the typed field value under the mark is in the saved file');
  check(!(await PDFDocument.load(saved)).getForm().getFields().length, 'the field under the mark is still in the saved form');
  check(Buffer.compare(Buffer.from(saved.subarray(0, pdf.length)), pdf) !== 0, 'the save appended to the original bytes');
  check(await ev('return !tab.bytesUndo?.length && !tab.bytesRedo?.length && !tab.requiresFullSave && tab.forms?.values?.ssn === undefined;'), 'undo history, flag or typed value survived the save');
  check(!(await ev('return await app.pageTools.undo(tab);')), 'Undo after Save ran');
  t = await textOf(await tabBytes());
  check(!t.includes('CONFIDENTIAL'), `Undo after Save brought the word back: ${t}`);

  step = 'reopen';
  await ev('await app.openBytes({ name: "reopened.pdf", bytes: new Uint8Array(arg) });', Array.from(saved));
  await page.waitForFunction(() => { const a = window.ashStudio, x = a.state.tabs.find((y) => y.id === a.state.activeId); return x?.name === 'reopened.pdf' && x.numPages === 1; }, null, { timeout: 10_000 });
  t = await textOf(await tabBytes());
  check(!t.includes('CONFIDENTIAL') && t.includes('Public line'), `reopened text: ${t}`);
  check(await marks() === 0, 'reopened tab has redaction marks');

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('REDACT OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
