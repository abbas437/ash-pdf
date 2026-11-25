// Pure matching for "Pick it on the page…" (Remove watermark…): find the object the user picked on one
// page again on the other pages. Objects come from pdfium/wmpick.js pageObjects():
//   { id, type: 'text'|'image'|'path'|'form', bbox: [l, b, r, t], quad: [x1, y1, … x4, y4] | null,
//     text?, fontSize?, pixels?: [w, h], hash?, segments?, kinds?, points?, geomHash?, stroke?, fill?, lineWidth?, drawMode? }
// Rules: same type; text: same mapped text and font size within 1% (text with no Unicode mapping never
// matches, and can't be picked); image: same pixel size and raw-data hash; path: same segment kinds, the
// same points relative to the path's lowest corner within 1% of its size (or the same geometry hash for a
// very long path), the same stroke and fill colours, draw mode and line width; form: same content hash.
// And bounds within min(2% of the page size, 6 pt) on every edge, with width and height within 1%. At most
// one object per picked object per page, and an object is never claimed twice.
export const BOUNDS_TOL = 0.02, BOUNDS_CAP = 6, SIZE_TOL = 0.01, EPS = 0.05;
export const TEXT_UNRELIABLE = "This text can't be matched reliably";
export const MOST_OF_PAGE = 'That object is most of the page — pick the watermark itself';

/** Text with at least one real character (not only spaces, control characters or U+FFFD). */
export const mappedText = (s) => /[^\s\u0000-\u001f\ufffd\ufffe\uffff]/.test(s ?? '');
const near = (a, b, tol = SIZE_TOL) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b)) + EPS;
const sameList = (a, b) => (a == null && b == null) || (a?.length === b?.length && a.every((v, k) => v === b[k]));
/** Path points relative to their lowest x and y. */
function relative(points) {
  let x0 = Infinity, y0 = Infinity;
  for (let k = 0; k < points.length; k += 2) { x0 = Math.min(x0, points[k]); y0 = Math.min(y0, points[k + 1]); }
  return points.map((v, k) => v - (k % 2 ? y0 : x0));
}
/** Same path geometry: kinds, then the hash or every point within 1% of the path's size. */
export function samePath(a, b) {
  if (a.kinds == null || a.kinds !== b.kinds) return false;
  if (a.geomHash != null || b.geomHash != null) return a.geomHash === b.geomHash;
  if (!a.points || a.points.length !== b.points?.length) return false;
  const p = relative(a.points), q = relative(b.points);
  const tol = Math.max(EPS, SIZE_TOL * Math.max(0, ...p));
  return p.every((v, k) => Math.abs(v - q[k]) <= tol);
}

/** Same kind of content (everything but the position). */
export function sameContent(a, b) {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'text': return mappedText(a.text) && a.text === b.text && Math.abs(a.fontSize - b.fontSize) <= SIZE_TOL * Math.max(a.fontSize, b.fontSize);
    case 'image': return a.pixels?.[0] === b.pixels?.[0] && a.pixels?.[1] === b.pixels?.[1] && a.hash === b.hash;
    case 'path': return samePath(a, b) && sameList(a.stroke, b.stroke) && sameList(a.fill, b.fill) && sameList(a.drawMode, b.drawMode)
      && (a.lineWidth == null ? b.lineWidth == null : b.lineWidth != null && near(a.lineWidth, b.lineWidth));
    case 'form': return a.hash === b.hash;
    default: return false;
  }
}
/** Bounds within min(tol of the page size ({ width, height }), 6 pt) on every edge, and the same size within 1%. */
export function boundsNear(a, b, { width, height }, tol = BOUNDS_TOL) {
  const dx = Math.min(tol * width, BOUNDS_CAP), dy = Math.min(tol * height, BOUNDS_CAP);
  return Math.abs(a[0] - b[0]) <= dx && Math.abs(a[2] - b[2]) <= dx && Math.abs(a[1] - b[1]) <= dy && Math.abs(a[3] - b[3]) <= dy
    && near(a[2] - a[0], b[2] - b[0]) && near(a[3] - a[1], b[3] - b[1]);
}
/** Why `o` (on a page of { width, height }) can't be picked, or null when it can. */
export function refusal(o, { width, height }) {
  if (o.type === 'text' && !mappedText(o.text)) return TEXT_UNRELIABLE;
  if (o.type === 'form') { const [l, b, r, t] = o.bbox; if ((r - l) * (t - b) > 0.5 * width * height) return MOST_OF_PAGE; }
  return null;
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

/** Confirm-dialog page list from 0-based indexes: "Pages 1–3, 5, 8" (at most `max` runs, then "…"), or "Page 2". */
export function pageList(indexes, max = 12) {
  const runs = [];
  for (const i of [...indexes].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]);
  }
  const text = runs.slice(0, max).map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}–${b + 1}`)).join(', ') + (runs.length > max ? ', …' : '');
  return `${indexes.length === 1 ? 'Page' : 'Pages'} ${text}`;
}

/** Confirm-dialog line: "Found on N of M pages (K objects)". */
export function summary({ pages, objects }, total) {
  const k = `${objects} object${objects === 1 ? '' : 's'}`;
  return pages.length <= 1 ? `Found only on this page (${k})` : `Found on ${pages.length} of ${total} pages (${k})`;
}
