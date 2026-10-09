// Clipboard helpers (renderer/ui/clipboard-lib.js): summary text, clipboard-match rule, paste placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectsSummary, clipboardMatches, unionBox, pasteDelta, pastedImageSize, clampDelta, pageBox } from '../renderer/ui/clipboard-lib.js';

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

test('clampDelta: keeps the moved box inside the page; larger than the page -> top-left', () => {
  const page = { width: 600, height: 800 }, box = { x: 100, y: 100, w: 200, h: 50 };
  assert.deepEqual(clampDelta(box, 10, -20, page), { dx: 10, dy: -20 });      // inside: unchanged
  assert.deepEqual(clampDelta(box, 500, 0, page), { dx: 300, dy: 0 });       // right edge
  assert.deepEqual(clampDelta(box, -150, -150, page), { dx: -100, dy: -100 }); // top-left corner
  assert.deepEqual(clampDelta(box, 0, 900, page), { dx: 0, dy: 650 });        // bottom edge
  // Landscape (rotated) page: its own visible size bounds the move.
  assert.deepEqual(clampDelta(box, 0, 700, { width: 800, height: 600 }), { dx: 0, dy: 450 });
  // Wider than the page: x = 0 whatever the move.
  assert.deepEqual(clampDelta({ x: 50, y: 10, w: 900, h: 20 }, 30, 0, page), { dx: -50, dy: 0 });
});

test('clampDelta with a rotated stamp/image: clamps the turned bounds, not the unturned box', () => {
  const o = { x: 100, y: 100, w: 200, h: 40, rotation: 90 }; // turned about (200,120): 40 wide, 200 tall
  const page = { width: 612, height: 792 };
  const turned = pageBox(o, o.rotation);
  assert.deepEqual(pageBox(o, 0), o);
  assert.ok(Math.abs(turned.w - 40) < 1e-9 && Math.abs(turned.h - 200) < 1e-9);
  // Dragged far left/up: the turned box ends flush with the page edge (its centre keeps x = 20, y = 100).
  const d = clampDelta(turned, -500, -500, page);
  const cx = o.x + d.dx + o.w / 2, cy = o.y + d.dy + o.h / 2;
  assert.ok(Math.abs(cx - 20) < 1e-9 && Math.abs(cy - 100) < 1e-9, `${cx},${cy}`);
  // The unturned box would stop at the centre x = 100 instead, leaving the turned box 80 pt off the page.
  assert.equal(clampDelta({ x: o.x, y: o.y, w: o.w, h: o.h }, -500, -500, page).dx + o.x, 0);
  // Right/bottom edge.
  const e = clampDelta(turned, 900, 900, page);
  assert.ok(Math.abs(o.x + e.dx + o.w / 2 - 592) < 1e-9 && Math.abs(o.y + e.dy + o.h / 2 - 692) < 1e-9);
});
