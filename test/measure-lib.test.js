import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withValue, labelBox, tickSegments, pointInPolygon } from '../renderer/ui/measure-lib.js';
import { objectType, typeLabel } from '../renderer/ui/comments-lib.js';
import { scaleFromDrawingScale } from '../src/core/measure.js';

const s50 = scaleFromDrawingScale(50, 'mm');
const line = (x2) => ({ type: 'line', x1: 0, y1: 0, x2, y2: 0, measure: { kind: 'distance', scale: s50 } });

test('withValue re-computes a line from its end points (1:50 mm: 141.73 pt = 2500 mm)', () => {
  const m = withValue(line((2500 / 50) * (72 / 25.4)));
  assert.equal(m.label, '2500 mm');
  assert.ok(Math.abs(m.value - 2500) < 1e-9);
  assert.equal(m.kind, 'distance');
});

test('withValue: a polygon area and its closed perimeter', () => {
  const side = (1000 / 50) * (72 / 25.4); // 1 m
  const pts = [[0, 0], [side, 0], [side, side], [0, side]];
  assert.equal(withValue({ type: 'polygon', points: pts, measure: { kind: 'area', scale: scaleFromDrawingScale(50, 'm') } }).label, '1.00 m²');
  assert.equal(withValue({ type: 'polygon', points: pts, measure: { kind: 'perimeter', scale: s50 } }).label, '4000 mm');
  assert.equal(withValue({ type: 'polyline', points: pts, measure: { kind: 'perimeter', scale: s50 } }).label, '3000 mm');
});

test('labelBox centres on the midpoint / middle vertex / vertex average; null without a scale', () => {
  const b = labelBox(line(100));
  assert.ok(Math.abs(b.x + b.w / 2 - 50) < 1e-9 && Math.abs(b.y + b.h / 2) < 1e-9);
  assert.ok(b.w > 0 && b.h > 0 && b.text.endsWith(' mm'));
  const p = labelBox({ type: 'polyline', points: [[0, 0], [10, 20], [40, 0]], measure: { kind: 'perimeter', scale: s50 } });
  assert.ok(Math.abs(p.x + p.w / 2 - 10) < 1e-9 && Math.abs(p.y + p.h / 2 - 20) < 1e-9);
  const g = labelBox({ type: 'polygon', points: [[0, 0], [30, 0], [0, 30]], measure: { kind: 'area', scale: s50 } });
  assert.ok(Math.abs(g.x + g.w / 2 - 10) < 1e-9 && Math.abs(g.y + g.h / 2 - 10) < 1e-9);
  assert.equal(labelBox({ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }), null);
});

test('tickSegments: perpendicular at both ends, none for a zero-length line', () => {
  assert.deepEqual(tickSegments({ x1: 0, y1: 0, x2: 10, y2: 0 }, 4), [[0, -2, 0, 2], [10, -2, 10, 2]].map((t) => t.map((v) => v + 0)));
  assert.deepEqual(tickSegments({ x1: 5, y1: 5, x2: 5, y2: 5 }, 4), []);
});

test('pointInPolygon', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon(sq, 5, 5), true);
  assert.equal(pointInPolygon(sq, 15, 5), false);
});

test('comments list: measurements are listed by kind', () => {
  assert.equal(typeLabel(objectType(line(10))), 'Distance');
  assert.equal(typeLabel(objectType({ type: 'polygon', measure: { kind: 'area' } })), 'Area');
  assert.equal(typeLabel(objectType({ type: 'polyline', measure: { kind: 'perimeter' } })), 'Perimeter');
  assert.equal(typeLabel(objectType({ type: 'polygon' })), 'Polygon');
  assert.equal(objectType({ type: 'line' }), 'line');
});
