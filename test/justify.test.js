// Justified-line layout math for the Edit text tool (renderer/pdfium/justify.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSpread, layoutWords, sameLineText, lineWords, SPREAD_RATIO } from '../renderer/pdfium/justify.js';

test('isSpread: word gaps wider than SPREAD_RATIO x a space mark a justified line', () => {
  // 5 words of 200 pt total with 4 gaps: natural extent 200 + 4 x 3 = 212.
  assert.equal(isSpread({ extent: 212, wordsWidth: 200, gaps: 4, space: 3 }), false, 'normal spacing');
  assert.equal(isSpread({ extent: 200 + 4 * 3 * SPREAD_RATIO, wordsWidth: 200, gaps: 4, space: 3 }), false, 'at the threshold');
  assert.equal(isSpread({ extent: 240, wordsWidth: 200, gaps: 4, space: 3 }), true, '10 pt gaps');
  assert.equal(isSpread({ extent: 400, wordsWidth: 100, gaps: 0, space: 3 }), false, 'one word is never spread');
  assert.equal(isSpread({ extent: 240, wordsWidth: 200, gaps: 4, space: 0 }), false, 'no space width');
});

test('layoutWords: first word at the start, last word ending at the end, equal gaps', () => {
  const { positions, gap, spread } = layoutWords({ start: 72, end: 540, widths: [40, 60, 80], space: 3 });
  assert.equal(spread, true);
  assert.equal(gap, (468 - 180) / 2);
  assert.deepEqual(positions, [72, 72 + 40 + 144, 72 + 40 + 144 + 60 + 144]);
  assert.equal(positions[2] + 80, 540);
});

test('layoutWords: words wider than the extent (or one word) fall back to normal spacing from the start', () => {
  assert.deepEqual(layoutWords({ start: 72, end: 200, widths: [70, 60], space: 3 }), { positions: [72, 145], gap: 3, spread: false });
  assert.deepEqual(layoutWords({ start: 72, end: 141, widths: [33, 33], space: 3 }), { positions: [72, 108], gap: 3, spread: true }, 'exactly one space fits');
  assert.deepEqual(layoutWords({ start: 72, end: 540, widths: [50], space: 3 }), { positions: [72], gap: 3, spread: false });
});

test('sameLineText / lineWords normalise whitespace like the editor', () => {
  assert.equal(sameLineText('Subject  to any ', 'Subject to any'), true);
  assert.equal(sameLineText('a\tb\nc', 'a b c'), true);
  assert.equal(sameLineText('a b', 'a  c'), false);
  assert.deepEqual(lineWords('  2.5.1   Name: x '), ['2.5.1', 'Name:', 'x']);
  assert.deepEqual(lineWords('   '), []);
});
