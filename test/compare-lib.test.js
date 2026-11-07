// Compare revisions: pixel compare of two page bitmaps (renderer/ui/compare-lib.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePages, inkMask, dilate, shiftMask, estimateShift, onlyPage, regionsToPoints, COLORS } from '../renderer/ui/compare-lib.js';

const page = (w, h) => new Uint8ClampedArray(w * h * 4).fill(255);
function rect(img, w, x, y, rw, rh, [r, g, b] = [0, 0, 0]) {
  for (let yy = y; yy < y + rh; yy++) {
    for (let xx = x; xx < x + rw; xx++) {
      const i = (yy * w + xx) * 4;
      img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
    }
  }
  return img;
}
// A "drawing": a frame, a grid of lines and some text-like blocks, offset by (ox, oy).
function drawing(w, h, ox = 0, oy = 0) {
  const img = page(w, h);
  rect(img, w, 40 + ox, 40 + oy, w - 80, 2);
  rect(img, w, 40 + ox, h - 42 + oy, w - 80, 2);
  rect(img, w, 40 + ox, 40 + oy, 2, h - 80);
  rect(img, w, w - 42 + ox, 40 + oy, 2, h - 80);
  for (let k = 1; k < 6; k++) rect(img, w, 60 + ox, 40 + k * 60 + oy, w - 200, 1);
  for (let k = 0; k < 12; k++) rect(img, w, 80 + k * 23 + ox, 330 + (k % 3) * 7 + oy, 9 + (k % 4) * 3, 7);
  return img;
}
const pixel = (img, w, x, y) => [...img.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)];

test('identical pages: no regions, all ink grey, no shift', () => {
  const w = 400, h = 500;
  const a = drawing(w, h);
  const r = comparePages(a, a.slice(), w, h);
  assert.deepEqual(r.regions, []);
  assert.deepEqual(r.shift, { dx: 0, dy: 0 });
  assert.equal(r.stats.added + r.stats.removed, 0);
  assert.ok(r.stats.same > 1000);
  assert.deepEqual(pixel(r.composite, w, 40, 40), COLORS.same);
  assert.deepEqual(pixel(r.composite, w, 200, 250), [255, 255, 255]);
  assert.equal(r.capped, false);
});

test('a line added: one green region where it was drawn', () => {
  const w = 400, h = 500;
  const a = drawing(w, h);
  const b = rect(drawing(w, h), w, 120, 420, 150, 3);
  const r = comparePages(a, b, w, h);
  assert.equal(r.regions.length, 1);
  const [g] = r.regions;
  assert.deepEqual({ x: g.x, y: g.y, w: g.w, h: g.h }, { x: 120, y: 420, w: 150, h: 3 });
  assert.equal(g.added, 450);
  assert.equal(g.removed, 0);
  assert.deepEqual(pixel(r.composite, w, 150, 421), COLORS.added);
  assert.deepEqual(r.stats.added, 450);
});

test('a line removed: one red region', () => {
  const w = 400, h = 500;
  const a = rect(drawing(w, h), w, 300, 100, 3, 120);
  const r = comparePages(a, drawing(w, h), w, h);
  assert.equal(r.regions.length, 1);
  assert.deepEqual({ ...r.regions[0] }, { x: 300, y: 100, w: 3, h: 120, added: 0, removed: 360 });
  assert.deepEqual(pixel(r.composite, w, 301, 150), COLORS.removed);
});

test('content moved by 1 px is within tolerance: no regions', () => {
  const w = 400, h = 500;
  const a = drawing(w, h);
  const b = drawing(w, h);
  rect(a, w, 100, 450, 60, 2);
  rect(b, w, 101, 451, 60, 2); // only this block moved, so global alignment does not absorb it
  const r = comparePages(a, b, w, h);
  assert.deepEqual(r.shift, { dx: 0, dy: 0 });
  assert.deepEqual(r.regions, []);
  // ...and with zero tolerance the same move is a change
  assert.ok(comparePages(a, b, w, h, { tolerancePx: 0 }).regions.length >= 1);
});

test('whole drawing re-plotted with a (12, -7) px shift: shift found, no regions', () => {
  const w = 800, h = 1000;
  const a = drawing(w, h);
  const b = drawing(w, h, 12, -7);
  const r = comparePages(a, b, w, h);
  assert.deepEqual(r.shift, { dx: 12, dy: -7 });
  assert.deepEqual(r.regions, []);
  assert.equal(r.stats.added + r.stats.removed, 0);
});

test('shift plus a real change: the change is still found, in the newer page frame', () => {
  const w = 800, h = 1000;
  const a = drawing(w, h);
  const b = rect(drawing(w, h, -9, 5), w, 500, 700, 80, 4);
  const r = comparePages(a, b, w, h);
  assert.deepEqual(r.shift, { dx: -9, dy: 5 });
  assert.equal(r.regions.length, 1);
  assert.deepEqual({ x: r.regions[0].x, y: r.regions[0].y, w: r.regions[0].w, h: r.regions[0].h }, { x: 500, y: 700, w: 80, h: 4 });
});

test('noise speckles below minArea are dropped; a block above it is kept', () => {
  const w = 400, h = 500;
  const a = drawing(w, h);
  const b = drawing(w, h);
  for (let k = 0; k < 8; k++) rect(b, w, 70 + k * 40, 470, 2, 2); // 4 px each, 40 px apart
  let r = comparePages(a, b, w, h, { minArea: 8 });
  assert.deepEqual(r.regions, []);
  assert.equal(r.stats.added, 32); // still counted, just not reported as regions
  rect(b, w, 300, 20, 4, 4); // 16 px
  r = comparePages(a, b, w, h, { minArea: 8 });
  assert.equal(r.regions.length, 1);
  assert.equal(r.regions[0].added, 16);
});

test('default minArea (4): isolated 1-2 px specks are dropped, a 2 x 2 mark such as a decimal point is kept', () => {
  const w = 400, h = 500;
  const a = drawing(w, h);
  const b = drawing(w, h);
  rect(b, w, 70, 470, 1, 1);
  rect(b, w, 150, 470, 2, 1);
  assert.deepEqual(comparePages(a, b, w, h).regions, []);
  rect(b, w, 300, 470, 2, 2);
  const r = comparePages(a, b, w, h);
  assert.equal(r.regions.length, 1);
  assert.equal(r.regions[0].added, 4);
});

test('nearby changes merge within mergeGap; far ones stay apart', () => {
  const w = 400, h = 500;
  const a = drawing(w, h);
  const b = rect(rect(rect(drawing(w, h), w, 100, 460, 20, 4), w, 130, 460, 20, 4), w, 300, 460, 20, 4);
  const r = comparePages(a, b, w, h, { mergeGap: 16 });
  assert.equal(r.regions.length, 2);
  assert.deepEqual([r.regions[0].x, r.regions[0].w], [100, 50]);
  assert.deepEqual([r.regions[1].x, r.regions[1].w], [300, 20]);
});

test('many scattered changes: capped at maxRegions, every change still inside a box', () => {
  const w = 1200, h = 1200;
  const a = page(w, h);
  const b = page(w, h);
  const dots = [];
  for (let y = 10; y < h - 10; y += 30) for (let x = 10; x < w - 10; x += 30) { rect(b, w, x, y, 3, 3); dots.push([x, y]); }
  assert.ok(dots.length > 500);
  const r = comparePages(a, b, w, h);
  assert.ok(r.regions.length <= 500 && r.regions.length >= 1, `${r.regions.length} regions`);
  assert.equal(r.regions.reduce((s, g) => s + g.added, 0), dots.length * 9);
  for (const [x, y] of dots) assert.ok(r.regions.some((g) => x >= g.x && y >= g.y && x + 3 <= g.x + g.w && y + 3 <= g.y + g.h));
  const one = comparePages(a, b, w, h, { maxRegions: 1, mergeGap: 0 });
  assert.equal(one.regions.length, 1);
  assert.equal(one.regions[0].added, dots.length * 9);
});

test('ink rule: dark pixels and light colours are ink, light greys are not', () => {
  const img = new Uint8ClampedArray([0, 0, 0, 255, 199, 199, 199, 255, 230, 230, 230, 255, 255, 255, 0, 255, 255, 255, 255, 255, 250, 235, 250, 255]);
  assert.deepEqual([...inkMask(img, 6, 1)], [1, 1, 0, 1, 0, 0]);
});

test('dilate / shiftMask', () => {
  const m = new Uint8Array(25); m[12] = 1; // 5 x 5, centre
  assert.deepEqual([...dilate(m, 5, 5, 1)], [0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  assert.equal(dilate(m, 5, 5, 2).reduce((s, v) => s + v, 0), 25);
  const s = shiftMask(m, 5, 5, 2, -1);
  assert.equal(s.indexOf(1), 1 * 5 + 4);
  assert.equal(s.reduce((t, v) => t + v, 0), 1);
  assert.equal(shiftMask(m, 5, 5, 3, 0).reduce((t, v) => t + v, 0), 0);
});

test('estimateShift stays within maxShift', () => {
  const w = 400, h = 500;
  const mA = inkMask(drawing(w, h), w, h), mB = inkMask(drawing(w, h, 30, 0), w, h);
  const near = estimateShift(mA, mB, w, h); // 30 px > 2 % of 400 (8 px): the best overlap inside +-8
  assert.ok(Math.abs(near.dx) <= 8 && Math.abs(near.dy) <= 10, JSON.stringify(near));
  assert.deepEqual(estimateShift(mA, mB, w, h, { maxShift: 0.1 }), { dx: 30, dy: 0 });
});

test('onlyPage tints ink; regionsToPoints scales', () => {
  const w = 10, h = 10;
  const img = rect(page(w, h), w, 2, 2, 3, 3);
  assert.deepEqual(pixel(onlyPage(img, w, h, 'older'), w, 3, 3), COLORS.removed);
  assert.deepEqual(pixel(onlyPage(img, w, h, 'newer'), w, 3, 3), COLORS.added);
  assert.deepEqual(pixel(onlyPage(img, w, h, 'newer'), w, 0, 0), [255, 255, 255]);
  assert.deepEqual(regionsToPoints([{ x: 30, y: 60, w: 3, h: 6, added: 1, removed: 0 }], 3), [{ x: 10, y: 20, w: 1, h: 2, added: 1, removed: 0 }]);
});

test('mismatched sizes are rejected', () => {
  assert.throws(() => comparePages(page(10, 10), page(10, 11), 10, 10), RangeError);
});

// A1 at 150 dpi (3508 x 4967): a line drawing re-plotted with a small shift and a few changes.
test('timing: A1 at 150 dpi compares in well under the budget', () => {
  const w = 3508, h = 4967;
  const make = (ox, oy) => {
    const img = page(w, h);
    for (let y = 100; y < h - 100; y += 37) rect(img, w, 100 + ox, y + oy, w - 300, 1);
    for (let x = 100; x < w - 100; x += 53) rect(img, w, x + ox, 100 + oy, 2, h - 300);
    for (let k = 0; k < 4000; k++) rect(img, w, 150 + ((k * 97) % (w - 400)) + ox, 150 + ((k * 61) % (h - 400)) + oy, 8, 10);
    return img;
  };
  const a = make(0, 0);
  const b = make(14, -9);
  rect(b, w, 1000, 1000, 400, 5);
  rect(b, w, 2500, 3500, 6, 300, [0, 0, 255]);
  const t0 = performance.now();
  const r = comparePages(a, b, w, h);
  const ms = performance.now() - t0;
  console.log(`# A1@150dpi compare: ${ms.toFixed(0)} ms, ${r.regions.length} regions, shift ${r.shift.dx},${r.shift.dy}`);
  assert.deepEqual(r.shift, { dx: 14, dy: -9 });
  assert.ok(r.regions.length >= 2);
  assert.ok(ms < 6000, `${ms} ms`); // loose: the target is ~1.5 s on a dev machine
});

test('worker messages: the request moves both pixel buffers, the reply moves the composite, errors are plain data', async () => {
  const { compareRequest, compareReply, compareErrorReply } = await import('../renderer/ui/compare-lib.js');
  const a = page(4, 3), b = page(4, 3);
  const { msg, transfer } = compareRequest(7, a, b, 4, 3, { align: false });
  assert.deepEqual({ ...msg, a: undefined, b: undefined }, { id: 7, method: 'compare', a: undefined, b: undefined, width: 4, height: 3, opts: { align: false } });
  assert.ok(msg.a === a && msg.b === b);
  assert.deepEqual(transfer, [a.buffer, b.buffer]);
  assert.deepEqual(compareRequest(1, a, a, 4, 3).transfer, [a.buffer], 'one buffer listed once (a duplicate is a DataCloneError)');
  const r = comparePages(a, b, 4, 3);
  const rep = compareReply(7, r);
  assert.equal(rep.msg.result, r);
  assert.deepEqual(rep.transfer, [r.composite.buffer]);
  assert.deepEqual(compareReply(2, true), { msg: { id: 2, result: true }, transfer: [] });
  assert.deepEqual(compareErrorReply(3, new RangeError('bad size')), { msg: { id: 3, error: { name: 'RangeError', message: 'bad size' } }, transfer: [] });
  // structured-clone round trip (what postMessage does) keeps the result
  const back = structuredClone(rep.msg, { transfer: rep.transfer });
  assert.deepEqual(back.result.stats, r.stats);
});
