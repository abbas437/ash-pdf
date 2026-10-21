// Gesture diffs of annotation objects (renderer/ui/objdiff-lib.js): picture bytes are never stringified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stable, changedKeys } from '../renderer/ui/objdiff-lib.js';

test('changedKeys: shared picture bytes are equal by reference, moved geometry and added / removed keys differ', () => {
  const bytes = new Uint8Array(4 << 20);
  const images = { p: { bytes, mime: 'image/png' } };
  const o0 = { id: 'a', type: 'text', x: 1, y: 2, images, runs: [{ text: 'x' }] };
  const o = { ...o0, x: 5, runs: [{ text: 'x' }], minH: 30 };
  const orig = JSON.stringify;
  JSON.stringify = (v, ...r) => { if (v instanceof Uint8Array || v?.bytes instanceof Uint8Array || v?.p) throw new Error('picture bytes stringified'); return orig(v, ...r); };
  try {
    assert.deepEqual(changedKeys(o, o0), ['x', 'minH']);
  } finally { JSON.stringify = orig; }
  assert.deepEqual(changedKeys({ id: 'a', x: 1 }, { id: 'a', x: 1, y: undefined }), []);
  assert.deepEqual(changedKeys({ id: 'a', x: null }, { id: 'a' }), ['x']);
  // equal content in another array is still equal; different content differs
  assert.deepEqual(changedKeys({ b: new Uint8Array([1, 2]) }, { b: new Uint8Array([1, 2]) }), []);
  assert.deepEqual(changedKeys({ b: new Uint8Array([1, 2]) }, { b: new Uint8Array([1, 3]) }), ['b']);
});

test('stable hashes typed arrays and ignores key order and source', () => {
  assert.equal(stable({ a: 1, b: [1, 2], source: { x: 1 } }), stable({ b: [1, 2], a: 1 }));
  assert.match(stable(new Uint8Array(1000)), /^"#1000:\d+"$/);
});
