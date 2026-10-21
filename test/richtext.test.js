import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStyleToRange, insertText, deleteRange, normalizeRuns, styleAt, runsOf } from '../src/core/richtext.js';

const box = { type: 'text', text: 'one two three', font: 'Helvetica', fontSize: 12, color: '#000000' };
const joined = (r) => r.runs.map((x) => x.text).join('');

test('applyStyleToRange splits runs and keeps text', () => {
  const r = applyStyleToRange(box, 4, 7, { bold: true, color: '#FF0000' });
  assert.equal(r.text, box.text);
  assert.deepEqual(r.runs, [{ text: 'one ' }, { text: 'two', bold: true, color: '#ff0000' }, { text: ' three' }]);
  assert.equal(joined(r), box.text);
});

test('applyStyleToRange merges equal neighbours and over a run boundary', () => {
  const a = { ...box, ...applyStyleToRange(box, 0, 3, { italic: true }) };
  const b = applyStyleToRange(a, 3, 7, { italic: true });
  assert.deepEqual(b.runs, [{ text: 'one two', italic: true }, { text: ' three' }]);
  const c = applyStyleToRange({ ...a, ...b }, 2, 5, { underline: true });
  assert.deepEqual(c.runs, [{ text: 'on', italic: true }, { text: 'e t', italic: true, underline: true }, { text: 'wo', italic: true }, { text: ' three' }]);
});

test('a patch value equal to the box style removes the override; a uniform result has no runs', () => {
  const a = { ...box, ...applyStyleToRange(box, 4, 7, { fontSize: 20, color: '#00f' }) };
  const b = applyStyleToRange(a, 0, 13, { fontSize: 12, color: '#000000' });
  assert.equal(b.runs, undefined);
  const c = applyStyleToRange({ ...box, bold: true }, 0, 3, { bold: true });
  assert.equal(c.runs, undefined, 'bold on a bold box is no override');
  const d = applyStyleToRange(a, 4, 5, { fontSize: null });
  assert.deepEqual(d.runs, [{ text: 'one ' }, { text: 't', color: '#00f' }, { text: 'wo', fontSize: 20, color: '#00f' }, { text: ' three' }]);
});

test('insertText takes the style of the character before, or a given style', () => {
  const a = { ...box, ...applyStyleToRange(box, 4, 7, { bold: true }) };
  const b = insertText(a, 7, 'XY');
  assert.equal(b.text, 'one twoXY three');
  assert.deepEqual(b.runs, [{ text: 'one ' }, { text: 'twoXY', bold: true }, { text: ' three' }]);
  const c = insertText(a, 4, 'Z');
  assert.deepEqual(c.runs, [{ text: 'one Z' }, { text: 'two', bold: true }, { text: ' three' }], 'before = the space, plain');
  const d = insertText(a, 0, 'Q', { strike: true });
  assert.deepEqual(d.runs[0], { text: 'Q', strike: true });
  assert.equal(joined(d), d.text);
  const e = insertText({ ...box, text: '' }, 0, 'hi');
  assert.deepEqual(e, { text: 'hi', runs: undefined });
  assert.equal(insertText({ ...box, ...applyStyleToRange(box, 0, 3, { color: '#f00' }) }, 0, 'A').runs[0].text, 'Aone', 'at 0: first character style');
});

test('deleteRange keeps runs consistent and drops emptied runs', () => {
  const a = { ...box, ...applyStyleToRange(box, 4, 7, { bold: true }) };
  const b = deleteRange(a, 3, 8);
  assert.equal(b.text, 'onethree');
  assert.equal(b.runs, undefined, 'the bold run went entirely: uniform');
  const c = deleteRange(a, 5, 9);
  assert.deepEqual(c.runs, [{ text: 'one ' }, { text: 't', bold: true }, { text: 'hree' }]);
  assert.equal(joined(c), c.text);
});

test('runsOf ignores runs that do not add up to the text; styleAt and normalizeRuns', () => {
  assert.deepEqual(runsOf({ text: 'ab', runs: [{ text: 'a' }] }), [{ text: 'ab' }]);
  const a = { ...box, ...applyStyleToRange(box, 4, 7, { fontSize: 18 }) };
  assert.equal(styleAt(a, 5).fontSize, 18);
  assert.equal(styleAt(a, 0).fontSize, 12);
  assert.deepEqual(normalizeRuns([{ text: 'a', bold: false }, { text: '' }, { text: 'b', color: '#000000' }], box), undefined);
});
