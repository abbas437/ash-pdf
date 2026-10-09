import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import * as ops from '../src/core/pdfOps.js';
import { pdfToVisible } from '../src/core/internal.js';
import { MM, unitFactor, marginsToRect, rectToMargins, clampRect, rectFromPoints, dragRect, pickPages, sizeLabel } from '../renderer/ui/crop-lib.js';

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
