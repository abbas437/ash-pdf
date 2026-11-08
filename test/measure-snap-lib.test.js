import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapPointsFromOps, nearestSnap } from '../renderer/ui/measure-snap-lib.js';

const OPS = { save: 10, restore: 11, transform: 12, stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28, constructPath: 91, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75 };
const list = (ops) => ({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1]) });
const path = (paint, data) => [OPS.constructPath, [paint, [data], null]];
const sorted = (pts) => [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

test('a simple stroked line gives both ends', () => {
  const pts = snapPointsFromOps(list([path(OPS.stroke, [0, 10, 20, 1, 110, 70])]), OPS);
  assert.deepEqual(pts, [[10, 20], [110, 70]]);
});

test('a polyline shares its joints once', () => {
  const pts = snapPointsFromOps(list([path(OPS.stroke, [0, 0, 0, 1, 10, 0, 1, 10, 10])]), OPS);
  assert.deepEqual(pts, [[0, 0], [10, 0], [10, 10]]);
});

test('a rotated CTM from transform maps points to page space', () => {
  const pts = snapPointsFromOps(list([
    [OPS.transform, [0, 1, -1, 0, 100, 0]], // 90 degrees: (x, y) -> (100 - y, x)
    path(OPS.stroke, [0, 10, 0, 1, 20, 0]),
  ]), OPS);
  assert.deepEqual(sorted(pts), [[100, 10], [100, 20]]);
});

test('a form XObject matrix applies until its end; restore undoes save + transform', () => {
  const pts = snapPointsFromOps(list([
    [OPS.save], [OPS.transform, [1, 0, 0, 1, 50, 0]], [OPS.restore],
    [OPS.paintFormXObjectBegin, [[2, 0, 0, 2, 10, 10]]],
    path(OPS.stroke, [0, 1, 1, 1, 2, 1]),
    [OPS.paintFormXObjectEnd],
    path(OPS.stroke, [0, 1, 1, 1, 2, 1]),
  ]), OPS);
  assert.deepEqual(pts, [[12, 12], [14, 12], [1, 1], [2, 1]]);
});

test('curve ends are skipped unless a straight segment ends there', () => {
  const curveOnly = snapPointsFromOps(list([path(OPS.stroke, [0, 0, 0, 2, 5, 5, 8, 8, 10, 0])]), OPS);
  assert.deepEqual(curveOnly, []);
  const quad = snapPointsFromOps(list([path(OPS.stroke, [0, 0, 0, 3, 5, 5, 10, 0])]), OPS);
  assert.deepEqual(quad, []);
  const mixed = snapPointsFromOps(list([path(OPS.stroke, [0, 0, 0, 2, 5, 5, 8, 8, 10, 0, 1, 10, 20])]), OPS);
  assert.deepEqual(mixed, [[10, 0], [10, 20]]);
});

test('closePath adds the segment back to the subpath start', () => {
  const pts = snapPointsFromOps(list([path(OPS.closeStroke, [0, 0, 0, 1, 10, 0, 1, 10, 10, 4])]), OPS);
  assert.deepEqual(sorted(pts), [[0, 0], [10, 0], [10, 10]]);
});

test('max stops the collection', () => {
  const data = [0, 0, 0];
  for (let i = 1; i <= 20; i++) data.push(1, i, 0);
  const pts = snapPointsFromOps(list([path(OPS.stroke, data)]), OPS, { max: 5 });
  assert.equal(pts.length, 5);
});

test('points are de-duplicated to 0.01 pt', () => {
  const pts = snapPointsFromOps(list([
    path(OPS.stroke, [0, 1, 1, 1, 5, 5]),
    path(OPS.stroke, [0, 1.001, 0.999, 1, 5.004, 5]),
    path(OPS.stroke, [0, 1.02, 1, 1, 5, 5]),
  ]), OPS);
  assert.deepEqual(pts, [[1, 1], [5, 5], [1.02, 1]]);
});

test('fill-only and clip paths are ignored; fillStroke counts', () => {
  const data = [0, 0, 0, 1, 10, 0, 1, 10, 10, 4];
  assert.deepEqual(snapPointsFromOps(list([path(OPS.fill, data), path(OPS.endPath, data)]), OPS), []);
  assert.equal(snapPointsFromOps(list([path(OPS.fillStroke, data)]), OPS).length, 3);
});

test('nearestSnap: closest within tol, edge inclusive, else null', () => {
  const pts = [[0, 0], [10, 0], [12, 0]];
  assert.deepEqual(nearestSnap(pts, 11.5, 0, 2), [12, 0]);
  assert.deepEqual(nearestSnap(pts, 3, 4, 5), [0, 0]); // exactly on the tolerance
  assert.equal(nearestSnap(pts, 3, 4, 4.99), null);
  assert.equal(nearestSnap([], 0, 0, 5), null);
});
