// Pure helpers of renderer/pdfium/pagerender.js (PDFium draws heavy pages of the main view).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bgraToRgba, concat, displayBase, invert, pdfiumMatrix } from '../renderer/pdfium/pagerender.js';

const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];
const near = (p, q) => assert.ok(Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6, `${p} != ${q}`);
const box = { left: 10.5, top: 852.39, right: 1201.3, bottom: 10.5 }; // non-integer CropBox not at the origin

test('displayBase puts the page box top-left at the origin, y down, for each /Rotate', () => {
  const W = box.right - box.left, H = box.top - box.bottom;
  near(apply(displayBase(box, 0), [box.left, box.top]), [0, 0]);
  near(apply(displayBase(box, 0), [box.right, box.bottom]), [W, H]);
  // 90 clockwise: the unrotated top-left corner goes to the top-right, the box is H wide
  near(apply(displayBase(box, 1), [box.left, box.top]), [H, 0]);
  near(apply(displayBase(box, 1), [box.left, box.bottom]), [0, 0]);
  near(apply(displayBase(box, 2), [box.right, box.bottom]), [0, 0]);
  near(apply(displayBase(box, 3), [box.right, box.top]), [0, 0]);
  near(apply(displayBase(box, 3), [box.left, box.top]), [0, W]);
});

test('displayBase agrees with pdf.js PageViewport at scale 1 (rotation 90)', () => {
  // pdf.js: rotateA=0,B=1,C=1,D=0; e = H/2 - centerY, f = W/2 - centerX
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2, W = box.right - box.left, H = box.top - box.bottom;
  assert.deepEqual(displayBase(box, 1).map((x) => +x.toFixed(9)), [0, 1, 1, 0, +(H / 2 - cy).toFixed(9), +(W / 2 - cx).toFixed(9)]);
});

test('pdfiumMatrix after the display base gives exactly the target mapping', () => {
  const target = [0, 2.5, 2.5, 0, -20, -30]; // some pdf.js transform (rotated, scaled)
  for (const r of [0, 1, 2, 3]) {
    const total = concat(displayBase(box, r), pdfiumMatrix(box, r, target));
    for (const p of [[box.left, box.top], [500, 400], [box.right, box.bottom]]) near(apply(total, p), apply(target, p));
  }
});

test('invert and concat are inverse', () => {
  const m = [1.5, 0.2, -0.3, 2, 7, -9];
  const id = concat(m, invert(m));
  [1, 0, 0, 1, 0, 0].forEach((v, i) => assert.ok(Math.abs(id[i] - v) < 1e-12));
  assert.throws(() => invert([1, 2, 2, 4, 0, 0]), /not invertible/);
});

test('bgraToRgba swaps red and blue, makes pixels opaque and honours the stride', () => {
  // 2x2 BGRx with a 12-byte stride (4 bytes of padding per row)
  const src = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 7, 9, 9, 9, 9, 10, 20, 30, 0, 40, 50, 60, 0, 9, 9, 9, 9]);
  assert.deepEqual([...bgraToRgba(src, 2, 2, 12)], [3, 2, 1, 255, 6, 5, 4, 255, 30, 20, 10, 255, 60, 50, 40, 255]);
  // unaligned source (byte path) gives the same
  const buf = new Uint8Array(src.length + 1); buf.set(src, 1);
  assert.deepEqual([...bgraToRgba(buf.subarray(1), 2, 2, 12)], [3, 2, 1, 255, 6, 5, 4, 255, 30, 20, 10, 255, 60, 50, 40, 255]);
});
