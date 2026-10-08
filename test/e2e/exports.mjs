#!/usr/bin/env node
// End-to-end test of File > Export to Excel and File > Export to image (one page via saveFile, several via a folder) (renderer/ui/exports.js) in
// Chromium via playwright-core (run `node scripts/vendor.js` first). A generated 3x4 table PDF is exported
// to .xlsx through the menu and dialog; the download is unzipped and its sheet XML must hold the table with
// numbers stored as numbers. A page with a paragraph, a JPEG, a small table and a PNG with transparency exported
// to .xlsx must hold both images in xl/media, anchored in xl/drawings/drawing1.xml below the paragraph / above the
// table and below the table, with the cells unchanged; with "Include images" off, no xl/media. Page 1 exported as PNG at 150 dpi must be 1275 x 1650 px (Letter), and as JPEG
// a JPEG. Prints "EXPORTS OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const TABLE = [['Item', 'Qty', 'Price', 'Total'], ['Net amount', '2', '1,234.50', '2,469'], ['Pump', '10', '0.75', '7.5']];

const REPORT_PARA = 'The table below gives the comment count by discipline and review code for the documents reviewed this period.';
const REPORT_LABEL = ['G-01 / G-02', 'Status and maturity: content is concept-level and several sections are still placeholders.'];
const REPORT_HEAD = ['Discipline', 'Code B', 'Code C', 'Code D', 'Total', 'Major', 'Docs reviewed', 'Docs coded C/D'];
const REPORT_ROWS = [['Civil', 5, 12, 2, 19, 7, 6, 3], ['Electrical', 6, 27, 1, 34, 28, 4, 4], ['Mechanical', 9, 14, 0, 23, 11, 8, 2], ['Total', 124, 183, 26, 333, 209, 88, 71]];
const REPORT_NOTE = 'Note: Code C/D counts include documents resubmitted under Rev.01 and Rev.02 in this review cycle.';

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  TABLE.forEach((row, i) => row.forEach((c, j) => page.drawText(c, { x: 72 + j * 110, y: 700 - i * 22, size: 11, font })));
  doc.addPage([612, 792]).drawText('Second page', { x: 72, y: 700, size: 11, font });
  // Page 3: a report page - paragraph lines, a label + sentence row, a ruled 8-column table, a note.
  const rp = doc.addPage([612, 792]);
  const text = (s, x, y) => rp.drawText(s, { x, y, size: 9, font });
  text(REPORT_PARA, 60, 740);
  text(REPORT_LABEL[0], 60, 726);
  text(REPORT_LABEL[1], 140, 726);
  const xs = [60, 170, 225, 280, 335, 390, 445, 510, 580]; // column edges
  const body = [REPORT_HEAD, ...REPORT_ROWS];
  body.forEach((row, i) => row.forEach((c, j) => {
    const s = String(c), y = 690 - i * 16;
    text(s, typeof c === 'number' ? xs[j + 1] - 5 - font.widthOfTextAtSize(s, 9) : xs[j] + 4, y);
  }));
  const top = 702, bottom = 702 - body.length * 16;
  for (const x of xs) rp.drawLine({ start: { x, y: top }, end: { x, y: bottom }, thickness: 0.5 });
  for (let i = 0; i <= body.length; i++) rp.drawLine({ start: { x: xs[0], y: top - i * 16 }, end: { x: xs.at(-1), y: top - i * 16 }, thickness: 0.5 });
  text(REPORT_NOTE, 60, bottom - 18);
  return Buffer.from(await doc.save());
}

// One page: a paragraph line, a 120 x 80 JPEG, a 3x2 table, a 64 x 64 PNG with transparency (in that order, top down).
const IMG_PARA = 'Pump station photo and the duty schedule for the reviewed equipment items.';
const IMG_TABLE = [['Tag', 'Duty'], ['P-101', '45'], ['P-102', '30']];
async function makeImagePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(IMG_PARA, { x: 72, y: 740, size: 11, font });
  const jc = createCanvas(120, 80), jx = jc.getContext('2d');
  jx.fillStyle = '#3a7bd5'; jx.fillRect(0, 0, 120, 80); jx.fillStyle = '#f0c040'; jx.fillRect(20, 20, 60, 30);
  const jpg = await doc.embedJpg(jc.toBuffer('image/jpeg'));
  page.drawImage(jpg, { x: 72, y: 600, width: 120, height: 80 });
  IMG_TABLE.forEach((row, i) => row.forEach((c, j) => page.drawText(c, { x: 72 + j * 120, y: 560 - i * 20, size: 11, font })));
  const pc = createCanvas(64, 64), px = pc.getContext('2d');
  px.fillStyle = 'rgba(200, 30, 30, 0.6)'; px.beginPath(); px.arc(32, 32, 28, 0, Math.PI * 2); px.fill();
  const png = await doc.embedPng(pc.toBuffer('image/png'));
  page.drawImage(png, { x: 300, y: 400, width: 64, height: 64 });
  return Buffer.from(await doc.save());
}

// Minimal unzip: central directory -> {name: Buffer}.
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out[name] = method === 8 ? inflateRawSync(data) : data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
// Sheet XML -> rows of values (shared strings / inline strings resolved, numbers as numbers).
function readSheet(xml, shared) {
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(([, row]) => [...row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attrs, inner = '']) => {
    const t = /\bt="(\w+)"/.exec(attrs)?.[1];
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    if (t === 's') return shared[Number(v)];
    if (t === 'inlineStr') return unesc(/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '');
    if (t === 'str') return unesc(v ?? '');
    return v === undefined ? null : Number(v);
  }));
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const problems = [];
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  step = 'open';
  await page.evaluate((b) => window.ashStudio.openBytes({ name: 'table.pdf', bytes: new Uint8Array(b) }), [...await makePdf()]);
  await page.waitForFunction(() => document.querySelector('.page[data-page-index="0"] .textLayer span'));
  const menu = async (id) => {
    await page.locator('.menu-btn', { hasText: 'File' }).click();
    await page.locator(`.menu-item[data-id="${id}"]`).click();
  };
  const download = async (fn) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), fn()]);
    return { name: dl.suggestedFilename(), bytes: await readFile(await dl.path()) };
  };

  step = 'Excel: dialog note, invalid range rejected';
  await menu('export-xlsx');
  const dlg = page.locator('.xp-xlsx-dialog');
  check(/Works best for table-like pages/.test(await dlg.textContent()), 'dialog note missing');
  await page.fill('#xp-xlsx-pages', '9');
  await dlg.locator('button[data-value="export"]').click();
  await page.waitForFunction(() => /Pages:/.test(document.querySelector('.xp-xlsx-dialog .vx-error')?.textContent), null, { timeout: 5000 })
    .catch(() => { throw new Error('invalid range not reported'); });

  step = 'Excel: export pages 1-2';
  await page.fill('#xp-xlsx-pages', '1-2');
  const xlsx = await download(() => dlg.locator('button[data-value="export"]').click());
  check(xlsx.name === 'table.xlsx', `xlsx name ${xlsx.name}`);
  const files = unzip(xlsx.bytes);
  const wb = files['xl/workbook.xml']?.toString() ?? '';
  const names = [...wb.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  check(JSON.stringify(names) === '["Page 1","Page 2"]', `sheet names ${JSON.stringify(names)}`);
  const sst = files['xl/sharedStrings.xml']?.toString() ?? '';
  const shared = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) => [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
  const sheetFile = Object.keys(files).find((f) => /^xl\/worksheets\/sheet1\.xml$/.test(f));
  const rows = readSheet(files[sheetFile].toString(), shared);
  const want = [['Item', 'Qty', 'Price', 'Total'], ['Net amount', 2, 1234.5, 2469], ['Pump', 10, 0.75, 7.5]];
  check(JSON.stringify(rows) === JSON.stringify(want), `sheet 1 rows ${JSON.stringify(rows)}`);

  step = 'Excel: export the report page (paragraphs + ruled table)';
  await menu('export-xlsx');
  await page.fill('#xp-xlsx-pages', '3');
  const rep = await download(() => page.locator('.xp-xlsx-dialog button[data-value="export"]').click());
  const rfiles = unzip(rep.bytes);
  const rshared = [...(rfiles['xl/sharedStrings.xml']?.toString() ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) => [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
  const rrows = readSheet(rfiles['xl/worksheets/sheet1.xml'].toString(), rshared);
  const has = (want) => rrows.some((r) => JSON.stringify(r) === JSON.stringify(want));
  for (const want of [REPORT_HEAD, ...REPORT_ROWS]) check(has(want), `report row ${JSON.stringify(want)} missing from ${JSON.stringify(rrows)}`);
  check(rrows.some((r) => r[0] === REPORT_PARA) && rrows.some((r) => r[0] === REPORT_NOTE), `report prose rows ${JSON.stringify(rrows)}`);

  step = 'image: page 1, PNG, 150 dpi';
  await menu('export-image');
  await page.fill('#xp-img-page', '1');
  await page.selectOption('#xp-img-dpi', '150');
  const png = await download(() => page.locator('.xp-img-dialog button[data-value="export"]').click());
  check(png.name === 'table-page-1.png', `png name ${png.name}`);
  check(png.bytes.subarray(1, 4).toString() === 'PNG', 'not a PNG');
  const [w, hgt] = [png.bytes.readUInt32BE(16), png.bytes.readUInt32BE(20)];
  check(w === 1275 && hgt === 1650, `PNG size ${w}x${hgt}, expected 1275x1650`);

  step = 'image: page 2, JPEG, 72 dpi';
  await menu('export-image');
  await page.fill('#xp-img-page', '2');
  await page.selectOption('#xp-img-format', 'jpeg');
  await page.selectOption('#xp-img-dpi', '72');
  await page.fill('#xp-img-quality', '80');
  const jpg = await download(() => page.locator('.xp-img-dialog button[data-value="export"]').click());
  check(jpg.name === 'table-page-2.jpg' && jpg.bytes[0] === 0xff && jpg.bytes[1] === 0xd8, `jpeg ${jpg.name}`);

  step = 'image: pages 1-3, PNG, 72 dpi -> one file per page through imageExportBegin/Write/End';
  const pageCount = await page.evaluate(() => window.ashStudio.state.tabs.find((t) => t.id === window.ashStudio.state.activeId).numPages);
  check(pageCount === 3, `fixture has ${pageCount} pages`);
  const many = [];
  const onDl = (dl) => many.push(dl);
  page.on('download', onDl);
  await menu('export-image');
  await page.fill('#xp-img-page', '1-3');
  await page.selectOption('#xp-img-format', 'png');
  await page.selectOption('#xp-img-dpi', '72');
  await page.locator('.xp-img-dialog button[data-value="export"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Exported 3 images/.test(t.textContent)), null, { timeout: 15000 })
    .catch(() => { throw new Error('no "Exported 3 images" toast'); });
  page.off('download', onDl);
  const imgs = await Promise.all(many.map(async (dl) => ({ name: dl.suggestedFilename(), bytes: await readFile(await dl.path()) })));
  check(JSON.stringify(imgs.map((f) => f.name).sort()) === '["table-p1.png","table-p2.png","table-p3.png"]', `files ${imgs.map((f) => f.name)}`);
  for (const f of imgs) {
    check(f.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${f.name} not a PNG`);
    check(f.bytes.readUInt32BE(16) === 612 && f.bytes.readUInt32BE(20) === 792, `${f.name} size at 72 dpi`);
  }
  check(await page.locator('.xp-img-progress').count() === 0, 'progress dialog left open');

  step = 'image: shim rejects what main rejects';
  const rejected = await page.evaluate(async () => {
    const out = [];
    const ok = { baseName: 'x', pageCount: 3, pages: [1, 2], format: 'png' };
    for (const r of [{ ...ok, folder: '/tmp' }, { ...ok, pages: Array.from({ length: 2001 }, (_, i) => i + 1), pageCount: 3000 }]) {
      out.push(await window.api.imageExportBegin(r).then(() => 'accepted', (e) => e.message));
    }
    const job = await window.api.imageExportBegin(ok);
    out.push(await window.api.imageExportWrite(job.jobId, 0, [0x89, 0x50]).then(() => 'accepted', (e) => e.message));
    await window.api.imageExportEnd(job.jobId);
    out.push(await window.api.imageExportWrite(job.jobId, 1, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).then(() => 'accepted', (e) => e.message));
    return out;
  });
  check(/exactly the keys/.test(rejected[0]) && /At most 2000/.test(rejected[1]) && /Uint8Array/.test(rejected[2]) && /no such job/.test(rejected[3]),
    `shim rejections ${JSON.stringify(rejected)}`);

  step = 'Excel: images (JPEG + PNG with alpha) placed against the text rows';
  await page.evaluate((b) => window.ashStudio.openBytes({ name: 'photos.pdf', bytes: new Uint8Array(b) }), [...await makeImagePdf()]);
  await page.waitForFunction(() => window.ashStudio.state.tabs.find((t) => t.id === window.ashStudio.state.activeId)?.name === 'photos.pdf');
  const exportPhotos = async (images) => {
    await menu('export-xlsx');
    if (!images) await page.locator('#xp-xlsx-images').uncheck();
    const out = await download(() => page.locator('.xp-xlsx-dialog button[data-value="export"]').click());
    const f = unzip(out.bytes);
    const ss = [...(f['xl/sharedStrings.xml']?.toString() ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) => [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
    return { f, rows: readSheet(f['xl/worksheets/sheet1.xml'].toString(), ss) };
  };
  const withImgs = await exportPhotos(true);
  const media = Object.keys(withImgs.f).filter((n) => n.startsWith('xl/media/')).sort();
  check(media.length === 2, `xl/media holds ${JSON.stringify(media)}, expected 2 images`);
  check(/\.jpe?g$/.test(media[0]) && withImgs.f[media[0]][0] === 0xff && withImgs.f[media[0]][1] === 0xd8, `image 1 not a JPEG: ${media[0]}`);
  check(/\.png$/.test(media[1]) && withImgs.f[media[1]].subarray(1, 4).toString() === 'PNG', `image 2 not a PNG: ${media[1]}`);
  const drawing = withImgs.f['xl/drawings/drawing1.xml']?.toString() ?? '';
  // page width 612 pt -> 8 columns of 64 px: x 72 pt -> 60 px (column A), x 300 pt -> 251 px (column D)
  const anchors = [...drawing.matchAll(/<xdr:from><xdr:col>(\d+)<\/xdr:col>.*?<xdr:row>(\d+)<\/xdr:row>/g)].map((m) => ({ col: Number(m[1]), row: Number(m[2]) }));
  const rowOf = (first) => withImgs.rows.findIndex((r) => r[0] === first);
  const [para, head, last] = [rowOf(IMG_PARA), rowOf('Tag'), rowOf('P-102')];
  check(anchors.length === 2 && para >= 0 && head > para && last > head, `anchors ${JSON.stringify(anchors)} rows ${JSON.stringify(withImgs.rows)}`);
  check(anchors[0].row > para && anchors[0].row <= head, `JPEG anchored at row ${anchors[0].row}, expected between the paragraph (${para}) and the table (${head})`);
  check(anchors[1].row > last, `PNG anchored at row ${anchors[1].row}, expected below the table's last row (${last})`);
  check(anchors[0].col === 0 && anchors[1].col === 3, `anchor columns ${JSON.stringify(anchors)}`);
  const wantRows = [[IMG_PARA], ['Tag', 'Duty'], ['P-101', 45], ['P-102', 30]];
  check(JSON.stringify(withImgs.rows) === JSON.stringify(wantRows), `image page rows ${JSON.stringify(withImgs.rows)}`);

  step = 'Excel: "Include images" off -> no xl/media, same cells';
  const noImgs = await exportPhotos(false);
  check(!Object.keys(noImgs.f).some((n) => n.startsWith('xl/media/') || n.startsWith('xl/drawings/')), `images written with "Include images" off: ${Object.keys(noImgs.f)}`);
  check(JSON.stringify(noImgs.rows) === JSON.stringify(withImgs.rows), `cells differ without images: ${JSON.stringify(noImgs.rows)}`);

  step = 'Word: built-in engine is the default and writes the page text into word/document.xml';
  await menu('export-docx');
  const engine = page.locator('.office-engine-dialog #office-engine');
  check(await engine.inputValue() === 'ash', 'Export to Word engine does not default to the built-in one');
  const docx = await download(() => page.locator('.office-engine-dialog .btn.primary').click());
  check(docx.name === 'photos.docx', `docx name ${docx.name}`);
  const docParts = unzip(docx.bytes);
  const docXml = docParts['word/document.xml']?.toString() ?? '';
  const docText = [...docXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(' ');
  check(docText.includes('P-101') && docText.includes('Tag'), `word/document.xml text ${JSON.stringify(docText.slice(0, 200))}`);

  if (problems.length) throw new Error(problems.join('\n'));
  console.log('EXPORTS OK');
} catch (err) {
  console.error(`FAILED at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
