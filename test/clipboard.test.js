// Clipboard helpers (renderer/ui/clipboard-lib.js): summary text, clipboard-match rule, paste placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectsSummary, clipboardMatches, unionBox, pasteDelta, pastedImageSize } from '../renderer/ui/clipboard-lib.js';

test('objectsSummary: texts of text objects, else a count', () => {
  assert.equal(objectsSummary([{ type: 'text', text: ' Hi ' }, { type: 'rect' }, { type: 'callout', text: 'There' }]), 'Hi\nThere');
  assert.equal(objectsSummary([{ type: 'rect' }]), '1 object (ASH PDF Studio)');
  assert.equal(objectsSummary([{ type: 'rect' }, { type: 'line' }]), '2 objects (ASH PDF Studio)');
});

test('clipboardMatches: only the exact text written at copy time', () => {
  assert.equal(clipboardMatches('1 object (ASH PDF Studio)', '1 object (ASH PDF Studio)'), true);
  assert.equal(clipboardMatches('1 object (ASH PDF Studio)', 'Hello paste'), false);
  assert.equal(clipboardMatches('x', ''), false);
  assert.equal(clipboardMatches(null, ''), false);
  assert.equal(clipboardMatches('', ''), false);
});

test('unionBox', () => {
  assert.deepEqual(unionBox([{ x: 10, y: 20, w: 5, h: 5 }, { x: 0, y: 30, w: 4, h: 10 }]), { x: 0, y: 20, w: 15, h: 20 });
  assert.equal(unionBox([]), null);
});

test('pasteDelta: centred on the target point, clamped into the page', () => {
  const page = { width: 600, height: 800 }, box = { x: 100, y: 100, w: 50, h: 40 };
  assert.deepEqual(pasteDelta(box, 0, { page: 1, x: 300, y: 400 }, page), { dx: 175, dy: 280 });
  assert.deepEqual(pasteDelta(box, 0, { page: 0, x: 590, y: 5 }, page), { dx: 450, dy: -100 }); // right / top edge
});

test('pasteDelta: offset when it would sit exactly on the originals', () => {
  const page = { width: 600, height: 800 }, box = { x: 100, y: 100, w: 50, h: 40 };
  assert.deepEqual(pasteDelta(box, 0, { page: 0, x: 125, y: 120 }, page), { dx: 12, dy: 12 });
  assert.deepEqual(pasteDelta(box, 0, { page: 1, x: 125, y: 120 }, page), { dx: 0, dy: 0 }); // other page: same place
});

test('pastedImageSize: 96 dpi, never larger than half the page, aspect kept, never enlarged', () => {
  const page = { width: 612, height: 792 };
  assert.deepEqual(pastedImageSize(200, 100, page), { w: 150, h: 75 });          // small: natural size
  assert.deepEqual(pastedImageSize(800, 400, page), { w: 306, h: 153 });         // wide: half the width
  const tall = pastedImageSize(400, 2000, page);                                 // tall: half the height
  assert.equal(tall.h, 396); assert.ok(Math.abs(tall.w / tall.h - 0.2) < 1e-9);
});

test('isCountSummary: only the count-only object summary', async () => {
  const { isCountSummary, objectsSummary } = await import('../renderer/ui/clipboard-lib.js');
  assert.equal(isCountSummary(objectsSummary([{}])), true);
  assert.equal(isCountSummary(objectsSummary([{}, {}])), true);
  assert.equal(isCountSummary('Hello paste'), false);
  assert.equal(isCountSummary('3 objects (somewhere else)'), false);
});
