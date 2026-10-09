// Crop pages: pure geometry and page choice for the Crop dialog and its "Draw on page" box.
// Rectangles are {x0, y0, x1, y1} in points on the page as displayed (top-left origin, y down,
// /Rotate applied), the same space as viewer.clientToPage and pdfOps.cropPagesToRect.

export const MM = 72 / 25.4;
export const unitFactor = (unit) => (unit === 'mm' ? MM : 1);
export const MIN_SIZE = 1; // points

/** Margins (points) on a page of `size` -> the box they leave. */
export function marginsToRect({ top = 0, right = 0, bottom = 0, left = 0 }, { width, height }) {
  return { x0: left, y0: top, x1: width - right, y1: height - bottom };
}

/** Box on a page of `size` -> the margins (points) that leave it. */
export function rectToMargins({ x0, y0, x1, y1 }, { width, height }) {
  return { top: y0, right: width - x1, bottom: height - y1, left: x0 };
}

/** Box intersected with the page; null when less than MIN_SIZE is left either way. */
export function clampRect({ x0, y0, x1, y1 }, { width, height }) {
  const r = { x0: Math.max(0, Math.min(x0, x1)), y0: Math.max(0, Math.min(y0, y1)), x1: Math.min(width, Math.max(x0, x1)), y1: Math.min(height, Math.max(y0, y1)) };
  return r.x1 - r.x0 < MIN_SIZE || r.y1 - r.y0 < MIN_SIZE ? null : r;
}

/**
 * Box a page of `size` keeps: a drawn `rect` is placed at the same position and clamped to the page;
 * typed `margins` are trimmed from the page's own edges. null when less than MIN_SIZE is left.
 */
export function cropBoxFor(size, { rect = null, margins = null }) {
  if (rect) return clampRect(rect, size);
  const r = marginsToRect(margins, size);
  return r.x1 - r.x0 < MIN_SIZE || r.y1 - r.y0 < MIN_SIZE ? null : r;
}

/** True when the pages' sizes ({width, height}) are not all the same (to 0.5 pt). */
export function sizesDiffer(sizes) {
  return sizes.some((s) => Math.abs(s.width - sizes[0].width) > 0.5 || Math.abs(s.height - sizes[0].height) > 0.5);
}

/** Box from two corner points, clamped to the page (not to MIN_SIZE). */
export function rectFromPoints(a, b, { width, height }) {
  const cx = (v) => Math.max(0, Math.min(width, v)), cy = (v) => Math.max(0, Math.min(height, v));
  return { x0: cx(Math.min(a.x, b.x)), y0: cy(Math.min(a.y, b.y)), x1: cx(Math.max(a.x, b.x)), y1: cy(Math.max(a.y, b.y)) };
}

/**
 * Drag a handle ('n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw') of `start` by (dx, dy), or 'move' the
 * whole box; kept inside the page and at least MIN_SIZE across.
 */
export function dragRect(start, handle, dx, dy, { width, height }) {
  let { x0, y0, x1, y1 } = start;
  if (handle === 'move') {
    const mx = Math.max(-x0, Math.min(width - x1, dx)), my = Math.max(-y0, Math.min(height - y1, dy));
    return { x0: x0 + mx, y0: y0 + my, x1: x1 + mx, y1: y1 + my };
  }
  if (handle.includes('w')) x0 = Math.max(0, Math.min(x1 - MIN_SIZE, x0 + dx));
  if (handle.includes('e')) x1 = Math.min(width, Math.max(x0 + MIN_SIZE, x1 + dx));
  if (handle.includes('n')) y0 = Math.max(0, Math.min(y1 - MIN_SIZE, y0 + dy));
  if (handle.includes('s')) y1 = Math.min(height, Math.max(y0 + MIN_SIZE, y1 + dy));
  return { x0, y0, x1, y1 };
}

/**
 * Pages the crop applies to (0-based, sorted). mode: 'current' | 'selected' | 'range' | 'odd' |
 * 'even' | 'all'; odd/even count from page 1. `parseRanges` is pdfOps.parseRanges (throws RangeError).
 */
export function pickPages(mode, { n, current = 0, selected = [], spec = '' }, parseRanges) {
  const all = Array.from({ length: n }, (_, i) => i);
  switch (mode) {
    case 'all': return all;
    case 'odd': return all.filter((i) => i % 2 === 0);
    case 'even': return all.filter((i) => i % 2 === 1);
    case 'selected': return [...selected].sort((a, b) => a - b);
    case 'range': return parseRanges(spec, n);
    default: return [current];
  }
}

/** "123.4 × 56.7 mm" for a box. */
export function sizeLabel({ x0, y0, x1, y1 }, unit) {
  const f = unitFactor(unit);
  return `${((x1 - x0) / f).toFixed(1)} × ${((y1 - y0) / f).toFixed(1)} ${unit}`;
}

// ---- Remove white margins: content box of a rendered page.
export const WHITE = 245; // a pixel is ink when any channel is below this
export const PAD_MM = 2;

/**
 * Bounding box {x0, y0, x1, y1} (pixels, x1 / y1 exclusive) of the ink in an RGBA bitmap
 * (`data` of `width` x `height`); null for a blank page. A pixel is ink when any channel is below
 * `white` (alpha ignored: render on white). Isolated specks are ignored: an ink pixel counts only
 * when one of its 8 neighbours is ink too.
 */
export function inkBox(data, width, height, { white = WHITE } = {}) {
  const ink = new Uint8Array(width * height);
  for (let p = 0, q = 0; q < ink.length; p += 4, q++) ink[q] = data[p] < white || data[p + 1] < white || data[p + 2] < white ? 1 : 0;
  const hasNeighbour = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((dx || dy) && xx >= 0 && xx < width && ink[yy * width + xx]) return true;
      }
    }
    return false;
  };
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!ink[y * width + x] || !hasNeighbour(x, y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * Margins (points) that trim a page of `size` (points, as displayed) to the ink box `box` of its
 * rendering `pxWidth` x `pxHeight` pixels, padded by `pad` points and kept on the page; null when
 * there is no ink.
 */
export function inkMargins(box, pxWidth, pxHeight, size, pad = PAD_MM * MM) {
  if (!box) return null;
  const sx = size.width / pxWidth, sy = size.height / pxHeight;
  const r = {
    x0: Math.max(0, box.x0 * sx - pad), y0: Math.max(0, box.y0 * sy - pad),
    x1: Math.min(size.width, box.x1 * sx + pad), y1: Math.min(size.height, box.y1 * sy + pad),
  };
  return rectToMargins(r, size);
}
