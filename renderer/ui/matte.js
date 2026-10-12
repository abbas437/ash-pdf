// Recover RGBA from one drawing composited on white (W) and on black (B) (RGBA byte arrays of equal size):
// alpha = 1 - max channel difference (W - B), colour = B / alpha. Used for appearances pdf.js cannot draw onto a
// transparent canvas faithfully (soft-masked images inside transparency groups come out black).
export function apMatte(W, B) {
  const o = new Uint8ClampedArray(W.length);
  for (let i = 0; i < W.length; i += 4) {
    const a = 255 - Math.max(W[i] - B[i], W[i + 1] - B[i + 1], W[i + 2] - B[i + 2], 0);
    o[i + 3] = a;
    if (a > 0) for (let k = 0; k < 3; k++) o[i + k] = Math.round((B[i + k] * 255) / a);
  }
  return o;
}
