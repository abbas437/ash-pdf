import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageCoverage, looksScanned } from '../renderer/ui/scan-lib.js';

const OPS = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintInlineImageXObject: 5, paintImageMaskXObject: 6 };
const view = [0, 0, 600, 800];

test('a full-page image covers the page; a small one does not', () => {
  assert.equal(imageCoverage([OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore], [null, [600, 0, 0, 800, 0, 0], ['i'], null], OPS, view), 1);
  const small = imageCoverage([OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore], [null, [150, 0, 0, 100, 10, 10], ['i'], null], OPS, view);
  assert.ok(Math.abs(small - 15000 / 480000) < 1e-9);
});

test('nested transforms, save/restore and overlapping images (union, not sum)', () => {
  const fn = [OPS.save, OPS.transform, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.paintImageXObject, OPS.restore, OPS.paintImageXObject];
  const args = [null, [600, 0, 0, 800, 0, 0], null, [0.5, 0, 0, 0.5, 0, 0], ['a'], null, ['b'], null, ['c']];
  // a: 300x400 inside b: full page; c after restore uses the identity CTM (1x1 unit square)
  assert.ok(Math.abs(imageCoverage(fn, args, OPS, view) - 1) < 1e-9);
});

test('images are clipped to the page box', () => {
  assert.ok(Math.abs(imageCoverage([OPS.transform, OPS.paintImageXObject], [[600, 0, 0, 800, 300, 0], ["i"]], OPS, view) - 0.5) < 1e-9);
});

test('looksScanned: no text and big images on each of the first 3 pages only', () => {
  const scan = { textItems: 0, coverage: 0.95 };
  assert.equal(looksScanned([scan, scan, scan, { textItems: 40, coverage: 0 }]), true);
  assert.equal(looksScanned([scan, { textItems: 3, coverage: 0.95 }]), false);
  assert.equal(looksScanned([scan, { textItems: 0, coverage: 0.1 }]), false);
  assert.equal(looksScanned([{ textItems: 0, coverage: 0 }]), false);
  assert.equal(looksScanned([]), false);
});
