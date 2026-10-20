import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { dialogDefaultPath } from '../electron/dialogPaths.js';

const LAST = resolve('/docs/reports');
const exists = (p) => p === LAST;
const gone = () => false;

test('no request: the dialog starts in the remembered folder', () => {
  assert.equal(dialogDefaultPath(LAST, undefined, exists), LAST);
  assert.equal(dialogDefaultPath(LAST, '', exists), LAST);
});

test('a bare file name is put in the remembered folder', () => {
  assert.equal(dialogDefaultPath(LAST, 'report-reduced.pdf', exists), join(LAST, 'report-reduced.pdf'));
});

test('a path with a folder part is kept as is', () => {
  const own = resolve('/elsewhere/report.pdf');
  assert.equal(dialogDefaultPath(LAST, own, exists), own);
  assert.equal(dialogDefaultPath(undefined, own, exists), own);
});

test('a remembered folder that no longer exists falls back to the OS default', () => {
  assert.equal(dialogDefaultPath(LAST, undefined, gone), undefined);
  assert.equal(dialogDefaultPath(LAST, 'a.pdf', gone), 'a.pdf');
});

test('nothing remembered, or a malformed value from settings.json: request unchanged', () => {
  for (const bad of [undefined, null, '', 'relative/dir', 42, {}, ['/x']]) {
    assert.equal(dialogDefaultPath(bad, undefined, () => true), undefined, String(bad));
    assert.equal(dialogDefaultPath(bad, 'a.pdf', () => true), 'a.pdf', String(bad));
  }
});
