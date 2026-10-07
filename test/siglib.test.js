import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptBytes, decryptBytes, removeBackground, formatDate, targetPages, PBKDF2_ITERATIONS, WrongPasswordError } from '../src/core/siglib.js';

test('encrypt/decrypt round trip with PBKDF2 310k + AES-GCM, random salt/iv', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const a = await encryptBytes(png, 'correct horse');
  const b = await encryptBytes(png, 'correct horse');
  assert.equal(a.lock.iter, PBKDF2_ITERATIONS);
  assert.equal(PBKDF2_ITERATIONS, 310000);
  assert.notEqual(a.lock.salt, b.lock.salt);
  assert.notEqual(a.lock.iv, b.lock.iv);
  assert.notDeepEqual(a.data.slice(0, png.length), png);
  assert.deepEqual(await decryptBytes(a.lock, a.data, 'correct horse'), png);
});

test('decrypt with a wrong password is rejected', async () => {
  const { lock, data } = await encryptBytes(Uint8Array.from([1, 2, 3]), 'right');
  await assert.rejects(decryptBytes(lock, data, 'wrong'), WrongPasswordError);
  await assert.rejects(decryptBytes(lock, data, ''), /Wrong password/);
});

test('removeBackground clears near-white pixels and returns the ink box', () => {
  const W = 5, H = 4, px = new Uint8ClampedArray(W * H * 4).fill(255); // white, opaque
  const set = (x, y, v) => { const k = (y * W + x) * 4; px[k] = px[k + 1] = px[k + 2] = v; };
  set(1, 1, 10); set(3, 2, 30);   // ink
  set(0, 3, 235);                 // light grey paper: above threshold -> background
  set(4, 0, 190);                 // in the soft band below the threshold: partly transparent
  const box = removeBackground(px, W, H, 200, 24);
  const alpha = (x, y) => px[(y * W + x) * 4 + 3];
  assert.equal(alpha(0, 0), 0);
  assert.equal(alpha(0, 3), 0);
  assert.equal(alpha(1, 1), 255);
  assert.equal(alpha(3, 2), 255);
  assert.ok(alpha(4, 0) > 0 && alpha(4, 0) < 255);
  assert.deepEqual(box, { x: 1, y: 0, w: 4, h: 3 });
  assert.equal(removeBackground(new Uint8ClampedArray(16).fill(255), 2, 2), null);
});

test('formatDate and targetPages', () => {
  assert.equal(formatDate('2026-10-07', 'YYYY-MM-DD'), '2026-10-07');
  assert.equal(formatDate('2026-10-07', 'DD/MM/YYYY'), '07/10/2026');
  assert.equal(formatDate('2026-10-07', 'MM/DD/YYYY'), '10/07/2026');
  assert.equal(formatDate('2026-10-07', 'D MMMM YYYY'), '7 October 2026');
  assert.deepEqual(targetPages('odd', 5), [0, 2, 4]);
  assert.deepEqual(targetPages('even', 5), [1, 3]);
  assert.deepEqual(targetPages('all', 3), [0, 1, 2]);
  assert.deepEqual(targetPages('range', 5, [1, 2]), [1, 2]);
});
