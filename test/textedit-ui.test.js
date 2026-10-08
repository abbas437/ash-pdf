// Edit text tool geometry (renderer/ui/textedit-lib.js): editor placement from a PDF-space line bbox,
// zoom and /Rotate; hit testing; click position -> word selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorPlacement, lineBox, lineAt, charIndexAt, wordAt } from '../renderer/ui/textedit-lib.js';

const g0 = { view: [0, 0, 612, 792], rotate: 0 };
const g90 = { view: [0, 0, 612, 792], rotate: 90 };
const line = { text: 'Invoice number 4711', bbox: [50, 696, 250, 712], size: 14 };

test('editorPlacement: page space (y down) times scale; font size = line size x scale', () => {
  assert.deepEqual(editorPlacement(g0, line.bbox, 14, 2), { left: 100, top: 160, width: 400, height: 32, fontSize: 28 });
});

test('editorPlacement and lineAt follow /Rotate 90', () => {
  // Rotate 90: page x = PDF y, page y = PDF x.
  assert.deepEqual(editorPlacement(g90, line.bbox, 14, 1), { left: 696, top: 50, width: 16, height: 200, fontSize: 14 });
  const other = { text: 'Other', bbox: [50, 600, 150, 616] };
  assert.equal(lineAt(g90, [other, line], 704, 120), line);
  assert.equal(lineAt(g90, [other, line], 608, 100), other);
  assert.equal(lineAt(g90, [other, line], 300, 300), null);
});

test('lineAt prefers the smallest box under the point', () => {
  const big = { bbox: [0, 600, 600, 720] }, small = { bbox: [50, 696, 250, 712] };
  assert.equal(lineAt(g0, [big, small], 100, 90), small);
});

test('charIndexAt and wordAt pick the word under the click', () => {
  // x = 50 + 200 * 16/19 lands in "4711"
  const i = charIndexAt(g0, line, 50 + 200 * (16 / 19), 88);
  assert.equal(i, 16);
  assert.deepEqual(wordAt(line.text, i), [15, 19]);
  assert.deepEqual(wordAt('a  b', 2), [0, 4]);
  assert.equal(charIndexAt(g0, line, 0, 88), 0);
  assert.equal(charIndexAt(g0, line, 600, 88), line.text.length);
});

test('lineBox grows a flat PDFium bbox to the font size, keeps a real one', () => {
  assert.deepEqual(lineBox({ bbox: [50, 620, 111, 620], size: 10 }), [50, 618, 111, 628]);
  assert.deepEqual(lineBox({ bbox: [50, 620, 52, 700], size: 10, rotation: 90 }), [42, 620, 54, 700]);
  assert.deepEqual(lineBox(line), line.bbox);
  const flat = { bbox: [50, 620, 111, 620], size: 16 }; // page y 159.2 .. 175.2
  assert.equal(lineAt(g0, [flat], 80, 165), flat);
});
