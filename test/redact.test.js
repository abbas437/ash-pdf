import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { init } from '@embedpdf/pdfium';
import { redactDocument } from '../renderer/pdfium/redact.js';
import { writeAnnotations, readAnnotations } from '../src/core/index.js';
import { makeImage, pdfjsDoc, renderPage } from './helpers.js';

const wasm = readFileSync(createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm'));
let mPromise;
const pdfium = () => (mPromise ??= init({ wasmBinary: wasm }).then((m) => { m.PDFiumExt_Init(); return m; }));

/** Page 612x792: "Public line" (50,600), "SECRET 99-1234" (200,600), a line at (50,700), blue RGB image 300..460 x 480..560,
 *  a green rectangle path 260..290 x 500..530 (inside the redaction area), a long red bar 100..500 x 440..450 (crossing it),
 *  a rect annotation inside the redaction area. */
async function fixture() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const png = await doc.embedPng(makeImage('png', 80, 40, '#0000ff'));
  const p = doc.addPage([612, 792]);
  p.drawText('Invoice number 4711 is overdue', { x: 50, y: 700, size: 14, font: helv });
  p.drawText('Public line', { x: 50, y: 600, size: 12, font: helv });
  p.drawText('SECRET 99-1234', { x: 200, y: 600, size: 12, font: helv });
  p.drawImage(png, { x: 300, y: 480, width: 160, height: 80 });
  p.drawRectangle({ x: 260, y: 500, width: 30, height: 30, color: rgb(0, 0.8, 0) });
  p.drawRectangle({ x: 100, y: 440, width: 400, height: 10, color: rgb(1, 0, 0) });
  // Overlay coordinates are top-left based (y down): PDF y 520..540 -> 252..272.
  return writeAnnotations(await doc.save(), { add: [{ id: 'a1', type: 'rect', page: 0, x: 320, y: 252, w: 30, h: 20, stroke: '#ff0000', strokeWidth: 1 }] });
}

async function redact(bytes, areas, opts) {
  const m = await pdfium();
  const ptr = m.pdfium.wasmExports.malloc(bytes.length);
  m.pdfium.HEAPU8.set(bytes, ptr);
  const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, '');
  assert.ok(doc, 'pdfium opens the fixture');
  try {
    const stats = redactDocument(m, doc, areas, opts);
    const w = m.PDFiumExt_OpenFileWriter();
    assert.ok(m.FPDF_SaveAsCopy(doc, w, 0));
    const size = m.PDFiumExt_GetFileWriterSize(w), p = m.pdfium.wasmExports.malloc(size);
    m.PDFiumExt_GetFileWriterData(w, p, size);
    const out = m.pdfium.HEAPU8.slice(p, p + size);
    m.pdfium.wasmExports.free(p); m.PDFiumExt_CloseFileWriter(w);
    return { out, stats };
  } finally { m.FPDF_CloseDocument(doc); m.pdfium.wasmExports.free(ptr); }
}
async function text(bytes) {
  const doc = await pdfjsDoc(bytes);
  const tc = await (await doc.getPage(1)).getTextContent();
  await doc.close();
  return tc.items.map((it) => it.str).join(' ');
}

test('redactDocument removes text chars, image pixels and annotations under the rect; keeps the rest', async () => {
  const src = await fixture();
  assert.match(await text(src), /SECRET 99-1234/);
  assert.equal((await readAnnotations(src)).objects.length, 1);
  // Over "99-1234" (starts ~x=252) and the left half of the image (300..460).
  const { out, stats } = await redact(src, [{ pageIndex: 0, rects: [[250, 430, 380, 615]] }], { fill: [0, 0, 0] });
  const t = await text(out);
  assert.ok(!t.includes('99-1234') && !t.includes('99-'), `redacted text still extractable: ${t}`);
  assert.ok(t.includes('SECRET'), `chars of the same object outside the rect are kept: ${t}`);
  assert.ok(t.includes('Public line') && t.includes('Invoice number 4711'), `other lines kept: ${t}`);
  assert.ok(!Buffer.from(out).toString('latin1').includes('99-1234'), 'raw bytes have no "99-1234"');
  assert.equal(stats.images.blacked + stats.images.removed, 1, `image handled: ${JSON.stringify(stats)}`);
  assert.equal(stats.annots, 1);
  assert.equal((await readAnnotations(out)).objects.length, 0, 'annotation inside the rect is gone');
  const { sample: px } = await renderPage(out, 0);
  const under = px(340, 792 - 520), outside = px(430, 792 - 520), box = px(260, 792 - 605);
  assert.ok(under[0] < 40 && under[1] < 40 && under[2] < 40, `image pixels under the rect are black: ${under}`);
  assert.ok(outside[2] > 200 && outside[0] < 60, `image pixels outside the rect stay blue: ${outside}`);
  assert.ok(box[0] < 40 && box[1] < 40 && box[2] < 40, `black box drawn: ${box}`);
  const bar = px(450, 792 - 445);
  assert.ok(bar[0] > 200 && bar[1] < 60, `path crossing the rect is kept: ${bar}`);
});

test('redactDocument with fill null draws no box; an image fully inside is removed', async () => {
  const src = await fixture();
  const { out, stats } = await redact(src, [{ pageIndex: 0, rects: [[290, 470, 470, 570]] }], { fill: null });
  assert.equal(stats.images.removed, 1);
  const { sample: px } = await renderPage(out, 0);
  const p = px(380, 792 - 500), path = px(275, 792 - 515);
  assert.ok(p[0] > 240 && p[1] > 240 && p[2] > 240, `area is white (image gone, no box): ${p}`);
  assert.ok(path[1] > 150, `green path outside this rect is kept: ${path}`);
  assert.match(await text(out), /SECRET 99-1234/);
});

test('redactDocument removes a vector path fully inside the rect, keeps one crossing it', async () => {
  const { out } = await redact(await fixture(), [{ pageIndex: 0, rects: [[250, 435, 295, 535]] }], { fill: null });
  const { sample: px } = await renderPage(out, 0);
  const inside = px(275, 792 - 515), bar = px(450, 792 - 445);
  assert.ok(inside[0] > 240 && inside[1] > 240 && inside[2] > 240, `green path inside the rect is gone: ${inside}`);
  assert.ok(bar[0] > 200 && bar[1] < 60, `red bar crossing the rect is kept: ${bar}`);
});
