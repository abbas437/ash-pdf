import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurementRows, measurementTotals, measurementsCsv } from '../renderer/ui/measurements-lib.js';
import { scaleFromDrawingScale } from '../src/core/measure.js';

const mm50 = scaleFromDrawingScale(50, 'mm');
const m100 = scaleFromDrawingScale(100, 'm');
const pt = (real, s) => real / s.ratio; // page points for `real` units at scale s
const line = (id, page, y, len, scale, extra = {}) => ({ id, type: 'line', page, x1: 50, y1: y, x2: 50 + pt(len, scale), y2: y, measure: { kind: 'distance', scale }, ...extra });
const rectPts = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const BOM = '﻿';

test('measurementRows: mixed kinds and units, 1-based pages, sorted by page then top-to-bottom', () => {
  const s = m100;
  const objects = [
    line('d2', 1, 300, 5, m100),
    line('d1', 0, 400, 2500, mm50, { note: 'Duct run' }),
    { id: 'a1', type: 'polygon', page: 0, points: rectPts(100, 100, pt(2, s), pt(3, s)), measure: { kind: 'area', scale: s } },
    { id: 'p1', type: 'polyline', page: 1, points: [[10, 50], [10 + pt(4, s), 50], [10 + pt(4, s), 50 + pt(3, s)]], measure: { kind: 'perimeter', scale: s } },
  ];
  const rows = measurementRows(objects);
  assert.deepEqual(rows.map((r) => [r.id, r.page, r.kind, r.unit, r.text, r.scaleLabel, r.label]), [
    ['a1', 1, 'area', 'm²', '6.00 m²', '1:100', ''],
    ['d1', 1, 'distance', 'mm', '2500 mm', '1:50', 'Duct run'],
    ['p1', 2, 'perimeter', 'm', '7.000 m', '1:100', ''],
    ['d2', 2, 'distance', 'm', '5.000 m', '1:100', ''],
  ]);
  assert.ok(Math.abs(rows[0].value - 6) < 1e-9 && Math.abs(rows[1].value - 2500) < 1e-9);
});

test('measurementRows: same top sorts left to right, then document order', () => {
  const a = { ...line('right', 0, 100, 1, m100), x1: 300, x2: 300 + pt(1, m100) };
  const rows = measurementRows([a, line('left', 0, 100, 1, m100), line('left2', 0, 100, 2, m100)]);
  assert.deepEqual(rows.map((r) => r.id), ['left', 'left2', 'right']);
});

test('measurementRows ignores objects without a measure or with another kind', () => {
  const rows = measurementRows([
    { id: 'r', type: 'rect', page: 0, x: 0, y: 0, w: 10, h: 10 },
    { id: 'l', type: 'line', page: 0, x1: 0, y1: 0, x2: 10, y2: 0 },
    { id: 'x', type: 'line', page: 0, x1: 0, y1: 0, x2: 10, y2: 0, measure: { kind: 'angle', scale: m100 } },
    line('d', 0, 0, 1, m100),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['d']);
});

test('measurementTotals: per kind and unit, kinds in order', () => {
  const rows = measurementRows([
    line('a', 0, 10, 5, m100), line('b', 1, 10, 7.5, m100), line('c', 0, 20, 300, mm50),
    { id: 'z', type: 'polygon', page: 0, points: rectPts(0, 0, pt(5, m100), pt(6, m100)), measure: { kind: 'area', scale: m100 } },
    { id: 'p', type: 'polyline', page: 0, points: [[0, 0], [pt(2, m100), 0]], measure: { kind: 'perimeter', scale: m100 } },
  ]);
  const t = measurementTotals(rows);
  assert.deepEqual(t.map((g) => [g.kind, g.unit, g.count, g.text]), [
    ['distance', 'm', 2, '12.500 m'],
    ['distance', 'mm', 1, '300 mm'],
    ['perimeter', 'm', 1, '2.000 m'],
    ['area', 'm²', 1, '30.00 m²'],
  ]);
  assert.ok(Math.abs(t[0].total - 12.5) < 1e-9);
});

test('empty list: no rows, no totals, CSV header only', () => {
  assert.deepEqual(measurementRows([]), []);
  assert.deepEqual(measurementTotals([]), []);
  assert.equal(measurementsCsv([]), `${BOM}Page,Kind,Value,Unit,Scale,Label\r\n`);
});

test('measurementsCsv: full-precision values, quoted labels (commas, quotes, Arabic), BOM and CRLF', () => {
  const rows = measurementRows([
    line('a', 0, 10, 1, m100, { x2: 50 + 100, note: 'Wall, north "A"' }),
    { id: 'z', type: 'polygon', page: 1, points: rectPts(0, 0, pt(2, m100), pt(3, m100)), measure: { kind: 'area', scale: m100 }, note: 'غرفة المضخات' },
  ]);
  const csv = measurementsCsv(rows);
  assert.ok(csv.startsWith(BOM));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.at(-1), '');
  assert.equal(lines[0], 'Page,Kind,Value,Unit,Scale,Label');
  assert.equal(lines[1], `1,Distance,${String(rows[0].value)},m,1:100,"Wall, north ""A"""`);
  assert.ok(String(rows[0].value).length > 8, `full precision: ${rows[0].value}`);
  assert.notEqual(String(rows[0].value), rows[0].text.split(' ')[0]);
  assert.equal(lines[2], `2,Area,${String(rows[1].value)},m²,1:100,غرفة المضخات`);
});
