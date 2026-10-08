import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textAngle, boxToQuad, mergeLines, quadsFromBoxes, quadsBox, buildCharModel, caretAt, wordAt, rangeQuads } from '../renderer/ui/markup-geom.js';

test('textAngle: page rotation counts, view rotation does not', () => {
  assert.equal(textAngle(90, 0), 90);   // /Rotate 90 page, upright view
  assert.equal(textAngle(90, 90), 0);   // view rotated 90 on a normal page
  assert.equal(textAngle(180, 90, 0), 90);
  assert.equal(textAngle(0, 0, -90), 270);
});

test('boxToQuad orders corners in the text frame', () => {
  const b = { x0: 10, y0: 20, x1: 30, y1: 25 };
  assert.deepEqual(boxToQuad(b, 0), [10, 20, 30, 20, 10, 25, 30, 25]);
  // Text running down (rotated 90 cw): top edge of the glyphs is the right side of the box.
  assert.deepEqual(boxToQuad(b, 90), [30, 20, 30, 25, 10, 20, 10, 25]);
  assert.deepEqual(boxToQuad(b, 180), [30, 25, 10, 25, 30, 20, 10, 20]);
  assert.deepEqual(boxToQuad(b, 270), [10, 25, 10, 20, 30, 25, 30, 20]);
});

test('mergeLines merges fragments of one line, keeps lines and directions apart', () => {
  const frags = [
    { x0: 10, y0: 100, x1: 50, y1: 112, angle: 0 },
    { x0: 52, y0: 101, x1: 90, y1: 112, angle: 0 },   // same line, small gap
    { x0: 10, y0: 115, x1: 60, y1: 127, angle: 0 },   // next line
    { x0: 200, y0: 100, x1: 220, y1: 112, angle: 0 }, // same baseline, far column
    { x0: 300, y0: 10, x1: 312, y1: 40, angle: 90 },
    { x0: 300, y0: 42, x1: 312, y1: 70, angle: 90 },  // same vertical line
    { x0: 1, y0: 1, x1: 1, y1: 5, angle: 0 },         // empty, dropped
  ];
  const m = mergeLines(frags);
  assert.equal(m.length, 4);
  assert.deepEqual([m[0].x0, m[0].y0, m[0].x1, m[0].y1], [10, 100, 90, 112]);
  assert.deepEqual([m[3].x0, m[3].y0, m[3].x1, m[3].y1, m[3].angle], [300, 10, 312, 70, 90]);
  const q = quadsFromBoxes(frags);
  assert.equal(q.length, 4);
  assert.deepEqual(quadsBox(q), { x: 10, y: 10, w: 302, h: 117 });
});

// Three 20-char lines, 11 pt at 1.2 line spacing, every char 5 pt wide (measure gives equal advances).
const LINES = ['Hello world line one', 'second line of texts', 'third line goes here'];
const para = () => buildCharModel(
  LINES.map((str, i) => ({ str, width: 100, transform: [11, 0, 0, 11, 72, 700 - 13.2 * i], fontName: 'f1', hasEOL: true })),
  { f1: { ascent: 0.75, descent: -0.25, fontFamily: 'sans-serif' } },
  (ux, uy) => [ux, 792 - uy], (chars) => chars.map(() => 1));
const box = (q) => { const b = quadsBox([q]); return [b.x, b.y, b.x + b.w, b.y + b.h].map((v) => Math.round(v * 100) / 100); };

test('char model: one line run per text line, boxes from the font ascent/descent', () => {
  const m = para();
  assert.equal(m.chars.length, 60);
  assert.deepEqual(m.lines.map((L) => [L.start, L.end]), [[0, 20], [20, 40], [40, 60]]);
  assert.deepEqual([m.chars[0].x0, m.chars[0].x1, m.chars[0].y0, m.chars[0].y1], [72, 77, 83.75, 94.75]);
});

test('range -> quads: drag from mid-word on line 1 to mid-word on line 3 snaps to char boundaries', () => {
  const m = para();
  const a = caretAt(m, 88.9, 90), b = caretAt(m, 111, 117);   // inside "l" of "Hello" (left half) / right half of "l" in "line"
  assert.equal(a, 3);
  assert.equal(b, 48);
  const q = rangeQuads(m, a, b);
  assert.equal(q.length, 3);
  assert.deepEqual(box(q[0]), [87, 83.75, 172, 94.75]);      // char 3 .. end of line 1, not the pointer x
  assert.deepEqual(box(q[1]), [72, 96.95, 172, 107.95]);     // whole line 2
  assert.deepEqual(box(q[2]), [72, 110.15, 112, 121.15]);    // line 3 start .. char boundary after "thi... l"
  assert.deepEqual(rangeQuads(m, b, a), q);                  // backwards drag gives the same quads
});

test('range -> quads: vertical extent comes from the text item, not the pointer y', () => {
  const m = para();
  const a = caretAt(m, 72, 95.5), b = caretAt(m, 101, 83);  // pointer below / above the glyph box of line 1
  assert.deepEqual([a, b], [0, 6]);
  assert.deepEqual(rangeQuads(m, a, b).map(box), [[72, 83.75, 97, 94.75]]); // "Hello" (trailing space trimmed)
  assert.equal(caretAt(m, 400, 400, 11), null);             // far from any text: no caret
  assert.equal(rangeQuads(m, 5, 6).length, 0);              // a lone space makes no quad
});

test('wordAt selects the whole word under the point', () => {
  const m = para();
  assert.deepEqual(wordAt(m, 110, 90), [6, 11]);            // "world"
  assert.deepEqual(rangeQuads(m, ...wordAt(m, 110, 90)).map(box), [[102, 83.75, 127, 94.75]]);
  assert.equal(wordAt(m, 99, 90), null);                    // the space between words
});
