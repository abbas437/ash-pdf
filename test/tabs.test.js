import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveItem, dropSlot, slotToIndex } from '../renderer/ui/tabs-lib.js';

test('moveItem reorders in place and clamps', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 9), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 5, 0), ['a', 'b', 'c']);
  assert.deepEqual(moveItem([], 0, 0), []);
});

test('dropSlot / slotToIndex map a pointer position to the final index', () => {
  const centres = [50, 150, 250];
  assert.equal(dropSlot(centres, 10), 0);
  assert.equal(dropSlot(centres, 100), 1);
  assert.equal(dropSlot(centres, 400), 3);
  assert.equal(slotToIndex(2, 0), 0);
  assert.equal(slotToIndex(0, 3), 2);
  assert.equal(slotToIndex(1, 1), 1);
  assert.equal(slotToIndex(1, 2), 1);
});

test('tabsToClose: this / others / left / right / all, in strip order', async () => {
  const { tabsToClose } = await import('../renderer/ui/tabs-lib.js');
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(tabsToClose(ids, 'c', 'this'), ['c']);
  assert.deepEqual(tabsToClose(ids, 'c', 'others'), ['a', 'b', 'd']);
  assert.deepEqual(tabsToClose(ids, 'c', 'left'), ['a', 'b']);
  assert.deepEqual(tabsToClose(ids, 'c', 'right'), ['d']);
  assert.deepEqual(tabsToClose(ids, 'c', 'all'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(tabsToClose(ids, 'a', 'left'), []);
  assert.deepEqual(tabsToClose(ids, 'd', 'right'), []);
  assert.deepEqual(tabsToClose(ids, 'x', 'others'), [], 'unknown tab');
  assert.deepEqual(tabsToClose(ids, 'x', 'all'), ids);
});
