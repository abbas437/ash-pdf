import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GROUPS, defaultLayout, cleanLayout, placement, setHidden, setGroupShown, moveItem, moveToGroup, moveGroup,
  setCompact, setAllCompact, compactMode, canFold, canHide,
} from '../renderer/ui/toolbar-layout.js';

test('defaults: every group in order, nothing hidden or compact', () => {
  const d = defaultLayout();
  assert.deepEqual(d.groupOrder, ['navigate', 'pages', 'view', 'edit', 'comment', 'sign']);
  assert.deepEqual(d.order.navigate, ['select', 'hand']);
  assert.deepEqual(d.order.sign, ['stamp', 'sign']);
  assert.deepEqual(d.hidden, []);
  assert.deepEqual(d.compact, []);
  assert.deepEqual(cleanLayout(d), d);
  assert.equal(compactMode(d), 'expanded');
});

test('hidden, reorder, move to another group and group order are kept', () => {
  let l = defaultLayout();
  l = setHidden(l, 'squiggly', true);
  l = moveToGroup(l, 'stamp', 'pages');
  l = moveItem(l, 'stamp', -1);
  l = moveItem(l, 'hand', -1);
  l = moveGroup(l, 'comment', -1);
  l = setCompact(l, 'comment', true);
  const back = cleanLayout(JSON.stringify(l));
  assert.deepEqual(back.hidden, ['squiggly']);
  assert.deepEqual(back.order.pages, ['stamp', 'pages']);
  assert.deepEqual(back.order.sign, ['sign']);
  assert.deepEqual(back.order.navigate, ['hand', 'select']);
  assert.deepEqual(back.groupOrder, ['navigate', 'pages', 'view', 'comment', 'edit', 'sign']);
  assert.deepEqual(back.compact, ['comment']);
  assert.deepEqual(placement(back, 'stamp'), { group: 'pages', index: 0 });
});

test('moves past the ends do nothing; the input layout is never changed', () => {
  const d = defaultLayout();
  assert.deepEqual(moveItem(d, 'select', -1), d);
  assert.deepEqual(moveItem(d, 'shapes', 1), d);
  assert.deepEqual(moveGroup(d, 'navigate', -1), d);
  assert.deepEqual(moveGroup(d, 'sign', 1), d);
  setHidden(d, 'hand', true);
  assert.deepEqual(d, defaultLayout());
});

test('unknown ids and groups are dropped, duplicates placed once', () => {
  const l = cleanLayout({
    groupOrder: ['bogus', 'sign', 'navigate'],
    order: { navigate: ['hand', 'nope', 'select', 'hand'], sign: ['sign', 'stamp', 'highlight'], bogus: ['text'] },
    hidden: ['nope', 'draw', 'draw', 42],
    compact: ['comment', 'bogus'],
  });
  assert.equal(l.groupOrder[0], 'sign');
  assert.ok(!l.groupOrder.includes('bogus'));
  assert.deepEqual(l.order.navigate, ['hand', 'select']);
  assert.deepEqual(l.order.sign, ['sign', 'stamp', 'highlight']);
  assert.ok(!l.order.comment.includes('highlight'));
  assert.equal(l.order.edit[0], 'text'); // only listed under the dropped group: back to its default place
  assert.deepEqual(l.hidden, ['draw']);
  assert.deepEqual(l.compact, ['comment']);
  assert.equal(Object.values(l.order).flat().length, DEFAULT_GROUPS.flatMap((g) => g[2]).length);
});

test('a tool new in a later version appears in its default place', () => {
  // A layout saved before 'squiggly' and the View group existed.
  const old = defaultLayout();
  old.order.comment = old.order.comment.filter((id) => id !== 'squiggly').reverse();
  old.groupOrder = old.groupOrder.filter((g) => g !== 'view');
  delete old.order.view;
  const l = cleanLayout(old);
  assert.deepEqual(l.groupOrder, ['navigate', 'pages', 'view', 'edit', 'comment', 'sign']);
  assert.deepEqual(l.order.view, ['split']);
  // Reversed order is kept; squiggly goes after strikeout (its default predecessor).
  const c = l.order.comment;
  assert.equal(c.indexOf('squiggly'), c.indexOf('strikeout') + 1);
  assert.equal(c[0], 'shapes');
});

test('Select can never be hidden', () => {
  assert.deepEqual(setHidden(defaultLayout(), 'select', true).hidden, []);
  assert.deepEqual(setGroupShown(defaultLayout(), 'navigate', false).hidden, ['hand']);
  assert.deepEqual(cleanLayout({ hidden: ['select', 'hand'] }).hidden, ['hand']);
});

test('bad stored values give the default layout', () => {
  for (const bad of ['{not json', 'null', '[1,2]', 7, null, undefined, [], 'true']) assert.deepEqual(cleanLayout(bad), defaultLayout(), String(bad));
  assert.deepEqual(cleanLayout({ order: 'x', hidden: 'squiggly', compact: {} }), defaultLayout());
});

test('global Compact folds every group except Navigate', () => {
  const c = setAllCompact(defaultLayout(), true);
  assert.ok(!c.compact.includes('navigate') && c.compact.includes('comment'));
  assert.equal(compactMode(c), 'compact');
  assert.equal(compactMode(setCompact(c, 'edit', false)), 'custom');
  assert.equal(compactMode(setAllCompact(c, false)), 'expanded');
});

test('cleanLayout ignores prototype keys, huge arrays and wrongly typed fields', () => {
  const polluted = JSON.parse('{"__proto__":{"polluted":1},"order":{"__proto__":["hand"],"constructor":["text"],"edit":["__proto__","toString"]},"groupOrder":["__proto__","constructor","edit"],"hidden":["__proto__","hand"],"compact":["__proto__","edit"]}');
  const l = cleanLayout(polluted);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(l.groupOrder, ['navigate', 'pages', 'view', 'edit', 'comment', 'sign']);
  assert.deepEqual(Object.keys(l.order).sort(), [...defaultLayout().groupOrder].sort());
  assert.deepEqual(l.hidden, ['hand']);
  assert.deepEqual(l.compact, ['edit']);
  assert.deepEqual(l.order, defaultLayout().order);
});

test('cleanLayout copes with a 100k-entry array', () => {
  const big = Array.from({ length: 100_000 }, (_, i) => (i % 2 ? 'hand' : `x${i}`));
  const t0 = Date.now();
  const l = cleanLayout({ groupOrder: big, hidden: big, compact: big, order: { navigate: big } });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(l.hidden, ['hand']);
  assert.deepEqual(l.groupOrder, defaultLayout().groupOrder);
  assert.deepEqual(l.order.navigate, ['select', 'hand']);
});

test('cleanLayout: order and hidden of the wrong type are ignored', () => {
  for (const bad of [5, 'edit', true, [], [['a']], { navigate: 'hand', edit: { 0: 'text' }, comment: 7 }]) {
    assert.deepEqual(cleanLayout({ order: bad }).order, defaultLayout().order, JSON.stringify(bad));
  }
  for (const bad of [5, 'hand', {}, null, [1, null, {}]]) assert.deepEqual(cleanLayout({ hidden: bad }).hidden, [], JSON.stringify(bad));
  assert.deepEqual(cleanLayout({ hidden: ['hand', 3, null] }).hidden, ['hand']);
});

test('groups with a single tool button cannot fold and do not count for the Compact mode', () => {
  const d = defaultLayout();
  assert.deepEqual(['navigate', 'pages', 'view', 'edit', 'comment', 'sign'].map((g) => canFold(d, g)), [true, false, false, true, true, false]);
  const c = setAllCompact(d, true);
  assert.equal(compactMode(c), 'compact');
  // Compact ticked on a group that cannot fold is neither on nor off.
  assert.equal(compactMode(setCompact(setAllCompact(d, false), 'pages', true)), 'expanded');
  assert.equal(compactMode(setCompact(c, 'pages', false)), 'compact');
  assert.equal(compactMode(setCompact(c, 'sign', false)), 'compact');
  // Moving Stamp into Edit leaves Sign with one button; Edit still folds.
  assert.equal(canFold(moveToGroup(d, 'stamp', 'edit'), 'sign'), false);
  assert.equal(canFold(moveToGroup(d, 'select', 'sign'), 'sign'), true);
});

test('ids no group lists cannot be hidden', () => {
  assert.equal(canHide('hand'), true);
  assert.equal(canHide('select'), false);
  assert.equal(canHide('plugin-tool'), false);
  assert.deepEqual(setHidden(defaultLayout(), 'plugin-tool', true).hidden, []);
});
