// EXIF Orientation of a JPEG (renderer/ui/exif-lib.js): hand-built minimal headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jpegOrientation } from '../renderer/ui/exif-lib.js';

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const seg = (marker, body) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
/** APP1 Exif with one IFD0 entry: Orientation (0x0112, SHORT) = v. */
function app1(v, le = false) {
  const u16 = (n) => (le ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n) => (le ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(v), 0, 0, ...u32(0)];
  return seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
}
const jfif = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const jpeg = (...parts) => new Uint8Array([...SOI, ...parts.flat(), ...EOI]);

test('jpegOrientation reads the Orientation tag of the APP1 Exif segment (big- and little-endian, after APP0)', () => {
  assert.equal(jpegOrientation(jpeg(app1(6))), 6);
  assert.equal(jpegOrientation(jpeg(app1(8, true))), 8);
  assert.equal(jpegOrientation(jpeg(jfif, app1(3))), 3);
  assert.equal(jpegOrientation(jpeg(app1(1))), 1);
});

test('jpegOrientation is 1 without APP1, for an invalid value, a truncated segment or non-JPEG bytes', () => {
  assert.equal(jpegOrientation(jpeg(jfif)), 1);
  assert.equal(jpegOrientation(jpeg(app1(9))), 1);
  assert.equal(jpegOrientation(new Uint8Array([...SOI, ...app1(6).slice(0, 14)])), 1);
  assert.equal(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 1);
  assert.equal(jpegOrientation(new Uint8Array()), 1);
});
