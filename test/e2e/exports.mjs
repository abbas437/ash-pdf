#!/usr/bin/env node
// End-to-end test of File > Export to Excel and File > Export page as image (renderer/ui/exports.js) in
// Chromium via playwright-core (run `node scripts/vendor.js` first). A generated 3x4 table PDF is exported
// to .xlsx through the menu and dialog; the download is unzipped and its sheet XML must hold the table with
// numbers stored as numbers. Page 1 exported as PNG at 150 dpi must be 1275 x 1650 px (Letter), and as JPEG
// a JPEG. Prints "EXPORTS OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const TABLE = [['Item', 'Qty', 'Price', 'Total'], ['Net amount', '2', '1,234.50', '2,469'], ['Pump', '10', '0.75', '7.5']];

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  TABLE.forEach((row, i) => row.forEach((c, j) => page.drawText(c, { x: 72 + j * 110, y: 700 - i * 22, size: 11, font })));
  doc.addPage([612, 792]).drawText('Second page', { x: 72, y: 700, size: 11, font });
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

  if (problems.length) throw new Error(problems.join('\n'));
  console.log('EXPORTS OK');
} catch (err) {
  console.error(`FAILED at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
