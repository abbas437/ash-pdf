// Pure matching for "Pick it on the page…" (Remove watermark…): find the object the user picked on one
// page again on the other pages. Objects come from pdfium/wmpick.js pageObjects():
//   { id, type: 'text'|'image'|'path'|'form', bbox: [l, b, r, t], quad: [x1, y1, … x4, y4] | null,
//     text?, fontSize?, pixels?: [w, h], hash?, segments? }   (PDF user space)
// Rules: same type; text: same text and font size within 1%; image: same pixel size and raw-data hash;
// path: same segment count; form: same content hash; and bounds within 2% of the page size. At most one
// object per picked object per page, and an object is never claimed twice.
export const BOUNDS_TOL = 0.02, SIZE_TOL = 0.01;

/** Same kind of content (everything but the position). */
export function sameContent(a, b) {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'text': return a.text === b.text && Math.abs(a.fontSize - b.fontSize) <= SIZE_TOL * Math.max(a.fontSize, b.fontSize);
    case 'image': return a.pixels?.[0] === b.pixels?.[0] && a.pixels?.[1] === b.pixels?.[1] && a.hash === b.hash;
    case 'path': return a.segments === b.segments;
    case 'form': return a.hash === b.hash;
    default: return false;
  }
}
/** Bounds within tol of the page size ({ width, height }) on every edge. */
export function boundsNear(a, b, { width, height }, tol = BOUNDS_TOL) {
  const dx = tol * width, dy = tol * height;
  return Math.abs(a[0] - b[0]) <= dx && Math.abs(a[2] - b[2]) <= dx && Math.abs(a[1] - b[1]) <= dy && Math.abs(a[3] - b[3]) <= dy;
}
const dist = (a, b) => a.reduce((s, v, k) => s + Math.abs(v - b[k]), 0);

/**
 * picked: objects chosen on one page; pages: [{ pageIndex, width, height, objects }].
 * Returns { pages: [{ pageIndex, ids }] (pages with a match), objects: total matched }.
 */
export function findMatches(picked, pages) {
  const out = [];
  for (const p of pages) {
    const used = new Set(), ids = [];
    for (const want of picked) {
      let best = null;
      for (const o of p.objects) {
        if (used.has(o.id) || !sameContent(want, o) || !boundsNear(want.bbox, o.bbox, p)) continue;
        if (!best || dist(o.bbox, want.bbox) < dist(best.bbox, want.bbox)) best = o;
      }
      if (best) { used.add(best.id); ids.push(best.id); }
    }
    if (ids.length) out.push({ pageIndex: p.pageIndex, ids });
  }
  return { pages: out, objects: out.reduce((s, p) => s + p.ids.length, 0) };
}

/** Point (x, y) inside the convex quad [x1, y1, … x4, y4] (either winding). */
function inQuad(q, x, y) {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const [ax, ay, bx, by] = [q[2 * k], q[2 * k + 1], q[(2 * k + 2) % 8], q[(2 * k + 3) % 8]];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c && sign && Math.sign(c) !== sign) return false;
    if (c) sign = Math.sign(c);
  }
  return true;
}
/** Topmost object (last drawn) under the PDF point (x, y): its rotated quad, else its bounds. */
export function objectAt(objects, x, y) {
  for (let k = objects.length - 1; k >= 0; k--) {
    const o = objects[k], [l, b, r, t] = o.bbox;
    if (x < l || x > r || y < b || y > t) continue;
    if (!o.quad || inQuad(o.quad, x, y)) return o;
  }
  return null;
}

/** Confirm-dialog line: "Found on N of M pages (K objects)". */
export function summary({ pages, objects }, total) {
  const k = `${objects} object${objects === 1 ? '' : 's'}`;
  return pages.length <= 1 ? `Found only on this page (${k})` : `Found on ${pages.length} of ${total} pages (${k})`;
}
