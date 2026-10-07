import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentText, toEntries, filterEntries, groupByPage, distinct, csvCell, toCsv } from '../renderer/ui/comments-lib.js';

const objs = [
  { id: 'a', type: 'rect', page: 1, note: 'Clash', author: 'Ahmad', modified: '2026-10-01T08:00:00.000Z', status: 'accepted', replies: [{ id: 'r1', author: 'Lee', date: null, text: 'Fixed' }] },
  { id: 'b', type: 'text', page: 0, text: 'Box text' },
  { id: 'c', type: 'note', page: 1, note: 'Check size', author: 'Lee', created: '2026-09-30T08:00:00.000Z' },
  { id: 'd', type: 'stamp', page: 0, text: 'APPROVED' },
];

test('commentText: comment, text box text, stamp text', () => {
  assert.equal(commentText(objs[0]), 'Clash');
  assert.equal(commentText(objs[1]), 'Box text');
  assert.equal(commentText(objs[3]), 'APPROVED');
  assert.equal(commentText({ type: 'ink' }), '');
});

test('toEntries fills author, date, status and copies replies', () => {
  const e = toEntries(objs, 'Me');
  assert.deepEqual(e.map((x) => [x.author, x.date, x.status, x.replies.length]), [
    ['Ahmad', '2026-10-01T08:00:00.000Z', 'accepted', 1], ['Me', null, 'none', 0], ['Lee', '2026-09-30T08:00:00.000Z', 'none', 0], ['Me', null, 'none', 0]]);
});

test('groupByPage orders pages and keeps document order', () => {
  assert.deepEqual(groupByPage(toEntries(objs)).map((g) => [g.page, g.items.map((x) => x.id)]), [[0, ['b', 'd']], [1, ['a', 'c']]]);
});

test('filterEntries by type, author and status', () => {
  const e = toEntries(objs, 'Me');
  assert.deepEqual(filterEntries(e, { status: 'accepted' }).map((x) => x.id), ['a']);
  assert.deepEqual(filterEntries(e, { status: 'none', author: 'Me' }).map((x) => x.id), ['b', 'd']);
  assert.deepEqual(filterEntries(e, { type: 'note' }).map((x) => x.id), ['c']);
  assert.deepEqual(filterEntries(e, {}).length, 4);
  assert.deepEqual(distinct(e, 'author'), ['Ahmad', 'Lee', 'Me']);
});

test('csvCell: quoting and formula-safe prefix', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('=1,2'), `"'=1,2"`);
});

test('toCsv: BOM, header, rows with joined replies', () => {
  const csv = toCsv(toEntries([objs[0], { id: 'e', type: 'note', page: 2, note: '=HYPERLINK("x")', replies: [{ author: 'A', text: 'one' }, { author: 'B', text: 'two' }] }], 'Me'));
  assert.equal(csv, '﻿page,type,author,date,status,comment,replies\r\n'
    + '2,Rectangle,Ahmad,2026-10-01T08:00:00.000Z,Accepted,Clash,Lee: Fixed\r\n'
    + `3,Sticky note,Me,,None,"'=HYPERLINK(""x"")",A: one | B: two\r\n`);
});
