import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textAngle, boxToQuad, mergeLines, quadsFromBoxes, quadsBox } from '../renderer/ui/markup-geom.js';

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
