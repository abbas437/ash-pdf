import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GROUPS, defaultLayout, cleanLayout, placement, setHidden, setGroupShown, moveItem, moveToGroup, moveGroup,
  setCompact, setAllCompact, compactMode,
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
