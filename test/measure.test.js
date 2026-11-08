import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scaleFromDrawingScale, scaleFromPaper, scaleFromCalibration, distance, perimeter, area, toReal, measurePoints,
  format, formatScaled, measureDict, scaleFromMeasureDict, viewportAt, viewportDict, viewportFromDict,
} from '../src/core/measure.js';
import { near } from './helpers.js';

describe('scales', () => {
  test('1:50 with the drawing in mm: 1 pt = 25.4/72 x 50 mm', () => {
    const s = scaleFromDrawingScale(50, 'mm');
    near(s.ratio, (25.4 / 72) * 50, 1e-12, 'ratio');
    assert.equal(s.unit, 'mm');
    assert.equal(s.label, '1:50');
    near(toReal(72, s), 1270, 1e-9, '1 in on paper'); // 25.4 mm x 50
  });
  test('1:100 in m', () => {
    const s = scaleFromDrawingScale(100, 'm');
    near(toReal(72 / 25.4 * 10, s), 1, 1e-12, '10 mm on paper = 1 m'); // 10 mm x 100 = 1 m
    near(toReal(1, s, 'area'), s.ratio ** 2, 1e-15, 'area squares the ratio');
  });
  test('1/4" = 1\'-0" (architectural)', () => {
    const s = scaleFromPaper(0.25, 'in', 1, 'ft', { style: 'architectural' });
    near(toReal(18, s), 1, 1e-12, '1/4 in on paper = 1 ft');
    assert.equal(s.label, '0.25 in = 1 ft');
    assert.equal(s.style, 'architectural');
    assert.equal(s.precision, 16);
    near(scaleFromDrawingScale(48, 'ft').ratio, s.ratio, 1e-12, 'same as 1:48 in ft');
  });
  test('calibration: 1500 mm picked as 105.2 pt', () => {
    const s = scaleFromCalibration(105.2, 1500, 'mm');
    near(s.ratio, 1500 / 105.2, 1e-12, 'ratio');
    assert.equal(s.label, 'Calibrated: 1500 mm = 105.2 pt');
    near(toReal(210.4, s), 3000, 1e-9, 'twice the length');
    assert.throws(() => scaleFromCalibration(0, 1, 'mm'), RangeError);
    assert.throws(() => scaleFromDrawingScale(50, 'yd'), TypeError);
  });
});

describe('measuring', () => {
  const sq = [[0, 0], [30, 0], [30, 40], [0, 40]];
  test('distance, perimeter and area in points', () => {
    assert.equal(distance([[0, 0], [3, 4]]), 5);
    assert.equal(distance([[0, 0], [3, 4], [3, 10]]), 11);
    assert.equal(perimeter(sq, false), 100);
    assert.equal(perimeter(sq, true), 140);
    assert.equal(area(sq), 1200);
    assert.equal(area([...sq].reverse()), 1200, 'orientation does not matter');
    assert.equal(area([[0, 0], [4, 0], [0, 3]]), 6);
  });
  test('values with a scale', () => {
    const s = scaleFromDrawingScale(50, 'mm');
    const m = measurePoints('distance', [[0, 0], [72, 0]], s);
    near(m.value, 1270, 1e-9, 'distance');
    assert.equal(m.text, '1270 mm');
    near(measurePoints('perimeter', sq, s).value, 140 * s.ratio, 1e-9, 'perimeter closes');
    const sm = scaleFromDrawingScale(100, 'm');
    const a = measurePoints('area', [[0, 0], [72, 0], [72, 72], [0, 72]], sm);
    near(a.value, 2.54 * 2.54, 1e-12, '1 in square at 1:100 = 2.54 m square');
    assert.equal(a.text, '6.45 m²');
  });
});

describe('format', () => {
  test('decimal places, rounding, locale-independent point', () => {
    assert.equal(format(1234.5678, 'mm', 0), '1235 mm');
    assert.equal(format(1.005, 'm', 3), '1.005 m');
    assert.equal(format(2.5, 'm', 2), '2.50 m');
    assert.equal(format(12.345, 'in'), '12.35 in');
    assert.equal(format(1234567.891, 'm', 1), '1234567.9 m', 'no grouping separators');
  });
  test('areas: mm², m² (2 decimals), ft²', () => {
    assert.equal(format(1500000.4, 'mm', undefined, 'area'), '1500000 mm²');
    assert.equal(format(12.3456, 'm', undefined, 'area'), '12.35 m²');
    assert.equal(format(99.999, 'ft', undefined, 'area'), '100.00 ft²');
  });
  test('architectural feet-inches to 1/16"', () => {
    assert.equal(format(12 + 6.5 / 12, 'ft', 16, 'distance', 'architectural'), '12\'-6 1/2"');
    assert.equal(format(12, 'ft', 16, 'distance', 'architectural'), '12\'-0"');
    assert.equal(format(1 / 12 / 16, 'ft', 16, 'distance', 'architectural'), '0\'-0 1/16"');
    assert.equal(format(3 + 11.99 / 12, 'ft', 16, 'distance', 'architectural'), '4\'-0"', 'rounds up into the next foot');
    assert.equal(format(5 + 3.3 / 12, 'ft', 8, 'distance', 'architectural'), '5\'-3 1/4"', 'to 1/8');
    assert.equal(format(-(2 + 3 / 12), 'ft', 16, 'distance', 'architectural'), '-2\'-3"');
    assert.equal(format(12.5, 'ft', 2), '12.50 ft', 'decimal feet without the style');
    const s = scaleFromPaper(0.25, 'in', 1, 'ft', { style: 'architectural' });
    assert.equal(formatScaled(10.25, s), '10\'-3"');
    assert.equal(formatScaled(10.25, s, 'area'), '10.25 ft²');
  });
});

describe('measure dictionary (§12.9)', () => {
  test('1:50 mm: /X /C = mm per point, /D and /A relative to it', () => {
    const s = scaleFromDrawingScale(50, 'mm');
    const d = measureDict(s);
    assert.equal(d.Type, 'Measure');
    assert.equal(d.Subtype, 'RL');
    assert.equal(d.R, '1:50');
    assert.equal(d.X.length, 1);
    assert.deepEqual({ ...d.X[0], C: undefined }, { Type: 'NumberFormat', U: 'mm', C: undefined, F: 'D', D: 1 });
    near(d.X[0].C, s.ratio, 1e-12, 'X C');
    assert.equal(d.D[0].C, 1);
    assert.deepEqual(d.A[0], { Type: 'NumberFormat', U: 'sq mm', C: 1, F: 'D', D: 1 });
  });
  test('round trip for mm, m and calibrated scales', () => {
    for (const s of [scaleFromDrawingScale(50, 'mm'), scaleFromDrawingScale(100, 'm'), scaleFromCalibration(105.2, 1500, 'mm'), scaleFromDrawingScale(20, 'cm', { precision: 2 })]) {
      const back = scaleFromMeasureDict(measureDict(s));
      near(back.ratio, s.ratio, 1e-12, `${s.label} ratio`);
      assert.deepEqual({ ...back, ratio: 0 }, { ...s, ratio: 0 }, s.label);
    }
  });
  test('architectural feet: a two-entry /X (ft truncated, then in /C 12 in sixteenths)', () => {
    const s = scaleFromPaper(0.25, 'in', 1, 'ft', { style: 'architectural' });
    const d = measureDict(s);
    assert.deepEqual(d.X.map((x) => [x.U, x.F, x.D]), [['ft', 'T', 1], ['in', 'F', 16]]);
    assert.equal(d.X[1].C, 12);
    const back = scaleFromMeasureDict(d);
    near(back.ratio, s.ratio, 1e-12, 'ratio');
    assert.equal(back.style, 'architectural');
    assert.equal(back.precision, 16);
  });
  test('a multi-entry /X from another app, no /D', () => {
    // 1 in = 4 ft: 1 pt = 4/72 ft; then inches in eighths
    const back = scaleFromMeasureDict({ Type: 'Measure', Subtype: 'RL', R: '1 in = 4 ft', X: [{ U: 'ft', C: 4 / 72, F: 'T', D: 1 }, { U: 'in', C: 12, F: 'F', D: 8 }] });
    near(back.ratio, 4 / 72, 1e-12, 'ratio');
    assert.deepEqual([back.unit, back.style, back.precision, back.label], ['ft', 'architectural', 8, '1 in = 4 ft']);
  });
  test('/D in another unit than /X: units per point = X C x D C', () => {
    const back = scaleFromMeasureDict({ Subtype: 'RL', R: '1:100', X: [{ U: 'mm', C: 25.4 / 72 * 100, F: 'D', D: 10 }], D: [{ U: 'm', C: 0.001, F: 'D', D: 100 }] });
    near(back.ratio, 25.4 / 72 * 0.1, 1e-12, 'ratio');
    assert.deepEqual([back.unit, back.precision], ['m', 2]);
  });
  test('unusable dictionaries give null', () => {
    assert.equal(scaleFromMeasureDict(null), null);
    assert.equal(scaleFromMeasureDict({ Subtype: 'GEO', X: [{ U: 'm', C: 1 }] }), null);
    assert.equal(scaleFromMeasureDict({ Subtype: 'RL', X: [] }), null);
    assert.equal(scaleFromMeasureDict({ Subtype: 'RL', X: [{ U: 'furlong', C: 1 }] }), null);
    assert.equal(scaleFromMeasureDict({ Subtype: 'RL', X: [{ U: 'mm', C: 0 }] }), null);
  });
});

describe('viewports', () => {
  const a = { bbox: [0, 0, 600, 800], name: 'Sheet', scale: scaleFromDrawingScale(100, 'mm') };
  const b = { bbox: [400, 100, 300, 50], name: 'Detail', scale: scaleFromDrawingScale(20, 'mm') };
  test('viewportAt: the last /VP entry containing the point wins', () => {
    assert.equal(viewportAt([a, b], [350, 70]), b);
    assert.equal(viewportAt([{ ...b, bbox: [300, 50, 400, 100] }, a], [350, 70]), a, 'later entry wins');
    assert.equal(viewportAt([a, { ...b, bbox: [300, 50, 400, 100] }], [10, 10]), a);
    assert.equal(viewportAt([b], [10, 10]), null);
    assert.equal(viewportAt([], [10, 10]), null);
  });
  test('viewport dict round trip normalises /BBox', () => {
    const d = viewportDict(b);
    assert.deepEqual(d.BBox, [300, 50, 400, 100]);
    assert.equal(d.Type, 'Viewport');
    const back = viewportFromDict(d);
    assert.equal(back.name, 'Detail');
    near(back.scale.ratio, b.scale.ratio, 1e-12, 'scale');
    assert.equal(viewportFromDict({ BBox: [1, 2] }), null);
  });
});
