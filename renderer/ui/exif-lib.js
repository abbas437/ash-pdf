// Pure helper: the EXIF Orientation of a JPEG (renderer/ui/tools-text.js preparePicture). Browsers
// honour it when they decode the picture; pdf-lib's embedJpg ignores it, so a JPEG with an
// orientation other than 1 is re-encoded upright before it is stored.

/** EXIF Orientation (1..8) from a JPEG's APP1 "Exif" segment; 1 when absent, invalid or not a JPEG. */
export function jpegOrientation(b) {
  if (!(b?.length > 4) || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return 1;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; } // markers without a length
    if (m === 0xda || m === 0xd9) return 1; // image data / end: no Exif before it
    const len = (b[i + 2] << 8) | b[i + 3];
    const end = i + 2 + len;
    if (len < 2 || end > b.length) return 1;
    if (m === 0xe1 && len >= 8 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && b[i + 8] === 0 && b[i + 9] === 0) {
      return tiffOrientation(b, i + 10, end);
    }
    i = end;
  }
  return 1;
}

function tiffOrientation(b, t, end) {
  if (t + 8 > end) return 1;
  const le = b[t] === 0x49 && b[t + 1] === 0x49;
  if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return 1;
  const u16 = (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
  const u32 = (p) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
  if (u16(t + 2) !== 42) return 1;
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return 1;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return 1;
    if (u16(e) === 0x0112) {
      const v = u16(e + 2) === 3 ? u16(e + 8) : 1; // SHORT
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}
