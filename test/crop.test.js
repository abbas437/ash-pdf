import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import * as ops from '../src/core/pdfOps.js';
import { pdfToVisible } from '../src/core/internal.js';
import { MM, unitFactor, marginsToRect, rectToMargins, clampRect, rectFromPoints, dragRect, pickPages, sizeLabel, cropBoxFor, sizesDiffer, inkBox, inkMargins } from '../renderer/ui/crop-lib.js';

// Page 600 x 800 (MediaBox [0 0 600 800]); the box drawn on the displayed page is 10..110 across
// and 20..220 down. Expected CropBox [x, y, w, h] in user space for each /Rotate.
const VIEW = { xMin: 0, yMin: 0, xMax: 600, yMax: 800 };
const R = { x0: 10, y0: 20, x1: 110, y1: 220 };

test('displayedRectToCropBox: rotation 0 (y flips)', () => {
  assert.deepEqual(ops.displayedRectToCropBox(VIEW, 0, R), [10, 580, 100, 200]);
});
test('displayedRectToCropBox: rotation 90 (displayed x runs up user y, displayed y runs along user x)', () => {
  assert.deepEqual(ops.displayedRectToCropBox(VIEW, 90, R), [20, 10, 200, 100]);
});
test('displayedRectToCropBox: rotation 180', () => {
  assert.deepEqual(ops.displayedRectToCropBox(VIEW, 180, R), [490, 20, 100, 200]);
});
test('displayedRectToCropBox: rotation 270', () => {
  assert.deepEqual(ops.displayedRectToCropBox(VIEW, 270, R), [380, 690, 200, 100]);
});
test('displayedRectToCropBox: offset view (already cropped page)', () => {
  assert.deepEqual(ops.displayedRectToCropBox({ xMin: 50, yMin: 100, xMax: 450, yMax: 700 }, 0, R), [60, 480, 100, 200]);
});

test('displayedRectToCropBox round-trips through pdfToVisible for every rotation', () => {
  for (const rotation of [0, 90, 180, 270]) {
    const [x, y, w, h] = ops.displayedRectToCropBox(VIEW, rotation, R);
    const a = pdfToVisible({ view: VIEW, rotation }, x, y), b = pdfToVisible({ view: VIEW, rotation }, x + w, y + h);
    const got = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    assert.deepEqual(got, R, `rotation ${rotation}`);
  }
});

async function rotatedDoc() {
  const doc = await PDFDocument.create();
  for (const rot of [0, 90, 180, 270]) doc.addPage([600, 800]).setRotation(degrees(rot));
  return doc.save();
}

test('cropPagesToRect: the displayed box becomes the visible page on every rotation', async () => {
  const out = await ops.cropPagesToRect(await rotatedDoc(), [0, 1, 2, 3], R);
  const info = await ops.getInfo(out);
  for (const p of info.pages) assert.deepEqual([p.width, p.height], [100, 200], `rotation ${p.rotation}`);
  assert.deepEqual(info.pages[1].cropBox, [20, 10, 220, 110]);
  assert.deepEqual(info.pages[3].cropBox, [380, 690, 580, 790]);
});

test('cropPagesToRect: same box on smaller pages is clamped; a box off the page is rejected', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([600, 800]); doc.addPage([300, 150]);
  const bytes = await doc.save();
  const out = await ops.cropPagesToRect(bytes, [1], { x0: 100, y0: 50, x1: 500, y1: 700 });
  assert.deepEqual((await ops.getInfo(out)).pages[1].cropBox, [100, 0, 300, 100]);
  await assert.rejects(ops.cropPagesToRect(bytes, [1], { x0: 400, y0: 0, x1: 500, y1: 100 }), RangeError);
});

test('margins <-> rect in points and mm', () => {
  const size = { width: 600, height: 800 };
  const mg = { top: 20, right: 30, bottom: 40, left: 10 };
  const r = marginsToRect(mg, size);
  assert.deepEqual(r, { x0: 10, y0: 20, x1: 570, y1: 760 });
  assert.deepEqual(rectToMargins(r, size), mg);
  assert.equal(unitFactor('mm'), MM);
  assert.equal(unitFactor('pt'), 1);
  const mm10 = 10 * unitFactor('mm');
  const back = rectToMargins(marginsToRect({ top: mm10, right: mm10, bottom: mm10, left: mm10 }, size), size);
  for (const k of ['top', 'right', 'bottom', 'left']) assert.ok(Math.abs(back[k] / MM - 10) < 1e-9);
  assert.equal(sizeLabel({ x0: 0, y0: 0, x1: 72, y1: 36 }, 'pt'), '72.0 × 36.0 pt');
  assert.equal(sizeLabel({ x0: 0, y0: 0, x1: 72, y1: 72 }, 'mm'), '25.4 × 25.4 mm');
});

test('clampRect / rectFromPoints / dragRect keep the box on the page', () => {
  const size = { width: 100, height: 50 };
  assert.deepEqual(clampRect({ x0: -5, y0: 10, x1: 120, y1: 40 }, size), { x0: 0, y0: 10, x1: 100, y1: 40 });
  assert.equal(clampRect({ x0: 100, y0: 0, x1: 120, y1: 40 }, size), null);
  assert.deepEqual(rectFromPoints({ x: 80, y: 60 }, { x: -3, y: 5 }, size), { x0: 0, y0: 5, x1: 80, y1: 50 });
  const r = { x0: 10, y0: 10, x1: 30, y1: 30 };
  assert.deepEqual(dragRect(r, 'se', 5, 100, size), { x0: 10, y0: 10, x1: 35, y1: 50 });
  assert.deepEqual(dragRect(r, 'w', 50, 0, size), { x0: 29, y0: 10, x1: 30, y1: 30 });
  assert.deepEqual(dragRect(r, 'move', 100, -100, size), { x0: 80, y0: 0, x1: 100, y1: 20 });
});

test('pickPages: range "1-3,5", odd, even, current, selected, all', () => {
  const pr = ops.parseRanges;
  assert.deepEqual(pickPages('range', { n: 10, spec: '1-3,5' }, pr), [0, 1, 2, 4]);
  assert.deepEqual(pickPages('range', { n: 10, spec: ' 1-3, 5, 8-10' }, pr), [0, 1, 2, 4, 7, 8, 9]);
  assert.throws(() => pickPages('range', { n: 4, spec: '5' }, pr), RangeError);
  assert.throws(() => pickPages('range', { n: 4, spec: '' }, pr), RangeError);
  assert.deepEqual(pickPages('odd', { n: 6 }, pr), [0, 2, 4]);
  assert.deepEqual(pickPages('even', { n: 6 }, pr), [1, 3, 5]);
  assert.deepEqual(pickPages('even', { n: 1 }, pr), []);
  assert.deepEqual(pickPages('current', { n: 6, current: 3 }, pr), [3]);
  assert.deepEqual(pickPages('selected', { n: 6, selected: [4, 1] }, pr), [1, 4]);
  assert.deepEqual(pickPages('all', { n: 3 }, pr), [0, 1, 2]);
});

// Mixed A3 / A4 pages (portrait, points): typed margins trim each page from its own edges; a drawn
// box keeps its place and is clamped to each page.
const A3 = { width: 841.89, height: 1190.55 }, A4 = { width: 595.28, height: 841.89 };
test('cropBoxFor: typed margins trim each page from its own edges', () => {
  const t = 10 * MM;
  for (const s of [A3, A4]) {
    assert.deepEqual(cropBoxFor(s, { margins: { top: t, right: t, bottom: t, left: t } }), { x0: t, y0: t, x1: s.width - t, y1: s.height - t });
  }
  assert.equal(cropBoxFor(A4, { margins: { left: 300, right: 300 } }), null, 'margins wider than the page');
});
test('cropBoxFor: a drawn box is placed at the same position and clamped to smaller pages', () => {
  const r = { x0: 100, y0: 50, x1: 700, y1: 1000 };
  assert.deepEqual(cropBoxFor(A3, { rect: r }), r);
  assert.deepEqual(cropBoxFor(A4, { rect: r }), { x0: 100, y0: 50, x1: A4.width, y1: A4.height });
  assert.equal(cropBoxFor(A4, { rect: { x0: 600, y0: 0, x1: 700, y1: 100 } }), null);
});
test('sizesDiffer', () => {
  assert.equal(sizesDiffer([A4, { ...A4 }]), false);
  assert.equal(sizesDiffer([A4, A3]), true);
});
test('cropPages on a mixed A3 / A4 document: each page keeps its own trimmed box', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([A3.width, A3.height]); doc.addPage([A4.width, A4.height]);
  const t = 10 * MM;
  const info = await ops.getInfo(await ops.cropPages(await doc.save(), [0, 1], { top: t, right: t, bottom: t, left: t }));
  for (const [k, s] of [[0, A3], [1, A4]]) {
    const [w, hh] = [info.pages[k].width, info.pages[k].height];
    assert.ok(Math.abs(w - (s.width - 2 * t)) < 0.01 && Math.abs(hh - (s.height - 2 * t)) < 0.01, `page ${k + 1}: ${w} x ${hh}`);
  }
});

// ---- Remove white margins
/** White RGBA bitmap w x h with black rectangles [x0, y0, x1, y1) painted in. */
function bitmap(w, h, rects) {
  const d = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.set([0, 0, 0, 255], (y * w + x) * 4);
  return d;
}

test('inkBox: the bounding box of the content', () => {
  assert.deepEqual(inkBox(bitmap(100, 80, [[20, 10, 40, 30], [50, 60, 70, 65]]), 100, 80), { x0: 20, y0: 10, x1: 70, y1: 65 });
  const grey = bitmap(10, 10, []);
  for (const k of [44, 45, 54, 55]) grey.set([250, 250, 200, 255], k * 4); // light but one channel < 245
  assert.deepEqual(inkBox(grey, 10, 10), { x0: 4, y0: 4, x1: 6, y1: 6 });
});

test('inkBox: isolated specks are ignored; a 1 px line is kept', () => {
  const specks = [[2, 2, 3, 3], [97, 5, 98, 6], [3, 77, 4, 78], [96, 76, 97, 77]];
  assert.deepEqual(inkBox(bitmap(100, 80, [[20, 10, 40, 30], ...specks]), 100, 80), { x0: 20, y0: 10, x1: 40, y1: 30 });
  assert.deepEqual(inkBox(bitmap(100, 80, [[10, 40, 90, 41]]), 100, 80), { x0: 10, y0: 40, x1: 90, y1: 41 });
});

test('inkBox / inkMargins: an all-white page gives no crop', () => {
  assert.equal(inkBox(bitmap(50, 50, []), 50, 50), null);
  assert.equal(inkBox(bitmap(50, 50, [[7, 7, 8, 8]]), 50, 50), null); // a lone speck only
  assert.equal(inkMargins(null, 50, 50, { width: 600, height: 800 }), null);
});

test('inkMargins: pixel box to margins in points, padded 2 mm and kept on the page', () => {
  // Rendering at 2 px per point of a 300 x 400 pt page: box 100..300 x 200..600 px = 50..150 x 100..300 pt.
  const pad = 2 * MM;
  const mg = inkMargins({ x0: 100, y0: 200, x1: 300, y1: 600 }, 600, 800, { width: 300, height: 400 });
  for (const [k, v] of Object.entries({ left: 50 - pad, top: 100 - pad, right: 150 - pad, bottom: 100 - pad })) assert.ok(Math.abs(mg[k] - v) < 1e-9, k);
  // Content touching the edges: no negative margins.
  assert.deepEqual(inkMargins({ x0: 0, y0: 1, x1: 600, y1: 800 }, 600, 800, { width: 300, height: 400 }), { top: 0, right: 0, bottom: 0, left: 0 });
});

test('cropPagesEach: each page trimmed by its own margins, on rotated pages too', async () => {
  const out = await ops.cropPagesEach(await rotatedDoc(), [
    { index: 0, margins: { left: 10, top: 20, right: 490, bottom: 580 } },
    { index: 1, margins: { left: 20, top: 10, right: 0, bottom: 0 } },
    { index: 3, margins: { left: 10, top: 20, right: 690, bottom: 380 } },
  ]);
  const info = await ops.getInfo(out);
  assert.deepEqual(info.pages[0].cropBox, [10, 580, 110, 780]);
  assert.deepEqual([info.pages[1].width, info.pages[1].height], [780, 590]);
  assert.deepEqual(info.pages[2].cropBox, [0, 0, 600, 800]);
  assert.deepEqual(info.pages[3].cropBox, [380, 690, 580, 790]); // same displayed box as cropPagesToRect(R)
  await assert.rejects(ops.cropPagesEach(out, [{ index: 2, margins: { left: 300, right: 300 } }]), RangeError);
});
