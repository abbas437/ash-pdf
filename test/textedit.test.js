import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { init } from '@embedpdf/pdfium';
import { textLines, editLine, FONT_FILES, substituteFont } from '../renderer/pdfium/textedit.js';
import { pdfjsDoc } from './helpers.js';

const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'));
let mPromise;
const pdfium = () => (mPromise ??= init({ wasmBinary: wasm }).then((m) => { m.PDFiumExt_Init(); return m; }));
const loadFont = async (file) => new Uint8Array(readFileSync(require.resolve(FONT_FILES[file])));

/** Page 612x792: line A Helvetica 14 at (50,700); line B in a SUBSET-embedded Carlito 16 at (50,640);
 *  line C three Helvetica 12 words drawn separately at y=580; line D Times 12 "Unchanged footer" at (300,100). */
async function fixture() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica), times = await doc.embedFont(StandardFonts.TimesRoman);
  const carlito = await doc.embedFont(readFileSync(require.resolve(FONT_FILES['Carlito-Regular.ttf'])), { subset: true });
  const p = doc.addPage([612, 792]);
  p.drawText('Invoice number 4711 is overdue', { x: 50, y: 700, size: 14, font: helv, color: rgb(0, 0, 0.6) });
  p.drawText('Total 1234', { x: 50, y: 640, size: 16, font: carlito });
  let x = 50;
  for (const w of ['Alpha', 'Beta', 'Gamma']) { p.drawText(w, { x, y: 580, size: 12, font: helv }); x += helv.widthOfTextAtSize(w + ' ', 12); }
  p.drawText('Unchanged footer', { x: 300, y: 100, size: 12, font: times });
  return doc.save();
}

async function withDoc(bytes, fn) {
  const m = await pdfium();
  const ptr = m.pdfium.wasmExports.malloc(bytes.length);
  m.pdfium.HEAPU8.set(bytes, ptr);
  const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, '');
  assert.ok(doc, 'pdfium opens the fixture');
  try {
    const r = await fn(m, doc);
    const w = m.PDFiumExt_OpenFileWriter();
    assert.ok(m.FPDF_SaveAsCopy(doc, w, 0));
    const size = m.PDFiumExt_GetFileWriterSize(w), p = m.pdfium.wasmExports.malloc(size);
    m.PDFiumExt_GetFileWriterData(w, p, size);
    const out = m.pdfium.HEAPU8.slice(p, p + size);
    m.pdfium.wasmExports.free(p); m.PDFiumExt_CloseFileWriter(w);
    return { r, out };
  } finally { m.FPDF_CloseDocument(doc); m.pdfium.wasmExports.free(ptr); }
}
/** pdf.js text items of page 1: [{ str, x, y }] (empty items dropped). */
async function items(bytes) {
  const doc = await pdfjsDoc(bytes);
  const tc = await (await doc.getPage(1)).getTextContent();
  await doc.close();
  return tc.items.filter((it) => it.str.trim()).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
}
const lineAt = (its, y) => its.filter((it) => Math.abs(it.y - y) < 1).map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
const lines = async (bytes) => (await withDoc(bytes, (m, doc) => textLines(m, doc, 0))).r;

test('textLines groups text objects into visual lines with bbox, size, font and colour', async () => {
  const ls = await lines(await fixture());
  assert.deepEqual(ls.map((l) => l.text), ['Invoice number 4711 is overdue', 'Total 1234', 'Alpha Beta Gamma', 'Unchanged footer']);
  const [a, b, c] = ls;
  assert.equal(a.font, 'Helvetica');
  assert.equal(Math.round(a.size), 14);
  assert.ok(Math.abs(a.bbox[0] - 50) < 1.5 && a.bbox[1] < 700 && a.bbox[1] > 695 && a.bbox[3] > 708 && a.bbox[3] < 716, `bbox ${a.bbox}`);
  assert.ok(Math.abs(a.bbox[2] - a.bbox[0] - 200) < 20, `width ${a.bbox[2] - a.bbox[0]}`);
  assert.deepEqual(a.color.slice(0, 3), [0, 0, 153]);
  assert.equal(a.embedded, false);
  assert.ok(b.embedded && /Carlito/.test(b.font), `font ${b.font}`); // pdf-lib names subsets PostScriptName-NNNN, without the ABCDEF+ tag
  assert.equal(c.objects.length, 3, 'three objects, one line');
  assert.ok(ls.every((l) => l.editable && /^[0-9a-f]{8}$/.test(l.id)));
  assert.equal(new Set(ls.map((l) => l.id)).size, 4);
  assert.deepEqual((await lines(await fixture())).map((l) => l.id), ls.map((l) => l.id), 'ids are stable for the same page state');
});

test('editLine replaces a Helvetica line in place; other lines are unchanged', async () => {
  const src = await fixture();
  const before = await items(src), ls = await lines(src);
  const { r, out } = await withDoc(src, (m, doc) => editLine(m, doc, 0, ls[0].id, 'Invoice number 4712 is paid', { loadFont }));
  assert.equal(r.ok, true);
  assert.equal(r.substituted, null);
  assert.ok(r.widthAfter < r.widthBefore, `${r.widthBefore} -> ${r.widthAfter}`);
  const after = await items(out);
  assert.equal(lineAt(after, 700), 'Invoice number 4712 is paid');
  assert.ok(!after.some((it) => /4711|overdue/.test(it.str)));
  assert.ok(after.some((it) => it.str.startsWith('Invoice') && Math.abs(it.x - 50) < 0.5 && Math.abs(it.y - 700) < 0.5), 'same origin');
  for (const y of [640, 580, 100]) assert.equal(lineAt(after, y), lineAt(before, y), `line at y=${y}`);
  for (const it of before.filter((t) => t.y < 690)) assert.ok(after.some((t) => t.str === it.str && Math.abs(t.x - it.x) < 0.5 && Math.abs(t.y - it.y) < 0.5), `kept ${it.str}`);
  const ls2 = await lines(out);
  assert.equal(ls2[0].text, 'Invoice number 4712 is paid');
  assert.deepEqual(ls2[0].color.slice(0, 3), [0, 0, 153], 'colour kept');
});

test('editLine on a subset-embedded font substitutes a full font when glyphs are missing (no U+0000)', async () => {
  const src = await fixture();
  const line = (await lines(src))[1];
  const { r, out } = await withDoc(src, (m, doc) => editLine(m, doc, 0, line.id, 'Zebra 9876', { loadFont }));
  assert.equal(r.ok, true);
  assert.equal(r.substituted, 'Carlito-Regular.ttf');
  const after = await items(out);
  assert.ok(!after.some((it) => it.str.includes('\u0000')), `U+0000 in ${JSON.stringify(after.map((t) => t.str))}`);
  assert.equal(lineAt(after, 640), 'Zebra 9876');
  assert.ok(after.some((it) => it.str.startsWith('Zebra') && Math.abs(it.x - 50) < 0.5), 'same origin');
  assert.equal(lineAt(after, 700), 'Invoice number 4711 is overdue');
  const ls2 = await lines(out);
  assert.equal(ls2.filter((l) => /Zebra/.test(l.text)).length, 1);
  assert.equal(Math.round(ls2[1].size), 16);
});

test('editLine on a line split over three objects leaves exactly one object for it', async () => {
  const src = await fixture();
  const line = (await lines(src))[2];
  const { r, out } = await withDoc(src, (m, doc) => editLine(m, doc, 0, line.id, 'Delta Epsilon', { loadFont }));
  assert.equal(r.ok, true);
  const ls2 = await lines(out);
  const edited = ls2.find((l) => l.text === 'Delta Epsilon');
  assert.ok(edited, JSON.stringify(ls2.map((l) => l.text)));
  assert.equal(edited.objects.length, 1);
  assert.equal(ls2.length, 4);
  assert.equal(lineAt(await items(out), 580), 'Delta Epsilon');
});

test('editLine refuses an unknown (stale) line id; substituteFont maps family and style', async () => {
  const { r } = await withDoc(await fixture(), (m, doc) => editLine(m, doc, 0, 'deadbeef', 'x', { loadFont }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no line deadbeef/);
  assert.equal(substituteFont('ABCDEF+Calibri-BoldItalic'), 'Carlito-BoldItalic.ttf');
  assert.equal(substituteFont('Cambria'), 'Caladea-Regular.ttf');
  assert.equal(substituteFont('Times-Bold'), 'Tinos-Bold.ttf');
  assert.equal(substituteFont('Courier-Oblique'), 'Cousine-Italic.ttf');
  assert.equal(substituteFont('Helvetica'), 'Arimo-Regular.ttf');
  assert.equal(substituteFont('WeirdFont'), 'Arimo-Regular.ttf');
  for (const f of Object.values(FONT_FILES)) assert.ok(readFileSync(require.resolve(f)).length > 50000, f);
});

test('lines inside a Form XObject are reported (page-space bbox) but refused for editing', async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const inner = await PDFDocument.create();
  inner.addPage([300, 100]).drawText('Inside a form', { x: 10, y: 20, size: 12, font: await inner.embedFont(StandardFonts.Helvetica) });
  const [form] = await doc.embedPdf(await inner.save());
  const p = doc.addPage([612, 792]);
  p.drawPage(form, { x: 100, y: 400 });
  p.drawText('Top level', { x: 50, y: 700, size: 12, font: helv });
  const src = await doc.save();
  const ls = await lines(src);
  const f = ls.find((l) => l.text === 'Inside a form');
  assert.ok(f, JSON.stringify(ls.map((l) => l.text)));
  assert.equal(f.editable, false);
  assert.match(f.reason, /Form XObject/);
  assert.ok(Math.abs(f.bbox[0] - 110) < 1.5 && f.bbox[1] > 415 && f.bbox[1] < 420, `bbox ${f.bbox}`);
  assert.ok(Array.isArray(f.objects[0]) && f.objects[0].length === 2);
  const { r } = await withDoc(src, (m, d) => editLine(m, d, 0, f.id, 'x', { loadFont }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /Form XObject/);
});
