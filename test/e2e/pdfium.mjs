#!/usr/bin/env node
// End-to-end test of the PDFium edit worker (renderer/pdfium/) in Chromium under the real CSP of
// renderer/index.html: lazy start (no worker/wasm request before first use), then
// ashStudio.pdfium.selfTest() -> page count, text of a known text object, incremental save whose output
// starts with the original bytes; textLines + editLine (a substitute font fetched from the app origin);
// plus error propagation and no CSP violation. Prints "PDFIUM OK".
// Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage();
  const problems = [], requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => window.ashStudio?.pdfium);

  step = 'lazy: nothing loaded before first use';
  await page.waitForTimeout(300);
  const early = requests.filter((u) => /pdfium\/worker\.js|pdfium\.wasm|index\.browser\.js/.test(u));
  check(early.length === 0 && !(await page.evaluate(() => window.ashStudio.pdfium.started)), `loaded before use: ${early.join(', ')}`);

  step = 'selfTest';
  const r = await page.evaluate(() => window.ashStudio.pdfium.selfTest().catch((e) => ({ error: `${e.name}: ${e.message}` })));
  check(!r.error, `selfTest threw: ${r.error}`);
  check(r.pageCount === 2, `pageCount ${r.pageCount}`);
  check(r.text === 'PDFium self-test 4711', `text ${JSON.stringify(r.text)}`);
  const o = r.objects[0];
  check(o.font === 'Helvetica' && Math.round(o.size) === 14 && o.matrix.join() === '1,0,0,1,50,700' && o.bounds.length === 4 && o.bounds[0] > 49, `object ${JSON.stringify(o)}`);
  check(r.originalIsPrefix && r.outLength > r.inLength, `incremental save: prefix=${r.originalIsPrefix} in=${r.inLength} out=${r.outLength}`);

  step = 'textLines + editLine (original text; substitute font fetched from the app origin)';
  const t = await page.evaluate(async () => {
    const p = window.ashStudio.pdfium;
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pg = doc.addPage([612, 792]);
    pg.drawText('Invoice number 4711 is overdue', { x: 50, y: 700, size: 14, font });
    pg.drawText('Footer stays', { x: 50, y: 100, size: 10, font });
    const id = await p.open(await doc.save());
    try {
      const lines = await p.textLines(id, 0);
      const plain = await p.editLine(id, 0, lines[0].id, 'Invoice number 4712 is paid');
      const lines2 = await p.textLines(id, 0);
      // 'Ł' is outside Helvetica's WinAnsi encoding: the engine must load Arimo from renderer/vendor/fonts/edit/.
      const subst = await p.editLine(id, 0, lines2[0].id, 'Łódź 4712');
      const id2 = await p.open(subst.bytes);
      try {
        return { lines: lines.map((l) => l.text), plain: { ...plain, bytes: plain.bytes?.length }, subst: { ...subst, bytes: subst.bytes?.length },
          after: (await p.textLines(id2, 0)).map((l) => l.text) };
      } finally { await p.close(id2); }
    } finally { await p.close(id); }
  }).catch((e) => ({ error: `${e.name}: ${e.message}` }));
  check(!t.error, `textedit threw: ${t.error}`);
  check(t.lines.join('|') === 'Invoice number 4711 is overdue|Footer stays', `lines ${JSON.stringify(t.lines)}`);
  check(t.plain.ok && t.plain.substituted === null && t.plain.bytes > 0, `plain edit ${JSON.stringify(t.plain)}`);
  check(t.subst.ok && t.subst.substituted === 'Arimo-Regular.ttf' && t.subst.bytes > 100000, `substituted edit ${JSON.stringify(t.subst)}`);
  check(t.after.join('|') === 'Łódź 4712|Footer stays', `after ${JSON.stringify(t.after)}`);
  check(requests.some((u) => u.endsWith('/renderer/vendor/fonts/edit/Arimo-Regular.ttf')), 'font not fetched from the app origin');

  step = 'kept page: dropped when its document is edited; survives a font-ineligible probe of another document';
  const k = await page.evaluate(async () => {
    const p = window.ashStudio.pdfium;
    const { PDFDocument, PDFName, rgb } = await import('pdf-lib');
    const pageOf = async (build) => { const doc = await PDFDocument.create(); build(doc, doc.addPage([300, 300])); return new Uint8Array(await doc.save()); };
    const size = { width: 150, height: 150, matrix: [0.5, 0, 0, -0.5, 0, 150] }; // PDF user space -> bitmap pixels, y down (as the viewer builds it)
    const square = await pageOf((doc, pg) => pg.drawRectangle({ x: 50, y: 50, width: 100, height: 100, color: rgb(0.8, 0.2, 0.2) }));
    // Text in a Type0 font that is not embedded (MS-Gothic, UniJIS-UCS2-H): PDFium cannot draw it, so the page is ineligible.
    const gothic = await pageOf((doc, pg) => {
      const ctx = doc.context, descriptor = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'MS-Gothic', Flags: 32, FontBBox: [-200, -300, 1200, 1000], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80 }));
      const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'MS-Gothic', Encoding: 'UniJIS-UCS2-H', DescendantFonts: [ctx.register(ctx.obj({
        Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'MS-Gothic', CIDSystemInfo: { Registry: ctx.obj('(Adobe)'), Ordering: ctx.obj('(Japan1)'), Supplement: 2 }, DW: 1000, FontDescriptor: descriptor }))] }));
      pg.node.setFontDictionary(PDFName.of('F1'), font);
      pg.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('0 0 0 rg BT /F1 28 Tf 50 150 Td <65E5672C8A9E> Tj ET')));
    });
    const kept = async () => (await p.stats()).keptPages;
    const out = { start: await kept() };
    const a = await p.open(square);
    try {
      const first = await p.renderPage(a, 0, size);
      out.rendered = !first.ineligible && first.width === 150;
      out.afterRender = await kept();
      const obj = (await p.pageObjects(a, 0)).objects[0];
      out.hasObject = !!obj;
      await p.removeObjects(a, [{ pageIndex: 0, ids: [obj.id] }]);
      out.afterEdit = await kept();
    } finally { await p.close(a); }
    const a2 = await p.open(square), b = await p.open(gothic);
    try {
      await p.renderPage(a2, 0, size);
      out.beforeProbe = await kept();
      out.probe = await p.renderPage(b, 0, size);
      out.afterProbe = await kept();
      const again = await p.renderPage(a2, 0, size);
      out.again = !again.ineligible && again.width === 150;
    } finally { await p.close(a2); await p.close(b); }
    out.end = await kept();
    return out;
  }).catch((e) => ({ error: `${e.name}: ${e.message}` }));
  check(!k.error, `kept page threw: ${k.error}`);
  check(k.start === 0 && k.rendered && k.afterRender === 1 && k.hasObject, `kept page after render ${JSON.stringify(k)}`);
  check(k.afterEdit === 0, `editing a document must drop its kept page ${JSON.stringify(k)}`);
  check(k.beforeProbe === 1 && k.probe?.ineligible === 'font' && k.afterProbe === 1 && k.again, `an ineligible probe of another document must leave the kept page ${JSON.stringify(k)}`);
  check(k.end === 0, `closing the documents must drop the kept page ${JSON.stringify(k)}`);

  step = 'errors propagate; caller bytes stay usable';
  const e = await page.evaluate(async () => {
    const p = window.ashStudio.pdfium, junk = new Uint8Array([1, 2, 3]);
    const a = await p.open(junk).then(() => 'resolved', (err) => err.message);
    const b = await p.pageCount(9999).then(() => 'resolved', (err) => err.message);
    return { a, b, junkLen: junk.length };
  });
  check(/cannot open document/.test(e.a) && /no open document 9999/.test(e.b) && e.junkLen === 3, `errors ${JSON.stringify(e)}`);

  step = 'no console errors or CSP violations';
  check(!problems.length, problems.join('\n'));
  console.log(`PDFIUM OK (pages=${r.pageCount}, text="${r.text}", incremental ${r.inLength} -> ${r.outLength} bytes; edited line "${t.after[0]}" via ${t.subst.substituted})`);
} catch (err) {
  console.error(`PDFIUM FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
