import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPair, chooseTab, pickForPane, closeTabIn } from '../renderer/ui/splitview-lib.js';

test('defaultPair: one document splits itself; several pair the active one with the previously active one', () => {
  assert.equal(defaultPair(null, []), null);
  assert.deepEqual(defaultPair('x', ['x']), ['x', 'x']);
  // Z active, Y before it: not the first tab X.
  assert.deepEqual(defaultPair('z', ['x', 'y', 'z'], ['z', 'y', 'x']), ['z', 'y']);
  // No history yet: the first other tab in strip order.
  assert.deepEqual(defaultPair('y', ['x', 'y', 'z'], []), ['y', 'x']);
  // Closed tabs in the history are skipped; no active tab: the first tab.
  assert.deepEqual(defaultPair('y', ['x', 'y'], ['y', 'gone', 'x']), ['y', 'x']);
  assert.deepEqual(defaultPair(null, ['x', 'y'], []), ['x', 'y']);
});

test('chooseTab: a tab-strip choice goes into the focused pane, whichever it is', () => {
  assert.deepEqual(chooseTab({ ids: ['y', 'z'], focus: 0 }, 'x'), { ids: ['x', 'z'], focus: 0 });
  assert.deepEqual(chooseTab({ ids: ['y', 'z'], focus: 1 }, 'x'), { ids: ['y', 'x'], focus: 1 });
  // A tab already in a pane focuses that pane.
  assert.deepEqual(chooseTab({ ids: ['y', 'z'], focus: 0 }, 'z'), { ids: ['y', 'z'], focus: 1 });
  assert.deepEqual(chooseTab({ ids: ['y', 'z'], focus: 1 }, 'z'), { ids: ['y', 'z'], focus: 1 });
  // The same document twice: another tab replaces the focused pane only.
  assert.deepEqual(chooseTab({ ids: ['x', 'x'], focus: 1 }, 'y'), { ids: ['x', 'y'], focus: 1 });
});

test('pickForPane: the header picker sets that pane and focuses it', () => {
  assert.deepEqual(pickForPane({ ids: ['x', 'z'], focus: 0 }, 1, 'y'), { ids: ['x', 'y'], focus: 1 });
  assert.deepEqual(pickForPane({ ids: ['x', 'z'], focus: 1 }, 0, 'y'), { ids: ['y', 'z'], focus: 0 });
  // Becoming the same document twice: the pane already showing it keeps the focus.
  assert.deepEqual(pickForPane({ ids: ['x', 'z'], focus: 1 }, 1, 'x'), { ids: ['x', 'x'], focus: 0 });
  // Leaving the same document.
  assert.deepEqual(pickForPane({ ids: ['x', 'x'], focus: 0 }, 1, 'y'), { ids: ['x', 'y'], focus: 1 });
});

test('closeTabIn: a closed tab in a pane is replaced by another open document, else the split closes', () => {
  // Not shown: nothing changes.
  assert.deepEqual(closeTabIn({ ids: ['x', 'y'], focus: 1 }, 'z', ['x', 'y'], []), { ids: ['x', 'y'], focus: 1 });
  // The most recently active document not in the other pane.
  assert.deepEqual(closeTabIn({ ids: ['y', 'z'], focus: 0 }, 'z', ['w', 'x', 'y'], ['y', 'x', 'w']), { ids: ['y', 'x'], focus: 0 });
  assert.deepEqual(closeTabIn({ ids: ['y', 'z'], focus: 1 }, 'y', ['x', 'z'], ['z', 'y', 'x']), { ids: ['x', 'z'], focus: 1 });
  // No history: strip order.
  assert.deepEqual(closeTabIn({ ids: ['x', 'y'], focus: 0 }, 'x', ['y', 'z'], []), { ids: ['z', 'y'], focus: 0 });
  // Only the other pane's document is left: the split closes.
  assert.equal(closeTabIn({ ids: ['x', 'y'], focus: 0 }, 'x', ['y'], ['y']), null);
  // The same document in both panes: both get the replacement; none left closes the split.
  assert.deepEqual(closeTabIn({ ids: ['x', 'x'], focus: 1 }, 'x', ['y', 'z'], ['z']), { ids: ['z', 'z'], focus: 1 });
  assert.equal(closeTabIn({ ids: ['x', 'x'], focus: 0 }, 'x', [], []), null);
});
