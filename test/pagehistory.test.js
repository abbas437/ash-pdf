import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invertMap, droppedBy, restoreDropped, takeObjects, swapObjs } from '../renderer/ui/pagehistory-lib.js';

const del3 = new Map([[0, 0], [1, 1], [2, null], [3, 2]]); // delete page 3 of 4

test('invertMap: deleted pages come back unmapped, inserted pages map to null', () => {
  assert.deepEqual([...invertMap(del3, 3)], [[0, 0], [1, 1], [2, 3]]);
  const insert = new Map([[0, 0], [1, 2]]); // a page inserted at 1
  assert.deepEqual([...invertMap(insert, 3)], [[0, 0], [1, null], [2, 1]]);
});

test('droppedBy: deep copies of the objects on removed pages, with their index', () => {
  const objs = [{ id: 'a', page: 0 }, { id: 'b', page: 2, pts: [[1, 2]] }, { id: 'c', page: 3 }, { id: 'd', page: 2 }];
  const items = droppedBy(objs, del3);
  assert.deepEqual(items, [{ obj: { id: 'b', page: 2, pts: [[1, 2]] }, index: 1 }, { obj: { id: 'd', page: 2 }, index: 3 }]);
  assert.notEqual(items[0].obj, objs[1]);
  assert.notEqual(items[0].obj.pts, objs[1].pts);
  assert.deepEqual(droppedBy(objs, new Map([[0, 0]])), [], 'pages the map does not mention are kept');
});

test('restoreDropped: same ids at their former stacking position; present ids not duplicated', () => {
  const objs = [{ id: 'a', page: 0 }, { id: 'b', page: 2 }, { id: 'c', page: 3 }, { id: 'd', page: 2 }];
  const items = droppedBy(objs, del3);
  const kept = [{ id: 'a', page: 0 }, { id: 'c', page: 3 }];
  const back = restoreDropped(kept, items);
  assert.deepEqual(back.map((o) => o.id), ['a', 'b', 'c', 'd']);
  assert.notEqual(back[1], items[0].obj, 'copies, so a later drop/restore cycle does not share state');
  assert.deepEqual(restoreDropped(back, items).map((o) => o.id), ['a', 'b', 'c', 'd']);
  assert.equal(kept.length, 2, 'input not mutated');
});

test('undo/redo round trip: a delete, its undo and its redo keep the dropped objects', () => {
  let objs = [{ id: 'r', page: 2 }, { id: 'n', page: 3 }];
  const apply = (list, map) => list.filter((o) => map.get(o.page) !== null).map((o) => ({ ...o, page: map.has(o.page) ? map.get(o.page) : o.page }));
  const opDropped = droppedBy(objs, del3);
  objs = apply(objs, del3);
  assert.deepEqual(objs, [{ id: 'n', page: 2 }]);
  const inv = invertMap(del3, 3); // undo
  const undoDropped = droppedBy(objs, inv);
  objs = restoreDropped(apply(objs, inv), opDropped);
  assert.deepEqual(objs, [{ id: 'r', page: 2 }, { id: 'n', page: 3 }]);
  const redoMap = invertMap(inv, 4); // redo: the inverse of the undo map is the op's map
  assert.deepEqual([...redoMap], [...del3]);
  const redoDropped = droppedBy(objs, redoMap);
  objs = restoreDropped(apply(objs, redoMap), undoDropped);
  assert.deepEqual(objs, [{ id: 'n', page: 2 }]);
  objs = restoreDropped(apply(objs, invertMap(redoMap, 3)), redoDropped); // undo again
  assert.deepEqual(objs, [{ id: 'r', page: 2 }, { id: 'n', page: 3 }]);
});

test('takeObjects + swapObjs: an apply removes, its undo restores, its redo removes the same ids again', () => {
  const objs = [{ id: 'a', page: 0 }, { id: 'm1', page: 0, type: 'redactMark' }, { id: 'b', page: 1 }, { id: 'm2', page: 1, type: 'redactMark' }];
  // apply: res.remove = marks
  const t = takeObjects(objs, ['m1', 'm2']);
  assert.deepEqual(t.objects.map((o) => o.id), ['a', 'b']);
  assert.deepEqual(t.items.map((it) => [it.obj.id, it.index]), [['m1', 1], ['m2', 3]]);
  t.items[0].obj.page = 9;
  assert.equal(objs[1].page, 0, 'items are copies');
  t.items[0].obj.page = 0;
  const undoEntry = { restore: t.items, remove: [] };
  // undo: nothing to take, the marks come back in place
  const u = takeObjects(t.objects, undoEntry.remove);
  const afterUndo = restoreDropped(u.objects, undoEntry.restore);
  assert.deepEqual(afterUndo.map((o) => o.id), ['a', 'm1', 'b', 'm2']);
  const redoEntry = swapObjs(undoEntry, u.items);
  assert.deepEqual(redoEntry, { restore: [], remove: ['m1', 'm2'] });
  // redo: the marks go again; the next undo brings them back
  const r = takeObjects(afterUndo, redoEntry.remove);
  assert.deepEqual(restoreDropped(r.objects, redoEntry.restore).map((o) => o.id), ['a', 'b']);
  const undo2 = swapObjs(redoEntry, r.items);
  assert.deepEqual(undo2.remove, []);
  assert.deepEqual(restoreDropped(r.objects, undo2.restore).map((o) => o.id), ['a', 'm1', 'b', 'm2']);
});
