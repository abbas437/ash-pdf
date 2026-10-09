import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWindowState } from '../electron/sessionState.js';

const A = '/docs/a.pdf', B = '/docs/b.pdf', C = '/docs/c.pdf';
const all = () => true;
const base = (split) => ({ files: [{ path: A, page: 2 }, { path: B, page: 1 }], active: B, split });
const files = [{ path: A, page: 2 }, { path: B, page: 1 }];

test('a valid split is kept', () => {
  const split = { dir: 'h', ratio: 0.3, files: [A, B], focus: 1 };
  assert.deepEqual(cleanWindowState(base(split), all), { files, active: B, split });
});

test('the same document in both panes is a valid split', () => {
  const split = { dir: 'v', ratio: 0.5, files: [A, A], focus: 0 };
  assert.deepEqual(cleanWindowState(base(split), all).split, split);
});

test('no split: no split field', () => {
  assert.deepEqual(cleanWindowState(base(undefined), all), { files, active: B });
});

test('ratio is clamped to the divider range', () => {
  assert.equal(cleanWindowState(base({ dir: 'v', ratio: 0.01, files: [A, B], focus: 0 }), all).split.ratio, 0.15);
  assert.equal(cleanWindowState(base({ dir: 'v', ratio: 5, files: [A, B], focus: 0 }), all).split.ratio, 0.85);
});

test('an invalid split is dropped and the files kept', () => {
  const ok = { dir: 'v', ratio: 0.4, files: [A, B], focus: 0 };
  const bad = [
    null, 'v', [], { ...ok, dir: 'x' }, { ...ok, dir: undefined },
    { ...ok, ratio: NaN }, { ...ok, ratio: Infinity }, { ...ok, ratio: '0.4' }, { ...ok, ratio: undefined },
    { ...ok, focus: 2 }, { ...ok, focus: '1' }, { ...ok, focus: -1 }, { ...ok, focus: undefined },
    { ...ok, files: [A] }, { ...ok, files: [A, B, A] }, { ...ok, files: 'a' }, { ...ok, files: [A, C] },
    { ...ok, files: [A, 'relative.pdf'] }, { ...ok, files: [A, 42] }, { ...ok, files: [, A] }, // eslint-disable-line no-sparse-arrays
  ];
  for (const split of bad) assert.deepEqual(cleanWindowState(base(split), all), { files, active: B }, JSON.stringify(split));
});

test('a split file dropped by accept drops the split', () => {
  const r = cleanWindowState(base({ dir: 'v', ratio: 0.4, files: [A, B], focus: 0 }), (p) => p !== B);
  assert.deepEqual(r, { files: [{ path: A, page: 2 }], active: null });
});

test('files: duplicates, bad pages and bad paths are cleaned as before', () => {
  const r = cleanWindowState({ files: [{ path: A, page: 0 }, { path: A, page: 3 }, { path: 'x.pdf' }, 7, { path: B, page: 4 }], active: C }, all);
  assert.deepEqual(r, { files: [{ path: A, page: 1 }, { path: B, page: 4 }], active: null });
  assert.equal(cleanWindowState({ files: 'x' }, all), null);
  assert.equal(cleanWindowState(null, all), null);
});

test('split paths are stored in the spelling of the kept file', () => {
  const r = cleanWindowState(base({ dir: 'v', ratio: 0.4, files: ['/docs/./a.pdf', '/docs/x/../b.pdf'], focus: 0 }), all);
  assert.deepEqual(r.split.files, [A, B]);
});
