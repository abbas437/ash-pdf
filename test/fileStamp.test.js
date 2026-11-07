import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampOf, cleanExpect, changedSince } from '../electron/fileStamp.js';

const S = { mtimeNs: '1700000000123456789', size: 1234 };

test('stampOf keeps nanoseconds as a digit string', () => {
  assert.deepEqual(stampOf({ mtimeNs: 1700000000123456789n, size: 1234n }), S);
});

test('cleanExpect: missing means no check', () => {
  assert.equal(cleanExpect(undefined), null);
  assert.equal(cleanExpect(null), null);
});

test('cleanExpect: a stamp of digit strings or finite integers is normalised', () => {
  assert.deepEqual(cleanExpect(S), S);
  assert.deepEqual(cleanExpect({ mtimeNs: 5, size: '7' }), { mtimeNs: '5', size: 7 });
  assert.deepEqual(cleanExpect({ mtimeNs: '007', size: 0 }), { mtimeNs: '7', size: 0 });
});

test('cleanExpect: anything else is refused', () => {
  for (const bad of ['1:2', 5, [], { size: 1 }, { mtimeNs: '1' }, { mtimeNs: '-1', size: 1 }, { mtimeNs: '1.5', size: 1 },
    { mtimeNs: 1, size: NaN }, { mtimeNs: 1, size: Infinity }, { mtimeNs: 1, size: -1 }, { mtimeNs: 1.5, size: 1 }, { mtimeNs: '1e3', size: 1 },
    { mtimeNs: 'x'.repeat(40), size: 1 }, { mtimeNs: 1n, size: 1 }]) {
    assert.throws(() => cleanExpect(bad), TypeError, JSON.stringify(bad, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  }
});

test('changedSince compares mtime and size; no expect or a missing file is no change', () => {
  assert.equal(changedSince(S, { ...S }), false);
  assert.equal(changedSince(S, { ...S, mtimeNs: '1700000000123456790' }), true);
  assert.equal(changedSince(S, { ...S, size: 1235 }), true);
  assert.equal(changedSince(null, S), false);
  assert.equal(changedSince(S, null), false);
});
