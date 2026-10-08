import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { init } from '@embedpdf/pdfium';
import { pageImages, transformImage, deleteImage, replaceImage, boxMatrix } from '../renderer/pdfium/imgedit.js';
import { makeImage, renderPage, isColor, near } from './helpers.js';

const wasm = readFileSync(createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm'));
let mPromise;
const pdfium = () => (mPromise ??= init({ wasmBinary: wasm }).then((m) => { m.PDFiumExt_Init(); return m; }));

/** 612x792: red JPEG at 100..180 x 100..140, blue PNG at 300..380 x 100..140. */
async function fixture() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, 792]);
  p.drawImage(await doc.embedJpg(makeImage('jpeg', 40, 20, '#ff0000')), { x: 100, y: 100, width: 80, height: 40 });
  p.drawImage(await doc.embedPng(makeImage('png', 40, 20, '#0000ff')), { x: 300, y: 100, width: 80, height: 40 });
  return doc.save();
}
/** Open bytes, run fn(m, doc), full save. Returns { out, result }. */
async function withDoc(bytes, fn) {
  const m = await pdfium();
  const ptr = m.pdfium.wasmExports.malloc(bytes.length);
  m.pdfium.HEAPU8.set(bytes, ptr);
  const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, '');
  assert.ok(doc, 'pdfium opens the fixture');
  try {
    const result = fn(m, doc);
    const w = m.PDFiumExt_OpenFileWriter();
    assert.ok(m.FPDF_SaveAsCopy(doc, w, 0));
    const size = m.PDFiumExt_GetFileWriterSize(w), p = m.pdfium.wasmExports.malloc(size);
    m.PDFiumExt_GetFileWriterData(w, p, size);
    const out = m.pdfium.HEAPU8.slice(p, p + size);
    m.pdfium.wasmExports.free(p); m.PDFiumExt_CloseFileWriter(w);
    return { out, result };
  } finally { m.FPDF_CloseDocument(doc); m.pdfium.wasmExports.free(ptr); }
}
const list = async (bytes) => (await withDoc(bytes, (m, doc) => pageImages(m, doc, 0))).result;
const nearBox = (got, want, msg) => want.forEach((v, i) => near(got[i], v, 0.5, `${msg} [${i}]`));
const vis = (x, y) => [x, 792 - y]; // PDF -> rendered pixel (unrotated 612x792 page)

test('pageImages lists the JPEG and the PNG with their bboxes, pixel sizes and filters', async () => {
  const imgs = await list(await fixture());
  assert.equal(imgs.length, 2);
  const [jpg, png] = imgs;
  nearBox(jpg.bbox, [100, 100, 180, 140], 'jpeg bbox');
  nearBox(png.bbox, [300, 100, 380, 140], 'png bbox');
  assert.deepEqual([jpg.width, jpg.height, jpg.filter, jpg.inForm], [40, 20, 'DCTDecode', false]);
  assert.deepEqual([png.width, png.height, png.filter], [40, 20, 'FlateDecode']);
  assert.match(jpg.id, /^\d+$/);
});

test('transformImage moves and scales: the colour is at the new centre and white at the old', async () => {
  const src = await fixture();
  const [jpg] = await list(src);
  const to = [400, 500, 520, 560];
  const { out } = await withDoc(src, (m, doc) => transformImage(m, doc, 0, jpg.id, boxMatrix(jpg.matrix, jpg.bbox, to)));
  nearBox((await list(out))[0].bbox, to, 'new bbox');
  const r = await renderPage(out);
  assert.ok(isColor(r.sample(...vis(460, 530)), [255, 0, 0]), `red at the new centre: ${r.sample(...vis(460, 530))}`);
  assert.ok(isColor(r.sample(...vis(140, 120)), [255, 255, 255]), `white at the old centre: ${r.sample(...vis(140, 120))}`);
  assert.ok(isColor(r.sample(...vis(340, 120)), [0, 0, 255]), 'the other image stays');
});

test('deleteImage removes the image', async () => {
  const src = await fixture();
  const [, png] = await list(src);
  const { out } = await withDoc(src, (m, doc) => deleteImage(m, doc, 0, png.id));
  const left = await list(out);
  assert.equal(left.length, 1);
  assert.equal(left[0].filter, 'DCTDecode');
  const r = await renderPage(out);
  assert.ok(isColor(r.sample(...vis(340, 120)), [255, 255, 255]), 'white where the PNG was');
});

test('replaceImage with a JPEG keeps /DCTDecode and fits the new pixels inside the old box (aspect kept)', async () => {
  const src = await fixture();
  const [jpg] = await list(src);
  const green = makeImage('jpeg', 30, 30, '#00ff00');
  const { out } = await withDoc(src, (m, doc) => replaceImage(m, doc, 0, jpg.id, { bytes: green, kind: 'jpeg' }));
  const [now] = await list(out);
  assert.deepEqual([now.width, now.height, now.filter], [30, 30, 'DCTDecode']);
  nearBox(now.bbox, [120, 100, 160, 140], 'square image centred in the 80x40 box');
  const doc = await PDFDocument.load(out);
  const streams = [...doc.context.enumerateIndirectObjects()].map(([, o]) => o)
    .filter((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image' && o.dict.get(PDFName.of('Width'))?.toString() === '30');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].dict.get(PDFName.of('Filter')).toString(), '/DCTDecode');
  const r = await renderPage(out);
  assert.ok(isColor(r.sample(...vis(140, 120)), [0, 255, 0]), `new pixels: ${r.sample(...vis(140, 120))}`);
  assert.ok(isColor(r.sample(...vis(105, 120)), [255, 255, 255]), 'outside the fitted box is white');
});

test('replaceImage with a PNG works; a non-image kind is refused', async () => {
  const src = await fixture();
  const [, png] = await list(src);
  const { out } = await withDoc(src, (m, doc) => replaceImage(m, doc, 0, png.id, { bytes: makeImage('png', 40, 20, '#ffff00'), kind: 'png' }));
  assert.ok(isColor((await renderPage(out)).sample(...vis(340, 120)), [255, 255, 0]));
  await assert.rejects(withDoc(src, (m, doc) => replaceImage(m, doc, 0, png.id, { bytes: new Uint8Array(4), kind: 'gif' })), /PNG and JPEG/);
});

test('an image inside a Form XObject is listed with its page bbox; editing it is refused with a clear error', async () => {
  const inner = await PDFDocument.create();
  inner.addPage([612, 792]).drawImage(await inner.embedPng(makeImage('png', 80, 40, '#0000ff')), { x: 300, y: 480, width: 160, height: 80 });
  const outer = await PDFDocument.create();
  const emb = await outer.embedPage((await PDFDocument.load(await inner.save())).getPage(0));
  outer.addPage([612, 792]).drawPage(emb, { x: 50, y: 20, xScale: 0.5, yScale: 0.5 });
  const src = await outer.save();
  const [img] = await list(src);
  assert.ok(img?.inForm, 'listed as inside a form');
  assert.match(img.id, /^\d+\/\d+$/);
  nearBox(img.bbox, [200, 260, 280, 300], 'form image bbox in page space');
  await assert.rejects(withDoc(src, (m, doc) => transformImage(m, doc, 0, img.id, img.matrix)), /inside a form XObject/);
  await assert.rejects(withDoc(src, (m, doc) => deleteImage(m, doc, 0, img.id)), /inside a form XObject/);
});

// UI geometry (renderer/ui/imgedit-lib.js): a drag in page space becomes the right PDF move on rotated pages.
import { pdfToPage, pageToPdf, pdfBoxToPage, pageBoxToPdf, dragBox } from '../renderer/ui/imgedit-lib.js';
import { pdfToVisible, pageGeometry } from '../src/core/internal.js';

test('imgedit-lib maps page space to PDF like the core geometry on every /Rotate; a 100 pt drag right moves the image correctly', async () => {
  for (const rotate of [0, 90, 180, 270]) {
    const doc = await PDFDocument.create();
    const p = doc.addPage([612, 792]);
    p.setRotation({ type: 'degrees', angle: rotate });
    const g = { view: [0, 0, 612, 792], rotate };
    const geo = pageGeometry(p);
    for (const [X, Y] of [[100, 120], [500, 700]]) {
      const v = pdfToVisible(geo, X, Y);
      assert.deepEqual(pdfToPage(g, X, Y), [v.x, v.y], `pdfToPage at /Rotate ${rotate}`);
      assert.deepEqual(pageToPdf(g, v.x, v.y), [X, Y], `pageToPdf at /Rotate ${rotate}`);
    }
    const box = [100, 100, 180, 140];
    const moved = pageBoxToPdf(g, dragBox(pdfBoxToPage(g, box), 'move', 100, 0));
    // Visible "right" is PDF +x at 0, +y at 90, -x at 180, -y at 270.
    const want = { 0: [200, 100, 280, 140], 90: [100, 200, 180, 240], 180: [0, 100, 80, 140], 270: [100, 0, 180, 40] }[rotate];
    assert.deepEqual(moved, want, `move at /Rotate ${rotate}`);
  }
});

test('dragBox scales from a handle; Shift keeps the aspect on corners', () => {
  const b = { x: 10, y: 10, w: 80, h: 40 };
  assert.deepEqual(dragBox(b, 'se', 20, 5), { x: 10, y: 10, w: 100, h: 45 });
  assert.deepEqual(dragBox(b, 'se', 20, 5, true), { x: 10, y: 10, w: 100, h: 50 });
  assert.deepEqual(dragBox(b, 'nw', -40, 0, true), { x: -30, y: -10, w: 120, h: 60 });
  assert.deepEqual(dragBox(b, 'w', 100, 0), { x: 88, y: 10, w: 2, h: 40 });
});
