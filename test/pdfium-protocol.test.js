import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeResponse, encodeError, encodeRequest, encodeResult, transferList } from '../renderer/pdfium/protocol.js';

test('transferList finds Uint8Array buffers at the top level and one level down, once each', () => {
  const a = new Uint8Array([1, 2]), b = new Uint8Array(3);
  assert.deepEqual(transferList(a), [a.buffer]);
  assert.deepEqual(transferList([1, a, 'x', b]), [a.buffer, b.buffer]);
  assert.deepEqual(transferList({ bytes: a, n: 1 }), [a.buffer]);
  const view = new Uint8Array(a.buffer, 1); // two views of one buffer -> transferred once
  assert.deepEqual(transferList([a, view]), [a.buffer]);
  assert.deepEqual(transferList({ deep: { bytes: a } }), []); // deeper nesting is not searched
  for (const v of [null, undefined, 3, 'str', [], {}]) assert.deepEqual(transferList(v), []);
});

test('transferList skips views over a SharedArrayBuffer (not transferable)', () => {
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  assert.deepEqual(transferList([shared]), []);
});

test('encodeRequest builds { id, method, args } and transfers byte arguments', () => {
  const bytes = new Uint8Array([9]);
  const { msg, transfer } = encodeRequest(7, 'open', [bytes]);
  assert.deepEqual(msg, { id: 7, method: 'open', args: [bytes] });
  assert.deepEqual(transfer, [bytes.buffer]);
  assert.deepEqual(encodeRequest(8, 'pageCount'), { msg: { id: 8, method: 'pageCount', args: [] }, transfer: [] });
});

test('encodeResult wraps the result as ok and transfers a byte result', () => {
  const out = new Uint8Array([1, 2, 3]);
  assert.deepEqual(encodeResult(3, out), { msg: { id: 3, ok: true, result: out }, transfer: [out.buffer] });
  assert.deepEqual(encodeResult(4, 2), { msg: { id: 4, ok: true, result: 2 }, transfer: [] });
});

test('encodeError carries name and message, for Errors and thrown non-Errors', () => {
  const e = new TypeError('bad arg');
  assert.deepEqual(encodeError(5, e), { msg: { id: 5, ok: false, error: { name: 'TypeError', message: 'bad arg' } }, transfer: [] });
  assert.deepEqual(encodeError(6, 'plain').msg.error, { name: 'Error', message: 'plain' });
  assert.deepEqual(encodeError(7, undefined).msg.error, { name: 'Error', message: 'undefined' });
});

test('decodeResponse returns the result, or throws an Error with the worker name and message', () => {
  assert.equal(decodeResponse({ id: 1, ok: true, result: 42 }), 42);
  assert.equal(decodeResponse({ id: 1, ok: true, result: undefined }), undefined);
  assert.throws(() => decodeResponse(encodeError(2, new RangeError('page 9 out of range')).msg),
    (err) => err instanceof Error && err.name === 'RangeError' && err.message === 'page 9 out of range');
  assert.throws(() => decodeResponse({ id: 3, ok: false }), (err) => err.name === 'Error' && err.message === 'pdfium: unknown error');
});
