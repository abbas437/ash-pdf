import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, objectAt, sameContent, summary } from '../renderer/ui/wm-pick-lib.js';

const SIZE = { width: 600, height: 800 }; // 2%: 12 pt across, 16 pt up
const text = (id, bbox, t = 'SAMPLE', fontSize = 60) => ({ id, type: 'text', text: t, fontSize, bbox, quad: null });
const img = (id, bbox, hash = 'ab', pixels = [40, 20]) => ({ id, type: 'image', pixels, hash, bbox, quad: null });
const page = (pageIndex, objects) => ({ pageIndex, ...SIZE, objects });

test('text: same text and size within 1%, bounds within 2%', () => {
  const pick = text(0, [100, 300, 400, 500]);
  const r = findMatches([pick], [
    page(0, [pick]),
    page(1, [text(3, [110, 310, 410, 510], 'SAMPLE', 60.5)]),   // within both tolerances
    page(2, [text(1, [100, 300, 400, 500], 'SAMPLX')]),         // other text
    page(3, [text(1, [100, 300, 400, 500], 'SAMPLE', 62)]),     // size 3% off
  ]);
  assert.deepEqual(r.pages, [{ pageIndex: 0, ids: [0] }, { pageIndex: 1, ids: [3] }]);
  assert.equal(r.objects, 2);
});

test('a near-identical object in a different place does not match', () => {
  const pick = text(0, [100, 300, 400, 500]);
  const r = findMatches([pick], [page(1, [text(0, [113, 300, 413, 500]), text(1, [100, 317, 400, 517])])]);
  assert.deepEqual(r.pages, []);
});

test('images: same pixel size and data hash; only the same type matches', () => {
  const pick = img(2, [0, 0, 80, 40]);
  assert.ok(sameContent(pick, img(5, [0, 0, 80, 40])));
  assert.ok(!sameContent(pick, img(5, [0, 0, 80, 40], 'cd')));
  assert.ok(!sameContent(pick, img(5, [0, 0, 80, 40], 'ab', [41, 20])));
  assert.ok(!sameContent(pick, { ...pick, type: 'path', segments: 4 }));
  const r = findMatches([pick], [page(1, [{ id: 0, type: 'path', segments: 4, bbox: [0, 0, 80, 40] }, img(1, [2, 2, 82, 42])])]);
  assert.deepEqual(r.pages, [{ pageIndex: 1, ids: [1] }]);
});

test('one match per picked object per page, the closest; never one object twice', () => {
  const pick = text(0, [100, 300, 400, 500]);
  const r = findMatches([pick], [page(1, [text(0, [105, 300, 405, 500]), text(1, [101, 300, 401, 500])])]);
  assert.deepEqual(r.pages, [{ pageIndex: 1, ids: [1] }]);
  const two = findMatches([pick, text(9, [100, 300, 400, 500])], [page(1, [text(4, [100, 300, 400, 500])])]);
  assert.deepEqual(two.pages, [{ pageIndex: 1, ids: [4] }], 'two identical picks claim one object once');
});

test('objectAt: topmost, by the rotated quad when there is one', () => {
  const diag = { ...text(0, [0, 0, 100, 100]), quad: [0, 0, 10, -10, 110, 90, 100, 100] }; // thin 45° band
  const under = text(1, [0, 0, 100, 100]);
  assert.equal(objectAt([under, diag], 50, 50).id, 0);
  assert.equal(objectAt([under, diag], 10, 90).id, 1, 'off the band: the object below');
  assert.equal(objectAt([diag], 10, 90), null);
});

test('summary', () => {
  assert.equal(summary({ pages: [{}, {}, {}], objects: 6 }, 3), 'Found on 3 of 3 pages (6 objects)');
  assert.equal(summary({ pages: [{}], objects: 1 }, 3), 'Found only on this page (1 object)');
});

test('engine: lists rotated text objects, matches across pages and removes them (PDFium)', async () => {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const { init } = await import('@embedpdf/pdfium');
  const { PDFDocument, StandardFonts, degrees } = await import('pdf-lib');
  const { pageObjects, removeObjects } = await import('../renderer/pdfium/wmpick.js');
  const m = await init({ wasmBinary: readFileSync(createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm')) });
  m.PDFiumExt_Init();
  const d = await PDFDocument.create(), font = await d.embedFont(StandardFonts.Helvetica);
  for (const k of [0, 1]) {
    const p = d.addPage([612, 792]);
    p.drawText(`Body ${k}`, { x: 50, y: 700, size: 12, font });
    p.drawText('SAMPLE', { x: 150, y: 250, size: 60, font, rotate: degrees(45) });
  }
  const bytes = await d.save(), ptr = m.pdfium.wasmExports.malloc(bytes.length);
  m.pdfium.HEAPU8.set(bytes, ptr);
  const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, '');
  try {
    const pages = [0, 1].map((i) => ({ pageIndex: i, ...pageObjects(m, doc, i) }));
    const wm = pages[0].objects.find((o) => o.text === 'SAMPLE');
    assert.ok(wm && wm.type === 'text' && wm.fontSize > 0 && wm.quad.length === 8, JSON.stringify(pages[0].objects));
    const r = findMatches([wm], pages);
    assert.equal(r.pages.length, 2);
    assert.equal(removeObjects(m, doc, r.pages), 2);
    assert.deepEqual([0, 1].map((i) => pageObjects(m, doc, i).objects.map((o) => o.text)), [['Body 0'], ['Body 1']]);
  } finally { m.FPDF_CloseDocument(doc); m.pdfium.wasmExports.free(ptr); }
});
