import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRatio, parseFeetInches, parseLength, calibrationError, snapAngle, buildScale, precisionChoices, sourceText, chipText, formFromScale, IMPERIAL_PRESETS } from '../renderer/ui/measure-scale-lib.js';
import { scaleFromDrawingScale, scaleFromPaper } from '../src/core/measure.js';

test('parseRatio: custom 1:n', () => {
  assert.equal(parseRatio('1:75'), 75);
  assert.equal(parseRatio(' 1 : 75 '), 75);
  assert.equal(parseRatio('75'), 75);
  assert.equal(parseRatio('1:2.5'), 2.5);
  assert.equal(parseRatio('1:2,5'), 2.5);
  for (const bad of ['', '1:', '1:0', '0', '-5', '1:-5', '2:50', 'abc', '1:5x']) assert.equal(parseRatio(bad), null, bad);
});

test('parseFeetInches: ft-in entries to decimal feet', () => {
  assert.equal(parseFeetInches(`12'-6"`), 12.5);
  assert.equal(parseFeetInches(`12' 6"`), 12.5);
  assert.equal(parseFeetInches(`12'6"`), 12.5);
  assert.equal(parseFeetInches(`12'`), 12);
  assert.equal(parseFeetInches(`12.5'`), 12.5);
  assert.equal(parseFeetInches(`6"`), 0.5);
  assert.equal(parseFeetInches(`0'-6 1/2"`), 6.5 / 12);
  assert.equal(parseFeetInches(`1/2"`), 0.5 / 12);
  assert.equal(parseFeetInches('10'), 10);
  assert.equal(parseFeetInches('12′-6″'), 12.5);
  for (const bad of ['', `0'`, `'6"`, `12'-x"`, 'ft', `-3'`, `1/0"`]) assert.equal(parseFeetInches(bad), null, bad);
});

test('parseLength: real length in a unit', () => {
  assert.equal(parseLength('1000', 'mm'), 1000);
  assert.equal(parseLength('2,5', 'm'), 2.5);
  assert.equal(parseLength('2.5 m', 'm'), 2.5);
  assert.equal(parseLength('6 1/2', 'in'), 6.5);
  assert.equal(parseLength(`10'-6"`, 'ft'), 10.5);
  for (const bad of ['', '0', '-1', 'abc', '1e3x']) assert.equal(parseLength(bad, 'mm'), null, bad);
});

test('calibrationError: refuses a line under 5 pt', () => {
  assert.match(calibrationError(4.9), /too short/);
  assert.equal(calibrationError(5), null);
  assert.equal(calibrationError(100), null);
});

test('snapAngle: 0/45/90 degrees, length kept', () => {
  assert.deepEqual(snapAngle({ x: 0, y: 0 }, { x: 100, y: 7 }), { x: Math.round(Math.hypot(100, 7) * 1e9) / 1e9, y: 0 });
  assert.deepEqual(snapAngle({ x: 10, y: 10 }, { x: 12, y: 60 }), { x: 10, y: Math.round((10 + Math.hypot(2, 50)) * 1e9) / 1e9 });
  const d = snapAngle({ x: 0, y: 0 }, { x: 50, y: 45 });
  assert.ok(Math.abs(d.x - d.y) < 1e-9 && Math.abs(Math.hypot(d.x, d.y) - Math.hypot(50, 45)) < 1e-9);
});

test('buildScale: drawing, imperial and calibrated choices', () => {
  assert.deepEqual(buildScale({ mode: 'metric', n: 20, unit: 'mm', precision: 1 }), scaleFromDrawingScale(20, 'mm', { precision: 1 }));
  const q = buildScale({ mode: 'imperial', imperial: 2, display: 'ftin', precision: 8 });
  assert.deepEqual(q, scaleFromPaper(0.25, 'in', 1, 'ft', { precision: 8, style: 'architectural', label: IMPERIAL_PRESETS[2].label }));
  assert.ok(Math.abs(q.ratio - 1 / 18) < 1e-12, '1/4" = 1\'-0": 18 pt per foot');
  assert.equal(buildScale({ mode: 'imperial', imperial: 5, display: 'decimal', precision: 2 }).style, undefined);
  const c = buildScale({ mode: 'calibrated', lengthPt: 100, real: 1000, unit: 'mm', precision: 0 });
  assert.equal(c.ratio, 10);
  assert.equal(c.unit, 'mm');
});

test('precision choices, labels and the starting form', () => {
  assert.deepEqual(precisionChoices('ft', 'ftin').map((c) => c.label), ['1/16"', '1/8"', '1/4"', '1/2"']);
  assert.deepEqual(precisionChoices('mm').map((c) => c.value), [0, 1, 2, 3]);
  const s50 = scaleFromDrawingScale(50, 'mm');
  assert.equal(sourceText({ scale: s50, source: 'pdf' }), 'From the PDF');
  assert.equal(sourceText({ scale: s50, source: 'preset' }), '1:50');
  assert.equal(sourceText({ scale: s50, source: 'default' }), 'Default');
  assert.equal(sourceText({ scale: s50, source: 'calibrated' }), 'Calibrated');
  assert.equal(chipText({ scale: s50, source: 'preset' }), 'Scale 1:50 (mm)');
  assert.equal(chipText({ scale: buildScale({ mode: 'imperial', imperial: 2, display: 'ftin', precision: 16 }), source: 'preset' }), 'Scale 1/4" = 1\'-0" (ft-in)');
  assert.equal(chipText({ scale: buildScale({ mode: 'calibrated', lengthPt: 100, real: 1, unit: 'm' }), source: 'calibrated' }), 'Scale calibrated (m)');
  assert.deepEqual(formFromScale(scaleFromDrawingScale(100, 'm')), { mode: 'metric', n: 100, unit: 'm', imperial: 2, display: 'ftin', precision: 3 });
  assert.equal(formFromScale(buildScale({ mode: 'imperial', imperial: 6, display: 'decimal', precision: 2 })).imperial, 6);
});

test('buildScale: a scale out of range is a clear error, not a scale', () => {
  assert.throws(() => buildScale({ mode: 'metric', n: 1e12, unit: 'mm', precision: 1 }), /out of range/);
  assert.throws(() => buildScale({ mode: 'calibrated', lengthPt: 1000, real: 1e-12, unit: 'mm', precision: 1 }), /out of range/);
});
