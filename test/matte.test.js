import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apMatte } from '../renderer/ui/matte.js';

test('apMatte: clear, opaque and half-covered pixels', () => {
  // pixel 1: nothing drawn (white on white, black on black) -> transparent
  // pixel 2: opaque blue (0,0,200) -> same on both
  // pixel 3: blue (0,0,200) at 50 % -> on white (128,128,228), on black (0,0,100)
  const W = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 200, 255, 128, 128, 228, 255]);
  const B = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 200, 255, 0, 0, 100, 255]);
  const o = apMatte(W, B);
  assert.equal(o[3], 0);
  assert.deepEqual([...o.slice(4, 8)], [0, 0, 200, 255]);
  assert.ok(Math.abs(o[11] - 127) <= 1);
  assert.ok(Math.abs(o[10] - 200) <= 2 && o[8] === 0);
});
