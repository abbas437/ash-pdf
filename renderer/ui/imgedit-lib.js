// Geometry for the Edit image tool: PDF user space <-> page space (the viewer's visible space: points,
// origin top-left, y down, /Rotate applied). `g` is { view: [x0, y0, x1, y1], rotate } as pdf.js gives
// them on a PDFPageProxy (page.view, page.rotate). Pure: usable in Node tests.

const rot = (r) => ((r % 360) + 360) % 360;

/** PDF point -> page-space point [x, y]. */
export function pdfToPage({ view: [x0, y0, x1, y1], rotate }, X, Y) {
  switch (rot(rotate)) {
    case 90: return [Y - y0, X - x0];
    case 180: return [x1 - X, Y - y0];
    case 270: return [y1 - Y, x1 - X];
    default: return [X - x0, y1 - Y];
  }
}
/** Page-space point -> PDF point [X, Y] (inverse of pdfToPage). */
export function pageToPdf({ view: [x0, y0, x1, y1], rotate }, x, y) {
  switch (rot(rotate)) {
    case 90: return [x0 + y, y0 + x];
    case 180: return [x1 - x, y0 + y];
    case 270: return [x1 - y, y1 - x];
    default: return [x0 + x, y1 - y];
  }
}
/** Axis-aligned box mapped through a point function: [l, b, r, t] (PDF) <-> {x, y, w, h} (page). */
export function pdfBoxToPage(g, [l, b, r, t]) {
  const pts = [[l, b], [r, t]].map(([X, Y]) => pdfToPage(g, X, Y));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.abs(xs[1] - xs[0]), h: Math.abs(ys[1] - ys[0]) };
}
export function pageBoxToPdf(g, { x, y, w, h }) {
  const pts = [[x, y], [x + w, y + h]].map(([px, py]) => pageToPdf(g, px, py));
  const Xs = pts.map((p) => p[0]), Ys = pts.map((p) => p[1]);
  return [Math.min(...Xs), Math.min(...Ys), Math.max(...Xs), Math.max(...Ys)];
}

/**
 * Page-space box after a gesture: handle 'move' or one of 'nw','n','ne','e','se','s','sw','w', pointer
 * delta (dx, dy) in page space. keepAspect (Shift) scales corner drags uniformly. Minimum size 2 pt.
 */
export function dragBox({ x, y, w, h }, handle, dx, dy, keepAspect = false) {
  if (handle === 'move') return { x: x + dx, y: y + dy, w, h };
  let l = x, t = y, r = x + w, b = y + h;
  if (handle.includes('w')) l += dx;
  if (handle.includes('e')) r += dx;
  if (handle.includes('n')) t += dy;
  if (handle.includes('s')) b += dy;
  if (r - l < 2) { if (handle.includes('w')) l = r - 2; else r = l + 2; }
  if (b - t < 2) { if (handle.includes('n')) t = b - 2; else b = t + 2; }
  if (keepAspect && handle.length === 2) {
    const s = Math.max((r - l) / w, (b - t) / h);
    const nw = w * s, nh = h * s;
    if (handle.includes('w')) l = r - nw; else r = l + nw;
    if (handle.includes('n')) t = b - nh; else b = t + nh;
  }
  return { x: l, y: t, w: r - l, h: b - t };
}
