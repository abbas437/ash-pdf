import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, stem, joinItems, toCsv, loadIndex, saveIndex, updateIndex, searchIndex, searchPages, searchDoc } from '../renderer/ui/advsearch-engine.js';

const found = (text, q, o) => compile(q, o)(text).map((m) => text.slice(m.start, m.end));

test('exact phrase matches across whitespace, case-insensitive by default', () => {
  assert.deepEqual(found('The Pump Station\nand pump  station B', 'pump station', {}), ['Pump Station', 'pump  station']);
});

test('case-sensitive', () => {
  assert.deepEqual(found('Pump pump PUMP', 'pump', { caseSensitive: true }), ['pump']);
});

test('whole words excludes partial words', () => {
  assert.deepEqual(found('pumping pump pumps', 'pump', {}), ['pump', 'pump', 'pump']);
  assert.deepEqual(found('pumping pump pumps', 'pump', { wholeWords: true }), ['pump']);
});

test('all words requires every word; any words takes either', () => {
  assert.deepEqual(found('alpha beta gamma', 'gamma alpha', { mode: 'all' }), ['alpha', 'gamma']);
  assert.deepEqual(found('alpha beta', 'gamma alpha', { mode: 'all' }), []);
  assert.deepEqual(found('alpha beta', 'gamma alpha', { mode: 'any' }), ['alpha']);
});

test('proximity keeps only windows where all words are within N words', () => {
  const text = 'valve one two three four five six pressure, then many other words here. valve and pressure';
  assert.deepEqual(found(text, 'valve pressure', { mode: 'all', proximity: 3 }), ['valve and pressure']);
  assert.equal(found(text, 'valve pressure', { mode: 'all', proximity: 10 })[0], 'valve one two three four five six pressure');
});

test('stemming matches word forms', () => {
  assert.equal(stem('hoping'), stem('hope'));
  assert.equal(stem('connection'), stem('connected'));
  assert.equal(stem('studies'), stem('study'));
  assert.equal(stem('running'), stem('runs'));
  assert.deepEqual(found('He hoped; she hopes; hopeless', 'hope', { stemming: true }), ['hoped', 'hopes']);
  assert.deepEqual(found('the connected pumps', 'connection pump', { stemming: true }), ['connected pumps']);
});

test('regular expression and custom pattern', () => {
  assert.deepEqual(found('ID A-12, B-7 and C-x', '[A-C]-\\d+', { regex: true }), ['A-12', 'B-7']);
  assert.deepEqual(found('ID A-12, B-7', '', { pattern: 'custom', customPattern: 'B-\\d' }), ['B-7']);
  assert.throws(() => compile('(', { regex: true }));
});

test('built-in patterns', () => {
  const t = 'Mail a.b@ex-ample.com or see https://x.org/p?q=1. Call +966 12 345 6789 or (555) 123-4567 '
    + 'on 2026-10-07, 7 October 2026 or Oct 7, 2026; pay $1,250.50 or 300 SAR.';
  assert.deepEqual(found(t, '', { pattern: 'email' }), ['a.b@ex-ample.com']);
  assert.deepEqual(found(t, '', { pattern: 'url' }), ['https://x.org/p?q=1']);
  assert.deepEqual(found(t, '', { pattern: 'phone' }), ['+966 12 345 6789', '(555) 123-4567']);
  assert.deepEqual(found(t, '', { pattern: 'date' }), ['2026-10-07', '7 October 2026', 'Oct 7, 2026']);
  assert.deepEqual(found(t, '', { pattern: 'amount' }), ['$1,250.50', '300 SAR']);
});

test('joinItems separates lines and gapped items, keeps split words together', () => {
  const it = (str, x, y, width, extra = {}) => ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10, ...extra });
  assert.equal(joinItems([it('Hel', 0, 100, 15), it('lo', 15, 100, 10), it('world', 40, 100, 25), it('next', 0, 80, 20)]), 'Hello world\nnext');
  assert.equal(joinItems([it('a', 0, 100, 5, { hasEOL: true }), it('b', 0, 100, 5)]), 'a\nb');
});

test('CSV export escapes and guards formulas', () => {
  const csv = toCsv([{ name: 'a.pdf', path: '/d/a.pdf', hits: [{ page: 1, snippet: { before: '=x, ', match: '"q"', after: '' } }] }]);
  assert.equal(csv, '﻿file,path,page,snippet\r\na.pdf,/d/a.pdf,2,"\'=x, ""q"""\r\n');
});

test('index updates incrementally and returns the same hits as a live search', async () => {
  const docs = { '/f/a.pdf': ['pump station one', 'nothing'], '/f/b.pdf': ['other pumps'] };
  const list = Object.keys(docs).map((path) => ({ path, name: path.slice(3), size: 1, mtimeMs: 1 }));
  const extracted = [];
  const extract = async (f) => { extracted.push(f.path); return { pages: docs[f.path], annots: null, bookmarks: null }; };
  let idx = loadIndex('');
  assert.equal(await updateIndex(idx, list, extract), 2);
  idx = loadIndex(saveIndex(idx));
  assert.equal(await updateIndex(idx, list, extract), 0);
  list[1].mtimeMs = 2; docs['/f/b.pdf'] = ['pump here'];
  assert.equal(await updateIndex(idx, list, extract), 1);
  for (const o of [{ wholeWords: true }, { stemming: true }, {}]) {
    const live = Object.entries(docs).map(([path, pages]) => ({ path, hits: searchPages(pages, compile('pump', o)) })).filter((r) => r.hits.length);
    assert.deepEqual(searchIndex(idx, 'pump', o).map((r) => ({ path: r.path, hits: r.hits })), live);
  }
  assert.deepEqual(extracted, ['/f/a.pdf', '/f/b.pdf', '/f/b.pdf']);
});

test('annotation contents and bookmarks are searched only when asked', () => {
  const doc = { pages: ['body text', 'more'], annots: ['', 'check the pump'], bookmarks: [{ title: 'Pump schedule', page: 1 }, { title: 'pump (no dest)', page: null }] };
  const m = compile('pump', {});
  assert.deepEqual(searchDoc(doc, m, {}), []);
  assert.deepEqual(searchDoc(doc, m, { annotations: true, bookmarks: true }).map((x) => [x.page, x.kind, x.snippet.match]),
    [[0, 'bookmark', 'pump'], [1, 'annotation', 'pump'], [1, 'bookmark', 'Pump']]);
});
