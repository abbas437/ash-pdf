// Group / Ungroup and group resize (renderer/ui/grouping-lib.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canGroup, canUngroup, groupPatches, ungroupPatches, soleGroup, groupResizeBox, scaleMember } from '../renderer/ui/grouping-lib.js';

const box = { bbox: (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }), handles: () => [{ id: 'se' }], move: (o, dx, dy) => ({ x: o.x + dx, y: o.y + dy }), resize: () => assert.fail('box types scale without resize') };
const from = { x: 100, y: 100, w: 200, h: 100 }, to = { x: 100, y: 100, w: 300, h: 150 }; // +50 % about the nw corner

test('canGroup / canUngroup guards', () => {
  const a = { id: 'a' }, b = { id: 'b' }, g1 = { id: 'c', group: 'g' }, g2 = { id: 'd', group: 'g' }, sig = { id: 'e', group: 's', sig: 'x' };
  assert.equal(canGroup([a]), false);
  assert.equal(canGroup([a, b]), true);
  assert.equal(canGroup([a, b], true), false, 'read-only');
  assert.equal(canGroup([a, g1, g2]), true, 'merges a group with another object');
  assert.equal(canGroup([g1, g2]), false, 'already one group');
  assert.equal(canGroup([a, sig]), false, 'signature block');
  assert.equal(canUngroup([a, b]), false);
  assert.equal(canUngroup([g1, g2]), true);
  assert.equal(canUngroup([g1, g2], true), false, 'read-only');
  assert.equal(canUngroup([sig, { ...sig, id: 'f' }]), false, 'signature block');
});

test('groupPatches / ungroupPatches', () => {
  const objs = [{ id: 'a' }, { id: 'b', group: 'old' }];
  assert.deepEqual([...groupPatches(objs, 'new')], [['a', { group: 'new' }], ['b', { group: 'new' }]]);
  assert.deepEqual([...ungroupPatches(objs)], [['b', { group: undefined }]]);
});

test('soleGroup: exactly one group of 2+ on one page', () => {
  assert.equal(soleGroup([{ group: 'g', page: 0 }, { group: 'g', page: 0 }]), 'g');
  assert.equal(soleGroup([{ group: 'g', page: 0 }]), null);
  assert.equal(soleGroup([{ group: 'g', page: 0 }, { group: 'h', page: 0 }]), null);
  assert.equal(soleGroup([{ group: 'g', page: 0 }, { page: 0 }]), null);
  assert.equal(soleGroup([{ group: 'g', page: 0, sig: 's1' }, { group: 'g', page: 0 }]), null, 'signature block: no group handles');
  assert.equal(soleGroup([{ group: 'g', page: 0 }, { group: 'g', page: 1 }]), null);
});

test('groupResizeBox: opposite edge stays, Shift corner keeps the aspect, never flips', () => {
  assert.deepEqual(groupResizeBox(from, 'se', 100, 50), to);
  assert.deepEqual(groupResizeBox(from, 'nw', -100, 20), { x: 0, y: 120, w: 300, h: 80 });
  assert.deepEqual(groupResizeBox(from, 'e', 50, 999), { x: 100, y: 100, w: 250, h: 100 });
  assert.deepEqual(groupResizeBox(from, 'n', 999, -10), { x: 100, y: 90, w: 200, h: 110 });
  assert.deepEqual(groupResizeBox(from, 'se', 100, 0, true), to, 'aspect: the larger scale wins');
  assert.deepEqual(groupResizeBox(from, 'e', 100, 0, true), { x: 100, y: 100, w: 300, h: 100 }, 'aspect only on corners');
  const tiny = groupResizeBox(from, 'se', -500, -500);
  assert.equal(tiny.x, 100); assert.equal(tiny.w, 1); assert.equal(tiny.h, 1);
  assert.deepEqual(groupResizeBox(from, 'w', 500, 0), { x: 299, y: 100, w: 1, h: 100 });
});

test('scaleMember: boxes scale position and size, keep stroke width', () => {
  const r = { type: 'rect', x: 200, y: 150, w: 100, h: 50, strokeWidth: 3 };
  assert.deepEqual(scaleMember(r, from, to, box), { w: 150, h: 75, x: 250, y: 175 });
  // about the se corner (nw handle): the far corner stays
  assert.deepEqual(scaleMember({ x: 100, y: 100, w: 200, h: 100 }, from, { x: 0, y: 50, w: 300, h: 150 }, box), { w: 300, h: 150, x: 0, y: 50 });
});

test('scaleMember: line end points and ink points scale', () => {
  const line = { handles: () => [{ id: 'p1' }] };
  assert.deepEqual(scaleMember({ x1: 100, y1: 100, x2: 300, y2: 200, strokeWidth: 2 }, from, to, line), { x1: 100, y1: 100, x2: 400, y2: 250 });
  assert.deepEqual(scaleMember({ points: [[100, 200], [200, 150]] }, from, to, line), { points: [[100, 250], [250, 175]] });
});

test('scaleMember: text boxes resize through the type (scaled height as minH), font size kept', () => {
  const calls = [];
  const text = { ...box, resize: (o, h, dx, dy) => { calls.push([h, dx, dy]); return { x: o.x, y: o.y, w: o.w + dx, h: Math.max(40, o.h + dy), minH: o.h + dy }; } };
  const t = { type: 'text', text: 'Hi', x: 100, y: 200, w: 100, h: 20, fontSize: 12 };
  assert.deepEqual(scaleMember(t, from, to, text), { x: 100, y: 250, w: 150, h: 40, minH: 30 });
  assert.deepEqual(calls, [['se', 50, 10]]);
  // callout: the leader tip scales too
  const c = scaleMember({ ...t, tx: 300, ty: 100 }, from, to, text);
  assert.equal(c.tx, 400); assert.equal(c.ty, 100);
});

test('scaleMember: fixed-size items only move (centre follows), fixed markups stay', () => {
  const note = { ...box, handles: () => [], bbox: (o) => ({ x: o.x, y: o.y, w: 24, h: 24 }) };
  assert.deepEqual(scaleMember({ x: 288, y: 188 }, from, to, note), { x: 388, y: 238 }); // centre (300,200) -> (400,250)
  assert.deepEqual(scaleMember({ quads: [] }, from, to, { ...box, fixed: true }), {});
});
