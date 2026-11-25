import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, objectAt, pageList, refusal, sameContent, summary, MOST_OF_PAGE, TEXT_UNRELIABLE } from '../renderer/ui/wm-pick-lib.js';

const SIZE = { width: 600, height: 800 }; // 2%: 12 pt across, 16 pt up
const text = (id, bbox, t = 'SAMPLE', fontSize = 60) => ({ id, type: 'text', text: t, fontSize, bbox, quad: null });
const img = (id, bbox, hash = 'ab', pixels = [40, 20]) => ({ id, type: 'image', pixels, hash, bbox, quad: null });
const page = (pageIndex, objects) => ({ pageIndex, ...SIZE, objects });
// A path from page-space corner points (closed subpath), with its bounds.
const path = (id, pts, style = {}) => {
  const xs = pts.filter((_, k) => k % 2 === 0), ys = pts.filter((_, k) => k % 2 === 1);
  return { id, type: 'path', segments: pts.length / 2, kinds: 'm' + 'l'.repeat(pts.length / 2 - 2) + 'L', points: pts,
    stroke: [255, 0, 0, 255], fill: [0, 0, 0, 255], lineWidth: 2, drawMode: [0, 1], bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], quad: null, ...style };
};
const rect = (id, l, b, r, t, style) => path(id, [l, b, r, b, r, t, l, t], style);

test('text: same text and size within 1%, bounds within min(2%, 6 pt)', () => {
  const pick = text(0, [100, 300, 400, 500]);
  const r = findMatches([pick], [
    page(0, [pick]),
    page(1, [text(3, [105, 305, 405, 505], 'SAMPLE', 60.5)]),   // within both tolerances
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

test('path: a stamp frame does not match a title-block cell with the same segment count but other geometry', () => {
  const frame = rect(0, 400, 100, 550, 160);
  // The cell has the same bounds and segment kinds, but its corners are elsewhere: a skewed box.
  const cell = path(7, [400, 100, 550, 100, 520, 160, 430, 160]);
  cell.bbox = [400, 100, 550, 160];
  assert.equal(cell.segments, frame.segments);
  assert.ok(!sameContent(frame, cell));
  assert.deepEqual(findMatches([frame], [page(1, [cell])]).pages, [], 'the cell is kept');
  assert.deepEqual(findMatches([frame], [page(1, [cell, rect(8, 401, 100, 551, 160)])]).pages, [{ pageIndex: 1, ids: [8] }], 'the frame itself matches');
});

test('path: stroke and fill colours, draw mode and line width must match too', () => {
  const frame = rect(0, 400, 100, 550, 160);
  assert.ok(sameContent(frame, rect(1, 410, 100, 560, 160)), 'same shape elsewhere: same content');
  assert.ok(!sameContent(frame, rect(1, 400, 100, 550, 160, { stroke: [0, 0, 0, 255] })));
  assert.ok(!sameContent(frame, rect(1, 400, 100, 550, 160, { fill: [255, 255, 255, 255] })));
  assert.ok(!sameContent(frame, rect(1, 400, 100, 550, 160, { drawMode: [1, 1] })));
  assert.ok(!sameContent(frame, rect(1, 400, 100, 550, 160, { lineWidth: 2.5 })));
  assert.ok(!sameContent(frame, rect(1, 400, 100, 550, 160, { kinds: 'mlll' })), 'other segment kinds');
  assert.ok(sameContent({ ...frame, points: undefined, geomHash: 'h1' }, { ...frame, points: undefined, geomHash: 'h1' }), 'long paths: by geometry hash');
  assert.ok(!sameContent({ ...frame, points: undefined, geomHash: 'h1' }, { ...frame, points: undefined, geomHash: 'h2' }));
});

test('text with no Unicode mapping never matches, and cannot be picked', () => {
  for (const t of ['', ' ', '\ufffd\ufffd']) {
    const a = text(0, [100, 300, 400, 500], t);
    assert.ok(!sameContent(a, text(1, [100, 300, 400, 500], t)), JSON.stringify(t));
    assert.deepEqual(findMatches([a], [page(0, [a]), page(1, [text(1, [100, 300, 400, 500], t)])]).pages, []);
    assert.equal(refusal(a, SIZE), TEXT_UNRELIABLE);
  }
  assert.equal(refusal(text(0, [100, 300, 400, 500]), SIZE), null);
});

test('bounds: at most 6 pt per edge on a large sheet, and the same size within 1%', () => {
  const A1 = { width: 1684, height: 2384 }; // 2% would be 34 pt across, 48 pt up
  const pick = rect(0, 400, 100, 550, 160);
  const on = (o) => findMatches([pick], [{ pageIndex: 1, ...A1, objects: [o] }]).pages.length === 1;
  assert.ok(on(rect(1, 405.5, 105.5, 555.5, 165.5)), '5.5 pt off: match');
  assert.ok(!on(rect(1, 407, 100, 557, 160)), '7 pt across: no match');
  assert.ok(!on(rect(1, 400, 107, 550, 167)), '7 pt up: no match');
  const big = text(0, [100, 300, 400, 500]);
  assert.ok(!findMatches([big], [page(1, [text(1, [100, 300, 404, 500])])]).pages.length, 'width 1.3% larger: no match');
  assert.ok(findMatches([big], [page(1, [text(1, [100, 300, 402, 500])])]).pages.length, 'width 0.7% larger: match');
});

test('a form covering most of the page cannot be picked', () => {
  const form = (bbox) => ({ id: 0, type: 'form', hash: 'f', bbox, quad: null });
  assert.equal(refusal(form([0, 0, 600, 800]), SIZE), MOST_OF_PAGE);
  assert.equal(refusal(form([0, 0, 600, 420]), SIZE), MOST_OF_PAGE, 'just over half');
  assert.equal(refusal(form([100, 300, 400, 500]), SIZE), null);
  assert.equal(refusal(rect(0, 0, 0, 600, 800), SIZE), null, 'only forms are refused');
});

test('pageList: ranges of 1-based pages', () => {
  assert.equal(pageList([0, 1, 2, 4, 7]), 'Pages 1–3, 5, 8');
  assert.equal(pageList([1]), 'Page 2');
  assert.equal(pageList([3, 0, 1]), 'Pages 1–2, 4');
  assert.equal(pageList([0, 2, 4, 6], 2), 'Pages 1, 3, …');
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
  const { PDFDocument, StandardFonts, degrees, rgb } = await import('pdf-lib');
  const { pageObjects, removeObjects } = await import('../renderer/pdfium/wmpick.js');
  const m = await init({ wasmBinary: readFileSync(createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm')) });
  m.PDFiumExt_Init();
  const d = await PDFDocument.create(), font = await d.embedFont(StandardFonts.Helvetica);
  for (const k of [0, 1]) {
    const p = d.addPage([612, 792]);
    p.drawText(`Body ${k}`, { x: 50, y: 700, size: 12, font });
    p.drawText('SAMPLE', { x: 150, y: 250, size: 60, font, rotate: degrees(45) });
    p.drawRectangle({ x: 400, y: 100, width: 150, height: 60, borderWidth: 2, borderColor: rgb(1, 0, 0) });
  }
  const bytes = await d.save(), ptr = m.pdfium.wasmExports.malloc(bytes.length);
  m.pdfium.HEAPU8.set(bytes, ptr);
  const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, '');
  try {
    const pages = [0, 1].map((i) => ({ pageIndex: i, ...pageObjects(m, doc, i) }));
    const wm = pages[0].objects.find((o) => o.text === 'SAMPLE');
    assert.ok(wm && wm.type === 'text' && wm.fontSize > 0 && wm.quad.length === 8, JSON.stringify(pages[0].objects));
    const frame = pages[0].objects.find((o) => o.type === 'path');
    assert.equal(frame.points.length, 2 * frame.segments, JSON.stringify(frame));
    assert.deepEqual([Math.min(...frame.points.filter((_, k) => k % 2 === 0)), Math.max(...frame.points.filter((_, k) => k % 2 === 1))].map(Math.round), [400, 160], 'points in page space');
    assert.equal(frame.stroke.join(), '255,0,0,255');
    assert.ok(frame.lineWidth === 2 && frame.kinds.length === frame.segments && frame.drawMode.length === 2, JSON.stringify(frame));
    const r = findMatches([wm, frame], pages);
    assert.equal(r.pages.length, 2);
    assert.equal(r.objects, 4);
    assert.equal(removeObjects(m, doc, r.pages), 4);
    assert.deepEqual([0, 1].map((i) => pageObjects(m, doc, i).objects.map((o) => o.text)), [['Body 0'], ['Body 1']]);
  } finally { m.FPDF_CloseDocument(doc); m.pdfium.wasmExports.free(ptr); }
});
