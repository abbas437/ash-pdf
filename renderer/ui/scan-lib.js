// Pure "does this look like a scanned document" heuristic for the OCR prompt (no DOM, no pdf.js import).
//   imageCoverage(fnArray, argsArray, OPS, view) -> fraction (0..1) of the page box covered by painted images
//   looksScanned(pages) -> true when every sampled page has no text and images covering most of it
// `pages` are {textItems, coverage}: the number of non-blank text items and the image coverage of a page.

export const COVER_MIN = 0.6;   // "most of the page"
export const SAMPLE_PAGES = 3;

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

/** Image coverage of `view` ([x0,y0,x1,y1]) from a pdf.js operator list: bounding boxes of the painted unit squares, clipped, merged by area. */
export function imageCoverage(fnArray, argsArray, OPS, view) {
  const painters = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter((x) => x != null));
  const [vx0, vy0, vx1, vy1] = [Math.min(view[0], view[2]), Math.min(view[1], view[3]), Math.max(view[0], view[2]), Math.max(view[1], view[3])];
  const area = (vx1 - vx0) * (vy1 - vy0);
  if (!(area > 0)) return 0;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rects = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, argsArray[i]);
    else if (painters.has(fn)) {
      const xs = [], ys = [];
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { xs.push(ctm[0] * u + ctm[2] * v + ctm[4]); ys.push(ctm[1] * u + ctm[3] * v + ctm[5]); }
      const r = [Math.max(vx0, Math.min(...xs)), Math.max(vy0, Math.min(...ys)), Math.min(vx1, Math.max(...xs)), Math.min(vy1, Math.max(...ys))];
      if (r[2] > r[0] && r[3] > r[1]) rects.push(r);
    }
  }
  return Math.min(1, unionArea(rects) / area);
}

/** Area of a union of axis-aligned rectangles (coordinate compression; pages hold few images). */
function unionArea(rects) {
  if (!rects.length) return 0;
  const xs = [...new Set(rects.flatMap((r) => [r[0], r[2]]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const spans = rects.filter((r) => r[0] <= xs[i] && r[2] >= xs[i + 1]).map((r) => [r[1], r[3]]).sort((a, b) => a[0] - b[0]);
    let covered = 0, end = -Infinity;
    for (const [a, b] of spans) { if (b > end) { covered += b - Math.max(a, end); end = b; } }
    total += covered * (xs[i + 1] - xs[i]);
  }
  return total;
}

/** True when the sampled pages (the first SAMPLE_PAGES) all have no text and images over most of the page. */
export function looksScanned(pages) {
  const sample = pages.slice(0, SAMPLE_PAGES);
  return sample.length > 0 && sample.every((p) => p.textItems === 0 && p.coverage >= COVER_MIN);
}
