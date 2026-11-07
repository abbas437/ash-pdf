import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPair, chooseTab, pickForPane, closeTabIn, pageAt, topFor, syncScroll, zoomToSync } from '../renderer/ui/splitview-lib.js';

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

// Page boxes as the viewer lays them out: 8 px padding on top, a 16 px gap between pages.
const column = (n, w, hgt, clientWidth = 600) => {
  const tops = [], heights = [], lefts = [], widths = [];
  for (let i = 0; i < n; i++) { tops.push(8 + i * (hgt + 16)); heights.push(hgt); lefts.push(Math.max(16, (clientWidth - w) / 2)); widths.push(w); }
  return { tops, heights, lefts, widths, clientWidth };
};

test('pageAt: page index and fraction of the page at a scroll offset; gaps belong half to each page', () => {
  const L = column(5, 400, 1000);
  assert.deepEqual(pageAt(L, 8), { page: 0, fy: 0, gap: 0 });
  assert.deepEqual(pageAt(L, 0), { page: 0, fy: 0, gap: -8 });
  assert.deepEqual(pageAt(L, 2 * 1016 + 8 + 500), { page: 2, fy: 0.5, gap: 0 });
  // Scrolled to a page the way the viewer does (8 px above its top): that page, not the one before.
  assert.deepEqual(pageAt(L, 2 * 1016), { page: 2, fy: 0, gap: -8 });
  assert.deepEqual(pageAt(L, 1016 + 8 + 1000 + 4), { page: 1, fy: 1, gap: 4 });
});

test('syncScroll: the same page at the same fraction, across different page sizes', () => {
  const a4 = { ...column(5, 794, 1123), scrollTop: 0, scrollLeft: 0 };
  const a3 = column(4, 1123, 1588);
  a4.scrollTop = a4.tops[2] + 0.5 * a4.heights[2];
  const r = syncScroll(a4, a3);
  assert.equal(r.page, 2);
  assert.equal(r.top, a3.tops[2] + 0.5 * a3.heights[2]);
  // The viewer's go-to-page offset maps to the same offset above the other page.
  a4.scrollTop = a4.tops[3] - 8;
  assert.equal(syncScroll(a4, a3).top, a3.tops[3] - 8);
});

test('syncScroll: a page past the other document\'s last page clamps to the end of its last page', () => {
  const five = { ...column(5, 400, 1000), scrollTop: 0, scrollLeft: 0 };
  const four = column(4, 500, 1200);
  five.scrollTop = five.tops[4] + 300;
  const r = syncScroll(five, four);
  assert.equal(r.page, 3);
  assert.equal(r.top, four.tops[3] + four.heights[3]);
});

test('syncScroll: horizontal position by fraction of the page width at the pane centre', () => {
  const src = { ...column(3, 1200, 1600, 600), scrollTop: 8, scrollLeft: 0 };
  const dst = column(3, 1800, 2400, 500);
  src.scrollLeft = src.lefts[0] + 0.25 * 1200 - 300; // the pane centre at a quarter of the page width
  const r = syncScroll(src, dst);
  assert.equal(r.left, dst.lefts[0] + 0.25 * 1800 - 250);
  // A page narrower than the pane (centred, no horizontal scroll): the other pane centres its page.
  const narrow = { ...column(3, 400, 600, 600), scrollTop: 8, scrollLeft: 0 };
  assert.equal(syncScroll(narrow, dst).left, dst.lefts[0] + 0.5 * 1800 - 250);
  // Never a negative offset.
  assert.equal(syncScroll({ ...column(3, 1800, 2400, 500), scrollTop: 8, scrollLeft: 0 }, column(3, 400, 600, 600)).left, 0);
});

test('topFor and zoomToSync', () => {
  assert.equal(topFor({ page: 1, fy: 0.25, gap: 0 }, column(2, 100, 400)), 8 + 416 + 100);
  assert.equal(topFor({ page: 0, fy: 0, gap: 0 }, { tops: [], heights: [] }), 0);
  assert.equal(zoomToSync({ zoomMode: 'custom', zoom: 1.5 }), 1.5);
  assert.equal(zoomToSync({ zoomMode: 'fit-width', zoom: 0.83 }), 'fit-width');
});
